// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Fake-drift check (opt-in): the same sequence of Pennylane calls against the recorded-shape
// fake and the live SANDBOX company, comparing the response shapes (keys, recursively) for every
// op the sandbox supports: customers (filter, create, duplicate reference, routing addresses),
// the Factur-X import and its validation, invoice list filters, update_imported, file
// attachments and bookings. Never `send_to_pa` (the sandbox cannot transmit).
//
// Runs only with PENNYLANE_SANDBOX_TOKEN and PENNYLANE_SANDBOX_DRIFT=1 (never a production token).
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { type PennylaneFetch, PennylaneClient } from "../lib/pennylane-client"
import { PennylaneFake } from "./fake/server"

// The Factur-X builder (invoicing app) and the kernel PDF/A renderer make a real file to import.
// Loaded at run time so this app's typecheck does not compile the kernel's sources.
const RENDER = "../../../../apps/api/src/modules/pdf/replay"
const CII = "../../../invoicing/src/facturx/cii"
const FIXTURES = "../../../invoicing/src/facturx/fixtures"
const RECORD = "../../../invoicing/src/legal-originals/record"
type Replay = (commands: unknown[], opts?: Record<string, unknown>) => Promise<Uint8Array>
const FX_BUYER = { siren: "356000000", legal_name: "Client Exemple SARL" }

const TOKEN = process.env.PENNYLANE_SANDBOX_TOKEN
const ENABLED = Boolean(TOKEN) && process.env.PENNYLANE_SANDBOX_DRIFT === "1"

function shape(v: unknown): unknown {
  if (v === null || v === undefined) return "null"
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : []
  if (typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, shape((v as Record<string, unknown>)[k])]),
    )
  }
  return typeof v
}

/** Keys present in one shape and not the other, as dotted paths (types are not compared:
 *  nullable fields legitimately differ in value between runs). */
function keyDiff(a: unknown, b: unknown, path = ""): string[] {
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out: string[] = []
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    for (const k of ka) if (!kb.includes(k)) out.push(`only-fake ${path}${k}`)
    for (const k of kb) if (!ka.includes(k)) out.push(`only-sandbox ${path}${k}`)
    for (const k of ka) if (kb.includes(k)) out.push(...keyDiff((a as any)[k], (b as any)[k], `${path}${k}.`))
    return out
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length && b.length) return keyDiff(a[0], b[0], `${path}[].`)
  return []
}

async function facturx(number: string): Promise<Uint8Array> {
  const { buildCii } = (await import(CII)) as { buildCii: (i: unknown) => string }
  const { fxDocument } = (await import(FIXTURES)) as { fxDocument: (o: unknown) => unknown }
  const { facturxXmpExtension } = (await import(RECORD)) as { facturxXmpExtension: () => unknown }
  const { replayDrawCommands } = (await import(RENDER)) as { replayDrawCommands: Replay }
  const xml = buildCii(fxDocument({ number, issue_date: "2026-10-15", due_date: "2026-10-15" }))
  return replayDrawCommands(
    [
      { op: "setMetadata", title: `Invoice ${number}`, producer: "Liaison Invoicing", creator: "Liaison Invoicing" },
      { op: "embedFont", ref: "f1", standardFont: "Helvetica" },
      { op: "addPage", width: 595, height: 842 },
      { op: "drawText", page: 0, text: `Facture ${number}`, x: 40, y: 800, size: 12, font: "f1" },
    ],
    {
      pdfa: {
        level: "3b",
        attachments: [{ name: "factur-x.xml", mime: "text/xml", bytes: new TextEncoder().encode(xml), afRelationship: "Data", description: "Factur-X invoice" }],
        xmpExtensions: [facturxXmpExtension()],
        now: new Date(),
      },
    },
  )
}

/** A ctx.fetch for a real host: multipart parts with a fileId are read from `files`. */
function liveFetch(files: Map<string, { bytes: Uint8Array; filename: string }>): PennylaneFetch {
  let last = 0
  return async (url, opts = {}) => {
    const wait = 260 - (Date.now() - last)
    if (wait > 0) await Bun.sleep(wait)
    last = Date.now()
    let body: BodyInit | undefined
    const headers = { ...(opts.headers ?? {}) }
    if (opts.body && typeof opts.body === "object") {
      const fd = new FormData()
      for (const p of opts.body.multipart) {
        if ("fileId" in p) {
          const f = files.get(p.fileId)!
          fd.append(p.name, new File([new Uint8Array(f.bytes)], p.filename ?? f.filename, { type: p.contentType ?? "application/pdf" }))
        } else fd.append(p.name, p.value)
      }
      body = fd
      delete headers["Content-Type"]
    } else body = opts.body as string | undefined
    const res = await fetch(url, { method: opts.method ?? "GET", headers, body })
    const h: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      h[k] = v
    })
    return { status: res.status, headers: h, body: await res.text() }
  }
}

describe.skipIf(!ENABLED)("Pennylane fake vs sandbox: response shapes", () => {
  it(
    "every sandbox-supported op answers in the shape the fake replays",
    async () => {
      const run = Date.now().toString(36)
      const number = `DRIFT-${run}`
      const pdf = await facturx(number)
      const sha = createHash("sha256").update(pdf).digest("hex")
      const fileId = "00000000-0000-4000-8000-00000000d001"
      const plainId = "00000000-0000-4000-8000-00000000d002"
      const { replayDrawCommands } = (await import(RENDER)) as { replayDrawCommands: Replay }
      const plain = await replayDrawCommands([
        { op: "embedFont", ref: "f1", standardFont: "Helvetica" },
        { op: "addPage", width: 595, height: 842 },
        { op: "drawText", page: 0, text: `Booking ${run}`, x: 40, y: 800, size: 12, font: "f1" },
      ])
      const files = new Map([
        [fileId, { bytes: pdf, filename: `${number}.pdf` }],
        [plainId, { bytes: plain, filename: `B-${run}.pdf` }],
      ])
      const fake = new PennylaneFake()
      fake.directory[FX_BUYER.siren] = [FX_BUYER.siren]
      fake.files.set(fileId, { sha256: sha, invoice_number: number, date: "2026-10-15", buyer_siren: FX_BUYER.siren, valid: true })
      fake.files.set(plainId, { sha256: createHash("sha256").update(plain).digest("hex"), invoice_number: null, date: null, buyer_siren: null, valid: false })
      const clients = {
        fake: new PennylaneClient({ fetch: fake.sandboxFetch, apiToken: "tok" }),
        sandbox: new PennylaneClient({ fetch: liveFetch(files), apiToken: TOKEN! }),
      }

      async function both(label: string, fn: (c: PennylaneClient) => Promise<unknown>) {
        const out: Record<string, unknown> = {}
        for (const [k, c] of Object.entries(clients)) {
          try {
            out[k] = await fn(c)
          } catch (e) {
            out[k] = { __error: (e as { status?: number }).status ?? String(e), body: JSON.parse((e as { body?: string }).body || "{}") }
          }
        }
        return { label, diff: keyDiff(shape(out.fake), shape(out.sandbox)), out }
      }

      const ext = `drift-${run}`
      const results = []
      results.push(await both("customers filter (empty)", (c) => c.list("/customers", { filter: [{ field: "external_reference", operator: "eq", value: ext }] })))
      const created: Record<string, number> = {}
      results.push(
        await both("customer create", async (c) => {
          const r = await c.post<{ id: number }>("/customers", {
            customer_type: "company",
            name: FX_BUYER.legal_name,
            reg_no: FX_BUYER.siren,
            external_reference: ext,
            billing_address: { address: "2 avenue du Test", postal_code: "69002", city: "Lyon", country_alpha2: "FR" },
          })
          created[c === clients.fake ? "fake" : "sandbox"] = r.data.id
          return r.data
        }),
      )
      results.push(
        await both("customer duplicate reference (422)", (c) =>
          c.post("/customers", { customer_type: "company", name: "x", external_reference: ext, billing_address: { address: "x", postal_code: "1", city: "x", country_alpha2: "FR" } }),
        ),
      )
      results.push(await both("routing addresses", (c) => c.list(`/customers/${created[c === clients.fake ? "fake" : "sandbox"]}/electronic_billing_addresses`)))
      results.push(await both("routing set", (c) => c.put(`/customers/${created[c === clients.fake ? "fake" : "sandbox"]}`, { electronic_billing_address: FX_BUYER.siren }).then((r) => r.data)))
      const inv: Record<string, number> = {}
      results.push(
        await both("e-invoice import", async (c) => {
          const who = c === clients.fake ? "fake" : "sandbox"
          const r = await c.postMultipart<{ id: number }>("/customer_invoices/e_invoices/imports", [
            { name: "file", fileId, filename: `${number}.pdf`, contentType: "application/pdf" },
            { name: "send_to_pa", value: "false" },
            { name: "invoice_options[customer_id]", value: String(created[who]) },
          ])
          inv[who] = r.data.id
          return r.data
        }),
      )
      await Bun.sleep(3000)
      results.push(await both("invoice get", (c) => c.get(`/customer_invoices/${inv[c === clients.fake ? "fake" : "sandbox"]}`)))
      results.push(
        await both("list by invoice_number + date", (c) =>
          c.list("/customer_invoices", {
            filter: [
              { field: "invoice_number", operator: "eq", value: number },
              { field: "date", operator: "eq", value: "2026-10-15" },
            ],
          }),
        ),
      )
      results.push(await both("update_imported", (c) => c.put(`/customer_invoices/${inv[c === clients.fake ? "fake" : "sandbox"]}/update_imported`, { external_reference: `k-${run}` }).then((r) => r.data)))
      results.push(
        await both("re-import same bytes (409)", (c) =>
          c.postMultipart("/customer_invoices/e_invoices/imports", [{ name: "file", fileId, filename: `${number}.pdf` }, { name: "send_to_pa", value: "false" }]),
        ),
      )
      const att: Record<string, number> = {}
      results.push(
        await both("file attachment", async (c) => {
          const r = await c.postMultipart<{ id: number }>("/file_attachments", [{ name: "file", fileId: plainId, filename: `B-${run}.pdf` }, { name: "filename", value: `B-${run}.pdf` }])
          att[c === clients.fake ? "fake" : "sandbox"] = r.data.id
          return r.data
        }),
      )
      const booking = (who: string) => ({
        file_attachment_id: att[who],
        date: "2026-10-15",
        deadline: "2026-10-15",
        customer_id: created[who],
        currency: "EUR",
        invoice_number: `B-${run}`,
        external_reference: `book-${run}`,
        currency_amount_before_tax: "100.00",
        currency_amount: "120.00",
        currency_tax: "20.00",
        invoice_lines: [{ label: "Item", currency_amount: "120.00", currency_tax: "20.00", quantity: 1, raw_currency_unit_price: "100.00", unit: "piece", vat_rate: "FR_200" }],
      })
      results.push(await both("booking import", (c) => c.post("/customer_invoices/import", booking(c === clients.fake ? "fake" : "sandbox")).then((r) => r.data)))
      results.push(await both("booking duplicate reference (422)", (c) => c.post("/customer_invoices/import", booking(c === clients.fake ? "fake" : "sandbox"))))
      results.push(await both("booking find by external_reference", (c) => c.list("/customer_invoices", { filter: [{ field: "external_reference", operator: "eq", value: `book-${run}` }] })))

      const drift = results.filter((r) => r.diff.length > 0).map((r) => `${r.label}: ${r.diff.join(", ")}`)
      if (drift.length) console.log(JSON.stringify(results.filter((r) => r.diff.length > 0), null, 1).slice(0, 4000))
      expect(drift).toEqual([])
    },
    { timeout: 120_000 },
  )
})
