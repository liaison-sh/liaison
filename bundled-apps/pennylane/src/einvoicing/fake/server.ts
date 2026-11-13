// SPDX-License-Identifier: FSL-1.1-ALv2
//
// In-memory Pennylane v2 for tests. It implements only what the sandbox probes proved
// (research notes, 2026-10-15) and answers with the recorded shapes and error bodies:
//   customers: external_reference / reg_no filters, unique external_reference (422), EBA list
//     from a directory, EBA must be listed (422), reg_no change clears it;
//   e-invoice import (multipart): 201 {id,url}, validation valid/invalid, 409 on the same bytes
//     with the existing id, 422 when the file is not an e-invoice;
//   customer_invoices list filters: invoice_number, date, external_reference (anything else 400);
//   update_imported (external_reference); send_to_pa (fake only: 204, 409 while not validated,
//     422 once transmitted); bookings: file_attachments + import (vat_rate enum 400, unique
//     external_reference 422, same attachment 409); pa_registrations; webhook subscriptions;
//   rate-limit headers on every answer (reset = absolute epoch seconds), 429 on demand;
//   reception (fake-only: the sandbox has no PA-received invoice): supplier invoices with an
//   e_invoicing block, `electronic_billing_address eq` / `id gt` filters sorted by id (`-id` newest first), suppliers,
//   `PUT e_invoice_status` with the documented reasons and transitions; the file hops as probed:
//   app.pennylane.com 302 → presigned storage host, which answers 400 to a request carrying a
//   bearer; supplier invoice import (file attachment 409 when reused).
// Two transports: `sandboxFetch` (the shape of ctx.fetch, multipart as named parts resolved
// through `files`) and `httpFetch` (a fetch implementation for the kernel egress override,
// parsing the real multipart body and describing the file through `describeBytes`).

import { createHash } from "node:crypto"
import { PENNYLANE_FILE_HOSTS, STORAGE_HOST } from "../../received/hosts"
import { ciiFacts } from "../eligibility"
import { RECORDED } from "./recorded"

/** The token the fake host adds for a request whose `auth` names the connection. */
export const FAKE_CONNECTION_TOKEN = "tok-secret"

export interface FakeFileMeta {
  sha256: string
  /** null = not an e-invoice (plain PDF). */
  invoice_number: string | null
  date: string | null
  buyer_siren: string | null
  /** Schematron outcome Pennylane would reach. */
  valid: boolean
  /** The exact embedded factur-x.xml, when a test pins it; otherwise its facts above stand for it. */
  embedded_xml?: string
  /** The kernel file parent the file is stored under (what a part's `refuseParents` checks). */
  parent?: { app: string; entityType: string }
}

type Json = Record<string, any>
interface Answer {
  status: number
  body: unknown
  headers?: Record<string, string>
}

const VAT_ENUM = new Set(
  /enum: ([^"]*)\./
    .exec((RECORDED.errorVatRateEnum.body as { message: string }).message)![1]!
    .split(","),
)

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export interface FakeCall {
  method: string
  path: string
  json?: unknown
  parts?: Array<{ name: string; value?: string; sha256?: string }>
}

export class PennylaneFake {
  emission = true
  /** SIREN → electronic billing addresses listed by the directory. */
  directory: Record<string, string[]> = {}
  directoryDown = false
  readonly files = new Map<string, FakeFileMeta>()
  /** Integration transport: describe uploaded bytes (e.g. parse the embedded CII). */
  describeBytes: ((bytes: Uint8Array) => FakeFileMeta | null) | null = null
  readonly customers = new Map<number, Json>()
  readonly invoices = new Map<number, Json>()
  readonly attachments = new Map<number, { sha256: string; used: boolean }>()
  readonly subscriptions = new Map<number, Json>()
  readonly suppliers = new Map<number, Json>()
  readonly supplierInvoices = new Map<number, Json>()
  /** Stored file bytes by blob key (served through the redirect hops). */
  readonly blobs = new Map<string, { bytes: Uint8Array; mime: string }>()
  /** Every request reaching a file hop, with the Authorization header it carried. */
  readonly downloads: Array<{ url: string; host: string; authorization: string | null }> = []
  /** Override where the API host's file URL redirects to, by blob key (tests a hostile hop). */
  readonly redirects = new Map<string, string>()
  /** PA registrations (`/pa_registrations` items). */
  registrations: Array<{ siren: string; status: string; exchange_direction: string }> = []
  readonly calls: FakeCall[] = []
  /** Request budget the fake reports; at 0 every call answers 429 (tests set it). */
  remaining = 25
  /** Answer the next matching request with this instead (after optionally performing it). */
  private faults: Array<{
    match: (c: FakeCall) => boolean
    mode: "replace" | "after"
    answer?: Answer
    error?: Error
  }> = []
  private seq = 1_000_000
  private now = () => Date.now()

  /** Count of provider-side creates of one kind (the S15 "exactly one" assertion). */
  creates(kind: "customer" | "einvoice_import" | "send_to_pa" | "booking" | "attachment"): number {
    const re = {
      customer: /^POST \/customers$/,
      einvoice_import: /^POST \/customer_invoices\/e_invoices\/imports$/,
      send_to_pa: /^POST \/customer_invoices\/\d+\/send_to_pa$/,
      booking: /^POST \/customer_invoices\/import$/,
      attachment: /^POST \/file_attachments$/,
    }[kind]
    return this.calls.filter((c) => re.test(`${c.method} ${c.path.split("?")[0]}`)).length
  }

  /** The id-bearing objects actually created (not attempts). */
  createdInvoices(kind: "einvoice" | "booking"): Json[] {
    return [...this.invoices.values()].filter((i) =>
      kind === "einvoice" ? i.factur_x === true : i.factur_x === false,
    )
  }

  /** Fault injection: `replace` answers instead of acting; `after` acts, then fails the call
   *  (the crash window: the create happened, the caller never saw its id). */
  fail(
    match: (c: FakeCall) => boolean,
    mode: "replace" | "after",
    answer?: Answer,
    error?: Error,
  ): void {
    this.faults.push({ match, mode, answer, error })
  }

  /** A supplier e-invoice arrives through the PA (as Pennylane would list it). */
  receive(
    o: {
      supplier?: string
      supplierSiren?: string | null
      supplierVat?: string | null
      number?: string
      date?: string
      deadline?: string
      currency?: string
      total?: string
      tax?: string
      original?: Uint8Array
      originalName?: string
      rendering?: Uint8Array
      routing?: string
      paid?: boolean
      status?: string | null
    } = {},
  ): number {
    const name = o.supplier ?? "Fournisseur Exemple"
    let sup = [...this.suppliers.values()].find((x) => x.name === name)
    if (!sup) {
      sup = {
        ...clone(RECORDED.supplier.body as Json),
        id: this.id(),
        name,
        reg_no: o.supplierSiren ?? "",
        vat_number: o.supplierVat ?? "",
      }
      this.suppliers.set(sup.id, sup)
    }
    const id = this.id()
    const number = o.number ?? `FS-${id}`
    const original =
      o.original ??
      new TextEncoder().encode(`<?xml version="1.0"?><Invoice><ID>${number}</ID></Invoice>`)
    const originalName = o.originalName ?? `${number}.xml`
    const oKey = `blob${id}o`
    const rKey = `blob${id}r`
    this.blobs.set(oKey, {
      bytes: original,
      mime: originalName.endsWith(".pdf") ? "application/pdf" : "application/xml",
    })
    this.blobs.set(rKey, {
      bytes: o.rendering ?? new TextEncoder().encode(`%PDF-1.4 rendering of ${number}`),
      mime: "application/pdf",
    })
    const total = o.total ?? "120.0"
    const tax = o.tax ?? "20.0"
    const before = (Number(total) - Number(tax)).toFixed(1)
    const inv: Json = {
      ...clone(RECORDED.supplierInvoiceImported.body as Json),
      id,
      invoice_number: number,
      date: o.date ?? "2026-11-03",
      deadline: o.deadline ?? "2026-12-03",
      currency: o.currency ?? "EUR",
      amount: total,
      currency_amount: total,
      currency_amount_before_tax: before,
      currency_tax: tax,
      tax,
      paid: o.paid === true,
      payment_status: o.paid === true ? "paid" : "to_be_processed",
      created_at: new Date(this.now()).toISOString(),
      updated_at: new Date(this.now()).toISOString(),
      external_reference: `AUTO${id}`,
      filename: `${number}.pdf`,
      supplier: {
        id: sup.id,
        url: `https://app.pennylane.com/api/external/v2/suppliers/${sup.id}`,
      },
      public_file_url: `https://app.pennylane.com/public/invoice/pdf?encrypted_id=${rKey}`,
      e_invoicing: {
        status: o.status === undefined ? null : o.status,
        reason: null,
        flow: { id: `flow-r-${id}` },
        electronic_billing_address: o.routing ?? this.registrations[0]?.siren ?? "000000000",
        source_file_url: `https://app.pennylane.com/rails/active_storage/blobs/redirect/${oKey}/${originalName}`,
      },
    }
    this.supplierInvoices.set(id, inv)
    return id
  }

  /** sha256 of a received invoice's original bytes. */
  originalSha256(id: number): string {
    const blob = this.blobs.get(`blob${id}o`)
    return blob ? createHash("sha256").update(blob.bytes).digest("hex") : ""
  }

  /** The file hops (outside /api/external/v2): app host 302 → presigned storage URL → bytes. */
  serveFile(url: string, authorization: string | null): Response {
    const u = new URL(url)
    this.downloads.push({ url, host: u.hostname, authorization })
    if (u.hostname === STORAGE_HOST) {
      // Recorded: the presigned storage URL refuses a request carrying a bearer.
      if (authorization)
        return new Response("<Error><Code>InvalidArgument</Code></Error>", { status: 400 })
      if (!u.searchParams.get("X-Amz-Signature")) return new Response("Forbidden", { status: 403 })
      const blob = this.blobs.get(u.pathname.slice(1))
      return blob
        ? new Response(blob.bytes as unknown as ConstructorParameters<typeof Response>[0], {
            status: 200,
            headers: { "content-type": blob.mime, "content-length": String(blob.bytes.byteLength) },
          })
        : new Response("NoSuchKey", { status: 404 })
    }
    const m = /^\/rails\/active_storage\/blobs\/redirect\/([^/]+)\//.exec(u.pathname)
    const key =
      m?.[1] ?? (u.pathname === "/public/invoice/pdf" ? u.searchParams.get("encrypted_id") : null)
    if (!key || !this.blobs.has(key)) return new Response("Not found", { status: 404 })
    const location =
      this.redirects.get(key) ??
      `https://${STORAGE_HOST}/${key}?X-Amz-Expires=300&X-Amz-Signature=fake${key}`
    return new Response(null, { status: 302, headers: { location } })
  }

  /**
   * Unit-test stand-in for the kernel's `files_importFromUrl` in first-hop-only mode: the
   * headers go to the first request only, redirects are followed bare, each hop's host must be
   * one of the app's exact hosts. Answers like the kernel (plus the sha256 it computes).
   */
  readonly importFromUrl = async (argsJson: string): Promise<string> => {
    const p = JSON.parse(argsJson) as {
      url: string
      headers?: Record<string, string>
      auth?: { connection?: string; scheme?: string; fields?: string[] }
      credentials?: string
      filename?: string
      targetApp?: string
      targetEntityType?: string
      targetEntityId?: string
    }
    if (p.credentials !== "first-hop-only")
      throw new Error("fake: expected credentials first-hop-only")
    this.lastImport = p
    let url = p.url
    // The host's part: `auth` names the connection's token, added to the first hop as the
    // bridge adds it (the app never holds it).
    let auth: string | null =
      p.headers?.Authorization ??
      p.headers?.authorization ??
      (p.auth ? `Bearer ${FAKE_CONNECTION_TOKEN}` : null)
    for (let hop = 0; hop < 5; hop++) {
      const host = new URL(url).hostname
      if (!(PENNYLANE_FILE_HOSTS as readonly string[]).includes(host))
        throw new Error(`Domain not in allowlist (exact host required): ${host}`)
      const res = this.serveFile(url, auth)
      if (res.status === 302) {
        url = new URL(res.headers.get("location")!, url).toString()
        auth = null
        continue
      }
      if (!res.ok) throw new Error(`import_fetch_failed: upstream returned ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      const id = `00000000-0000-4000-9000-${String(++this.fileSeq).padStart(12, "0")}`
      return JSON.stringify({
        id,
        filename: p.filename,
        mimeType: res.headers.get("content-type"),
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })
    }
    throw new Error("Too many redirects")
  }
  lastImport: Record<string, unknown> | null = null
  private fileSeq = 0

  /** Simulate the PA lifecycle on a transmitted invoice. */
  setEinvoicingStatus(id: number, status: string, reason: string | null = null): void {
    const inv = this.invoices.get(id)
    if (!inv) throw new Error(`no invoice ${id}`)
    inv.e_invoicing = { ...(inv.e_invoicing ?? { flow: { id: `flow-${id}` } }), status, reason }
    inv.updated_at = new Date(this.now()).toISOString()
  }

  // -------------------------------------------------------------------------------------------
  private rate(): Record<string, string> {
    return {
      "ratelimit-limit": "25",
      "ratelimit-remaining": String(Math.max(this.remaining, 0)),
      "ratelimit-reset": String(Math.ceil(this.now() / 1000) + 5),
      "content-type": "application/json; charset=utf-8",
    }
  }

  private id(): number {
    this.seq += 1
    return this.seq
  }

  private filterItems(list: Json[], query: string): Answer | Json[] {
    const raw = new URLSearchParams(query).get("filter")
    if (!raw) return list
    const filters = JSON.parse(raw) as Array<{ field: string; operator: string; value: unknown }>
    for (const f of filters) {
      if (
        f.operator !== "eq" ||
        !["invoice_number", "date", "external_reference", "reg_no"].includes(f.field)
      ) {
        return {
          status: 400,
          body: {
            message: `filter ${f.field} ${f.operator} not supported by this fake (unproven)`,
          },
        }
      }
      list = list.filter((x) => String(x[f.field] ?? "") === String(f.value))
    }
    return list
  }

  private page(items: Json[]): Answer {
    return { status: 200, body: { items, has_more: false, next_cursor: null } }
  }

  private customerFrom(body: Json, id: number): Json {
    const tpl = clone(
      body.customer_type === "individual"
        ? RECORDED.customerIndividual.body
        : RECORDED.customerCompany.body,
    ) as Json
    const name =
      body.customer_type === "individual" ? `${body.first_name} ${body.last_name}` : body.name
    return {
      ...tpl,
      id,
      name,
      customer_type: body.customer_type,
      reg_no: body.reg_no ?? null,
      vat_number: body.vat_number ?? null,
      external_reference: body.external_reference ?? null,
      electronic_billing_address: null,
      billing_address: body.billing_address,
      ...(body.customer_type === "individual"
        ? { first_name: body.first_name, last_name: body.last_name }
        : {}),
    }
  }

  private invoiceFrom(fields: Json): Json {
    const tpl = clone(
      fields.factur_x ? RECORDED.einvoiceValid.body : RECORDED.bookingCreated.body,
    ) as Json
    const id = this.id()
    return { ...tpl, id, ...fields, updated_at: new Date(this.now()).toISOString() }
  }

  /** The routing core: one request in, one answer out. */
  handle(
    method: string,
    pathWithQuery: string,
    json?: Json,
    parts?: Array<{ name: string; value?: string; meta?: FakeFileMeta | null }>,
  ): Answer {
    const [path, query = ""] = pathWithQuery.split("?") as [string, string?]
    const M = method.toUpperCase()
    let m: RegExpExecArray | null

    if (M === "GET" && path === "/pa_registrations") {
      return {
        status: 200,
        body: {
          items: clone(this.registrations),
          emission_activated: this.emission,
          has_more: false,
          next_cursor: null,
        },
      }
    }
    // --- customers
    if (M === "GET" && path === "/customers") {
      const r = this.filterItems([...this.customers.values()], query)
      return Array.isArray(r) ? this.page(r) : r
    }
    if (M === "POST" && path === "/customers") {
      const body = json ?? {}
      if (
        body.external_reference &&
        [...this.customers.values()].some((c) => c.external_reference === body.external_reference)
      ) {
        return { status: 422, body: clone(RECORDED.errorExternalReferenceTaken.body) }
      }
      const c = this.customerFrom(body, this.id())
      this.customers.set(c.id, c)
      return { status: 201, body: c }
    }
    if ((m = /^\/customers\/(\d+)\/electronic_billing_addresses$/.exec(path)) && M === "GET") {
      if (this.directoryDown)
        return { status: 503, body: { status: 503, error: "Directory unavailable" } }
      const c = this.customers.get(Number(m[1]))
      if (!c) return { status: 404, body: { status: 404, error: "Not found" } }
      return this.page(
        (this.directory[c.reg_no] ?? []).map((a) => ({ electronic_billing_address: a })),
      )
    }
    if ((m = /^\/customers\/(\d+)$/.exec(path)) && M === "PUT") {
      const c = this.customers.get(Number(m[1]))
      if (!c) return { status: 404, body: { status: 404, error: "Not found" } }
      const body = json ?? {}
      if ("electronic_billing_address" in body) {
        if (!(this.directory[c.reg_no] ?? []).includes(body.electronic_billing_address)) {
          return { status: 422, body: clone(RECORDED.errorEbaNotEligible.body) }
        }
        c.electronic_billing_address = body.electronic_billing_address
      }
      for (const k of ["name", "vat_number", "billing_address"]) if (k in body) c[k] = body[k]
      if (
        ("reg_no" in body && body.reg_no !== c.reg_no) ||
        ("customer_type" in body && body.customer_type !== c.customer_type)
      ) {
        c.electronic_billing_address = null // Pennylane clears it on either change
        if ("reg_no" in body) c.reg_no = body.reg_no
        if ("customer_type" in body) c.customer_type = body.customer_type
      }
      return { status: 200, body: c }
    }
    // --- e-invoice import
    if (M === "POST" && path === "/customer_invoices/e_invoices/imports") {
      const file = parts?.find((p) => p.name === "file")
      const meta = file?.meta ?? null
      if (!meta || !meta.invoice_number)
        return { status: 422, body: clone(RECORDED.errorNotAnEinvoice.body) }
      const dup = [...this.invoices.values()].find((i) => i._sha256 === meta.sha256)
      if (dup)
        return {
          status: 409,
          body: {
            status: 409,
            error: `A document with ID ${dup.id} already exists with such attachment.`,
          },
        }
      const opt = parts?.find((p) => p.name === "invoice_options[customer_id]")?.value
      let customerId = opt ? Number(opt) : null
      if (!customerId) {
        const bySiren = [...this.customers.values()].find((c) => c.reg_no === meta.buyer_siren)
        if (bySiren) customerId = bySiren.id
        else {
          const c = this.customerFrom(
            { customer_type: "company", name: "Imported customer", reg_no: meta.buyer_siren },
            this.id(),
          )
          this.customers.set(c.id, c)
          customerId = c.id
        }
      }
      const inv = this.invoiceFrom({
        factur_x: true,
        invoice_number: meta.invoice_number,
        date: meta.date,
        deadline: meta.date,
        schematron_validation_status: meta.valid ? "valid" : "invalid",
        e_invoicing: null,
        status: "incomplete",
        external_reference: `AUTO${this.seq}`,
        customer: {
          id: customerId,
          url: `https://app.pennylane.com/api/external/v2/customers/${customerId}`,
        },
        _sha256: meta.sha256,
        _send_to_pa: parts?.find((p) => p.name === "send_to_pa")?.value ?? null,
      })
      this.invoices.set(inv.id, inv)
      return {
        status: 201,
        body: {
          id: inv.id,
          url: `https://app.pennylane.com/api/external/v2/customer_invoices/${inv.id}`,
        },
      }
    }
    // --- customer invoices
    if (M === "GET" && path === "/customer_invoices") {
      const r = this.filterItems([...this.invoices.values()], query)
      return Array.isArray(r) ? this.page(r.map(publicInvoice)) : r
    }
    if ((m = /^\/customer_invoices\/(\d+)$/.exec(path)) && M === "GET") {
      const inv = this.invoices.get(Number(m[1]))
      return inv
        ? { status: 200, body: publicInvoice(inv) }
        : { status: 404, body: { status: 404, error: "Not found" } }
    }
    if ((m = /^\/customer_invoices\/(\d+)\/update_imported$/.exec(path)) && M === "PUT") {
      const inv = this.invoices.get(Number(m[1]))
      if (!inv) return { status: 404, body: { status: 404, error: "Not found" } }
      if (json && "external_reference" in json) inv.external_reference = json.external_reference
      return { status: 200, body: publicInvoice(inv) }
    }
    if ((m = /^\/customer_invoices\/(\d+)\/send_to_pa$/.exec(path)) && M === "POST") {
      const inv = this.invoices.get(Number(m[1]))
      if (!inv) return { status: 404, body: { status: 404, error: "Not found" } }
      if (inv.e_invoicing)
        return { status: 422, body: { status: 422, error: "Invoice already sent to PA" } }
      if (inv.schematron_validation_status !== "valid")
        return { status: 409, body: { status: 409, error: "Import still processing" } }
      if (!this.emission)
        return {
          status: 422,
          body: { status: 422, error: "E-invoicing emission is not activated" },
        }
      inv.e_invoicing = {
        status: "submitted",
        reason: null,
        flow: { id: `flow-${inv.id}` },
        lifecycle_events: null,
      }
      inv.updated_at = new Date(this.now()).toISOString()
      return { status: 204, body: "" }
    }
    // --- bookings
    if (M === "POST" && path === "/file_attachments") {
      const file = parts?.find((p) => p.name === "file")
      const id = this.id()
      this.attachments.set(id, { sha256: file?.meta?.sha256 ?? "", used: false })
      return { status: 201, body: { ...clone(RECORDED.fileAttachmentCreated.body as Json), id } }
    }
    if (M === "POST" && path === "/customer_invoices/import") {
      const body = json ?? {}
      for (const l of (body.invoice_lines ?? []) as Json[]) {
        if (!VAT_ENUM.has(l.vat_rate)) {
          const tpl = clone(RECORDED.errorVatRateEnum.body as Json)
          return {
            status: 400,
            body: {
              ...tpl,
              message: String(tpl.message).replace("NOT_A_RATE", String(l.vat_rate)),
              payload: JSON.stringify(l.vat_rate),
            },
          }
        }
      }
      const att = this.attachments.get(Number(body.file_attachment_id))
      if (!att) return { status: 422, body: { status: 422, error: "File attachment not found" } }
      if (att.used) {
        const owner = [...this.invoices.values()].find(
          (i) => i._attachment === Number(body.file_attachment_id),
        )
        return {
          status: 409,
          body: {
            status: 409,
            error: `A document with ID ${owner?.id} already exists with such attachment.`,
          },
        }
      }
      if (
        body.external_reference &&
        [...this.invoices.values()].some((i) => i.external_reference === body.external_reference)
      ) {
        return { status: 422, body: clone(RECORDED.errorBookingExternalReferenceTaken.body) }
      }
      att.used = true
      const inv = this.invoiceFrom({
        factur_x: false,
        schematron_validation_status: null,
        e_invoicing: null,
        status: "upcoming",
        invoice_number: body.invoice_number ?? null,
        date: body.date,
        deadline: body.deadline,
        currency: body.currency ?? "EUR",
        currency_amount: body.currency_amount,
        currency_amount_before_tax: body.currency_amount_before_tax,
        currency_tax: body.currency_tax,
        amount: body.amount ?? body.currency_amount,
        tax: body.tax ?? body.currency_tax,
        external_reference: body.external_reference ?? null,
        customer: {
          id: body.customer_id,
          url: `https://app.pennylane.com/api/external/v2/customers/${body.customer_id}`,
        },
        _attachment: Number(body.file_attachment_id),
        _lines: body.invoice_lines,
      })
      this.invoices.set(inv.id, inv)
      return { status: 201, body: publicInvoice(inv) }
    }
    // --- reception: supplier invoices, suppliers, e_invoice_status; supplier import
    if (M === "GET" && path === "/supplier_invoices") {
      const params = new URLSearchParams(query)
      let list = [...this.supplierInvoices.values()]
      const raw = params.get("filter")
      for (const f of (raw ? JSON.parse(raw) : []) as Array<{
        field: string
        operator: string
        value: unknown
      }>) {
        if (f.field === "electronic_billing_address" && f.operator === "eq")
          list = list.filter((x) => x.e_invoicing?.electronic_billing_address === String(f.value))
        else if (f.field === "id" && f.operator === "gt")
          list = list.filter((x) => x.id > Number(f.value))
        else if (f.field === "external_reference" && f.operator === "eq")
          list = list.filter((x) => x.external_reference === String(f.value))
        else
          return {
            status: 400,
            body: {
              message: `filter ${f.field} ${f.operator} not supported by this fake (unproven)`,
            },
          }
      }
      if (params.get("sort") === "id") list.sort((a, b) => a.id - b.id)
      else if (params.get("sort") === "-id") list.sort((a, b) => b.id - a.id)
      const limit = Number(params.get("limit") ?? 20)
      return {
        status: 200,
        body: {
          items: list.slice(0, limit).map(clone),
          has_more: list.length > limit,
          next_cursor: null,
        },
      }
    }
    if ((m = /^\/supplier_invoices\/(\d+)$/.exec(path)) && M === "GET") {
      const inv = this.supplierInvoices.get(Number(m[1]))
      return inv
        ? { status: 200, body: clone(inv) }
        : { status: 404, body: { status: 404, error: "Not found" } }
    }
    if ((m = /^\/supplier_invoices\/(\d+)\/e_invoice_status$/.exec(path)) && M === "PUT") {
      const inv = this.supplierInvoices.get(Number(m[1]))
      if (!inv) return { status: 404, body: { status: 404, error: "Not found" } }
      const body = json ?? {}
      const cur = inv.e_invoicing?.status ?? null
      const reasons: Record<string, string[]> = {
        refused: [
          "incorrect_vat_rate",
          "contract_completed",
          "duplicate_invoice",
          "recipient_error",
          "incorrect_prices",
          "non_compliant_invoice",
        ],
        disputed: [
          "incorrect_vat_rate",
          "incorrect_unit_prices",
          "incorrect_billed_quantity",
          "incorrect_billed_item",
          "defective_delivered_item",
          "delivery_issue",
          "bank_details_error",
          "incorrect_payment_terms",
          "missing_legal_notice",
          "missing_contractual_reference",
          "recipient_error",
        ],
      }
      const invalid = (why: string) => ({ status: 422, body: { status: 422, error: why } })
      if (!inv.e_invoicing) return invalid("Not an e-invoice")
      if (["refused", "rejected", "collected", "partially_collected"].includes(cur))
        return invalid("Invalid status transition")
      if (body.status === "approved") {
        if (cur !== "disputed") return invalid("Invalid status transition")
      } else if (body.status === "refused" || body.status === "disputed") {
        if (inv.paid) return invalid("A payment is linked to this invoice")
        if (body.status === "disputed" && cur === "disputed")
          return invalid("Invalid status transition")
        if (!reasons[body.status]!.includes(body.reason))
          return {
            status: 400,
            body: { status: 400, error: `reason ${body.reason} is not allowed` },
          }
      } else return { status: 400, body: { status: 400, error: "status is invalid" } }
      inv.e_invoicing.status = body.status
      inv.e_invoicing.reason = body.reason ?? null
      inv.updated_at = new Date(this.now()).toISOString()
      return { status: 204, body: "" }
    }
    if ((m = /^\/suppliers\/(\d+)$/.exec(path)) && M === "GET") {
      const sup = this.suppliers.get(Number(m[1]))
      return sup
        ? { status: 200, body: clone(sup) }
        : { status: 404, body: { status: 404, error: "Not found" } }
    }
    if (M === "GET" && path === "/suppliers") {
      const raw = new URLSearchParams(query).get("filter")
      let list = [...this.suppliers.values()]
      for (const f of (raw ? JSON.parse(raw) : []) as Array<{
        field: string
        operator: string
        value: unknown
      }>) {
        if (f.field === "name" && f.operator === "start_with")
          list = list.filter((x) => String(x.name).startsWith(String(f.value)))
        else if (f.field === "name")
          return { status: 400, body: clone(RECORDED.errorSupplierNameFilter.body) }
        else if (f.field === "reg_no" && f.operator === "eq")
          list = list.filter((x) => x.reg_no === String(f.value))
        else
          return {
            status: 400,
            body: {
              message: `filter ${f.field} ${f.operator} not supported by this fake (unproven)`,
            },
          }
      }
      return this.page(list.map(clone))
    }
    if (M === "POST" && path === "/supplier_invoices/import") {
      const body = json ?? {}
      const att = this.attachments.get(Number(body.file_attachment_id))
      if (!att) return { status: 422, body: { status: 422, error: "File attachment not found" } }
      if (!this.suppliers.has(Number(body.supplier_id)))
        return { status: 422, body: { status: 422, error: "Supplier not found" } }
      if (att.used) {
        const owner = [...this.supplierInvoices.values()].find(
          (i) => i._attachment === Number(body.file_attachment_id),
        )
        return {
          status: 409,
          body: {
            status: 409,
            error: `A document with ID ${owner?.id} already exists with such attachment.`,
          },
        }
      }
      for (const k of [
        "supplier_id",
        "date",
        "deadline",
        "currency_amount_before_tax",
        "currency_amount",
        "currency_tax",
        "invoice_lines",
      ]) {
        if (body[k] === undefined)
          return { status: 400, body: { status: 400, error: `${k} is missing` } }
      }
      // The live API refuses a line without its VAT rate code (recorded 2026-11).
      const lines = Array.isArray(body.invoice_lines) ? (body.invoice_lines as Json[]) : []
      if (lines.some((l) => typeof l.vat_rate !== "string")) {
        return {
          status: 400,
          body: {
            message: "Missing required fields: invoice_lines.vat_rate.",
            code: "NotExistRequiredKey",
            field: "invoice_lines",
          },
        }
      }
      att.used = true
      const id = this.id()
      const inv: Json = {
        ...clone(RECORDED.supplierInvoiceImported.body as Json),
        id,
        invoice_number: body.invoice_number ?? null,
        date: body.date,
        deadline: body.deadline,
        currency: body.currency ?? "EUR",
        currency_amount: body.currency_amount,
        currency_amount_before_tax: body.currency_amount_before_tax,
        currency_tax: body.currency_tax,
        external_reference: body.external_reference ?? null,
        supplier: {
          id: Number(body.supplier_id),
          url: `https://app.pennylane.com/api/external/v2/suppliers/${body.supplier_id}`,
        },
        e_invoicing: null,
        _attachment: Number(body.file_attachment_id),
        _lines: body.invoice_lines,
      }
      this.supplierInvoices.set(id, inv)
      const { _attachment, _lines, ...pub } = inv
      return { status: 201, body: clone(pub) }
    }
    // --- webhook subscriptions
    if (M === "POST" && path === "/webhook_subscriptions") {
      const id = this.id()
      const sub = {
        ...clone(RECORDED.webhookSubscriptionCreated.body as Json),
        id,
        ...(json ?? {}),
        secret: `whsec_${id}_fake_secret_value`,
      }
      this.subscriptions.set(id, sub)
      return { status: 201, body: sub }
    }
    if (M === "GET" && path === "/webhook_subscriptions") {
      return this.page([...this.subscriptions.values()].map(({ secret: _s, ...rest }) => rest))
    }
    if ((m = /^\/webhook_subscriptions\/(\d+)$/.exec(path)) && M === "DELETE") {
      this.subscriptions.delete(Number(m[1]))
      return { status: 204, body: "" }
    }
    return { status: 404, body: { status: 404, error: `fake: no route ${M} ${path}` } }
  }

  private dispatch(call: FakeCall, run: () => Answer): Answer {
    this.calls.push(call)
    const fault = this.faults.find((f) => f.match(call))
    if (fault) this.faults.splice(this.faults.indexOf(fault), 1)
    if (fault?.mode === "replace") return fault.answer!
    if (this.remaining <= 0)
      return {
        status: 429,
        body: { status: 429, error: "Too many requests" },
        headers: { "retry-after": "5" },
      }
    const a = run()
    if (fault?.mode === "after") {
      if (fault.error) throw fault.error
      return fault.answer!
    }
    return a
  }

  /** Transport for adapter unit tests: the shape of `ctx.fetch`. */
  readonly sandboxFetch = async (
    url: string,
    opts: {
      method?: string
      headers?: Record<string, string>
      body?: string | { multipart: Array<Json> }
      timeoutMs?: number
    } = {},
  ): Promise<{
    status: number
    headers: Record<string, string>
    body: string
    upload?: {
      size: number
      parts: Array<{ name: string; size: number; sha256: string; fileId?: string }>
    }
  }> => {
    const path = url.replace(/^https:\/\/app\.pennylane\.com\/api\/external\/v2/, "")
    const method = opts.method ?? "GET"
    let json: Json | undefined
    let parts: Array<{ name: string; value?: string; meta?: FakeFileMeta | null }> | undefined
    let upload:
      | {
          size: number
          parts: Array<{ name: string; size: number; sha256: string; fileId?: string }>
        }
      | undefined
    if (opts.body && typeof opts.body === "object") {
      const specs = opts.body.multipart as Array<Json>
      const reported: Array<{ name: string; size: number; sha256: string; fileId?: string }> = []
      parts = specs.map((p) => {
        if (p.fileId) {
          const meta = this.files.get(String(p.fileId)) ?? null
          const refused = Array.isArray(p.refuseParents)
            ? (p.refuseParents as Array<{ app: string; entityType: string }>)
            : []
          if (
            meta?.parent &&
            refused.some(
              (r) => r.app === meta.parent!.app && r.entityType === meta.parent!.entityType,
            )
          ) {
            // What the kernel does before sending: a file under a refused parent refuses the call.
            throw Object.assign(
              new Error(
                `file ${p.fileId} belongs to ${meta.parent.app}/${meta.parent.entityType}, which this upload refuses`,
              ),
              { code: "file_parent_refused" },
            )
          }
          if (p.expectSha256 && meta && p.expectSha256 !== meta.sha256) {
            // What the kernel does before sending: a pinned part that does not match refuses.
            throw Object.assign(
              new Error(`part ${p.name}: the file's bytes do not match the expected fingerprint`),
              { code: "part_sha256_mismatch" },
            )
          }
          if (p.expectEmbeddedFile && meta) {
            // What the kernel does before sending: the PDF must embed exactly the checked XML.
            const want = String(p.expectEmbeddedFile.text ?? "")
            const f = ciiFacts(want)
            const same =
              meta.embedded_xml !== undefined
                ? meta.embedded_xml === want
                : meta.invoice_number !== null &&
                  f.number === meta.invoice_number &&
                  f.issueDate === meta.date &&
                  f.buyerSiren === meta.buyer_siren
            if (!same) {
              throw Object.assign(
                new Error(
                  `part ${p.name}: the uploaded file does not embed exactly the factur-x.xml that was checked`,
                ),
                {
                  code: "embedded_file_mismatch",
                },
              )
            }
          }
          reported.push({ name: p.name, size: 1, sha256: meta?.sha256 ?? "", fileId: p.fileId })
          return { name: String(p.name), meta }
        }
        reported.push({ name: p.name, size: String(p.value).length, sha256: "" })
        return { name: String(p.name), value: String(p.value) }
      })
      upload = { size: 0, parts: reported }
    } else if (typeof opts.body === "string" && opts.body !== "") {
      json = JSON.parse(opts.body)
    }
    const call: FakeCall = {
      method,
      path,
      ...(json ? { json } : {}),
      ...(parts
        ? { parts: parts.map((p) => ({ name: p.name, value: p.value, sha256: p.meta?.sha256 })) }
        : {}),
    }
    const a = this.dispatch(call, () => this.handle(method, path, json, parts))
    return {
      status: a.status,
      headers: { ...this.rate(), ...(a.headers ?? {}) },
      body: typeof a.body === "string" ? a.body : JSON.stringify(a.body),
      ...(upload ? { upload } : {}),
    }
  }

  /** Transport for integration tests: a fetch implementation behind the kernel egress override. */
  readonly httpFetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    if (!url.startsWith("https://app.pennylane.com/api/external/v2")) {
      return this.serveFile(url, new Headers(init.headers as never).get("authorization"))
    }
    const path = url.replace(/^https:\/\/app\.pennylane\.com\/api\/external\/v2/, "")
    const method = init.method ?? "GET"
    const headers = new Headers(init.headers as never)
    const ct = headers.get("content-type") ?? ""
    let json: Json | undefined
    let parts: Array<{ name: string; value?: string; meta?: FakeFileMeta | null }> | undefined
    if (ct.startsWith("multipart/form-data")) {
      parts = parseMultipart(
        new Uint8Array(init.body as Uint8Array),
        /boundary=(.+)$/.exec(ct)![1]!,
      ).map((p) =>
        p.filename !== null
          ? { name: p.name, meta: this.describeBytes?.(p.bytes) ?? null }
          : { name: p.name, value: new TextDecoder().decode(p.bytes) },
      )
    } else if (typeof init.body === "string" && init.body !== "") {
      json = JSON.parse(init.body)
    }
    const call: FakeCall = {
      method,
      path,
      ...(json ? { json } : {}),
      ...(parts
        ? { parts: parts.map((p) => ({ name: p.name, value: p.value, sha256: p.meta?.sha256 })) }
        : {}),
    }
    const a = this.dispatch(call, () => this.handle(method, path, json, parts))
    return new Response(
      a.status === 204 ? null : typeof a.body === "string" ? a.body : JSON.stringify(a.body),
      {
        status: a.status,
        headers: { ...this.rate(), ...(a.headers ?? {}) },
      },
    )
  }
}

function publicInvoice(inv: Json): Json {
  const { _sha256, _send_to_pa, _attachment, _lines, ...rest } = inv
  return clone(rest)
}

export function parseMultipart(
  body: Uint8Array,
  boundary: string,
): Array<{ name: string; filename: string | null; bytes: Uint8Array }> {
  const out: Array<{ name: string; filename: string | null; bytes: Uint8Array }> = []
  const dec = new TextDecoder("latin1")
  const text = dec.decode(body) // byte-preserving view for index arithmetic
  const sep = `--${boundary}`
  let at = text.indexOf(sep)
  while (at !== -1) {
    const next = text.indexOf(sep, at + sep.length)
    if (next === -1) break
    const start = at + sep.length + 2
    const headEnd = text.indexOf("\r\n\r\n", start)
    const head = text.slice(start, headEnd)
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? ""
    const filename = /filename="([^"]*)"/.exec(head)?.[1] ?? null
    out.push({ name, filename, bytes: body.slice(headEnd + 4, next - 2) })
    at = next
  }
  return out
}
