// SPDX-License-Identifier: FSL-1.1-ALv2
//
// einvoicing-pa@1 reception ops over Pennylane v2 (supplier invoices received through the PA):
//   list_received        the catch-up: `GET /supplier_invoices` per registered reception address
//                        (`electronic_billing_address eq`), `id gt` the per-address cursor, sorted by
//                        id. Webhook arrivals reach the caller through `list_status_changes`.
//   get_received         normalised invoice + supplier + what may be done now (refuse / dispute
//                        only while nothing terminal happened and no payment is linked; withdraw a
//                        dispute).
//   fetch_received_file  host-side download of the original (`e_invoicing.source_file_url`) or
//                        the provider's PDF rendering (`public_file_url`) onto the caller's file
//                        parent; the token goes to the API host only (first-hop-only mode).
//   set_received_status  `PUT /supplier_invoices/{id}/e_invoice_status`, only for an action and a
//                        reason offered now; answers the re-read invoice.
import {
  isReceivedState,
  RECEIVED_CODE,
  type ReceivedActionOffer,
  type ReceivedInvoice,
  type ReceivedState,
} from "@liaison/app-sdk/contracts"
import type { PennylaneToolCtx } from "../ctx"
import { fromException, type OpError, opError } from "../einvoicing/errors"
import { registrationStatus } from "../einvoicing/send"
import { getClient } from "../lib/get-client"
import { PennylaneApiError, PennylaneClient } from "../lib/pennylane-client"
import { API_HOST } from "./hosts"
import {
  DISPUTE_REASONS,
  PENNYLANE_RECEIVED_STATUS,
  PENNYLANE_STATUS_FOR,
  REFUSE_REASONS,
} from "./reasons"

export type ReceptionCtx = PennylaneToolCtx

interface SupplierInvoice {
  id: number
  invoice_number?: string | null
  date?: string | null
  deadline?: string | null
  currency?: string | null
  currency_amount?: string | null
  currency_amount_before_tax?: string | null
  currency_tax?: string | null
  paid?: boolean | null
  payment_status?: string | null
  public_file_url?: string | null
  filename?: string | null
  created_at?: string | null
  updated_at?: string | null
  supplier?: { id?: number | null } | null
  e_invoicing?: {
    status?: string | null
    reason?: string | null
    flow?: { id?: string | null } | null
    electronic_billing_address?: string | null
    source_file_url?: string | null
  } | null
}

interface Supplier {
  id: number
  name?: string | null
  reg_no?: string | null
  vat_number?: string | null
}

const PAID_STATUSES = new Set(["paid", "partially_paid", "fully_paid"])

async function client(ctx: PennylaneToolCtx): Promise<PennylaneClient> {
  return ctx.__client instanceof PennylaneClient ? ctx.__client : (await getClient(ctx)).client
}

function mappedStatus(raw: string | null): ReceivedState {
  if (raw === null) return "received"
  const m = PENNYLANE_RECEIVED_STATUS[raw]
  return m && isReceivedState(m) ? m : "received"
}

/** What a receiver may do now (Pennylane: refusing or disputing is blocked once a payment is
 *  linked; refused is terminal; approved only withdraws a dispute). */
export function offeredActions(raw: string | null, paymentLinked: boolean): ReceivedActionOffer[] {
  const out: ReceivedActionOffer[] = []
  const open = raw === null || raw === "waiting_for_validation" || raw === "approved"
  if (!paymentLinked && (open || raw === "disputed"))
    out.push({ action: "refuse", reasons: [...REFUSE_REASONS], comment: false })
  if (!paymentLinked && open)
    out.push({ action: "dispute", reasons: [...DISPUTE_REASONS], comment: false })
  if (raw === "disputed") out.push({ action: "undispute", reasons: [], comment: false })
  return out
}

// The sandbox has no URL global: these two read a URL by its fixed shape.
function fileName(url: string | null | undefined): string | null {
  if (!url) return null
  const path = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url)?.[1] ?? ""
  const last = path.split("/").pop() ?? ""
  if (!last) return null
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

function hostOf(url: string): string {
  return (/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url)?.[1] ?? "").toLowerCase()
}

function mimeOf(name: string | null): string | null {
  if (!name) return null
  if (/\.xml$/i.test(name)) return "application/xml"
  if (/\.pdf$/i.test(name)) return "application/pdf"
  return null
}

function normalise(inv: SupplierInvoice, supplier: Supplier | null): ReceivedInvoice {
  const e = inv.e_invoicing ?? {}
  const raw = e.status ?? null
  const mapped = mappedStatus(raw)
  const paymentLinked = inv.paid === true || PAID_STATUSES.has(String(inv.payment_status ?? ""))
  const originalName = fileName(e.source_file_url)
  const files: ReceivedInvoice["files"] = []
  if (e.source_file_url)
    files.push({ file: "original", filename: originalName, mime_type: mimeOf(originalName) })
  if (inv.public_file_url)
    files.push({
      file: "rendering",
      filename: `${inv.invoice_number ?? inv.id}.pdf`,
      mime_type: "application/pdf",
    })
  return {
    provider_ref: String(inv.id),
    supplier: {
      name: supplier?.name?.trim() || null,
      siren: /^\d{9}$/.test(String(supplier?.reg_no ?? "")) ? String(supplier!.reg_no) : null,
      vat_id: supplier?.vat_number?.trim() || null,
    },
    invoice_number: inv.invoice_number ?? null,
    issue_date: inv.date ?? null,
    due_date: inv.deadline ?? null,
    currency: inv.currency ?? null,
    totals: {
      before_tax: inv.currency_amount_before_tax ?? null,
      tax: inv.currency_tax ?? null,
      total: inv.currency_amount ?? null,
    },
    status: { raw, mapped, code: RECEIVED_CODE[mapped], reason_text: e.reason ?? null },
    routing_address: e.electronic_billing_address ?? null,
    flow_id: e.flow?.id ?? null,
    files,
    actions: offeredActions(raw, paymentLinked),
    payment_linked: paymentLinked,
    provider_ts: inv.updated_at ?? null,
    received_at: inv.created_at ?? null,
  }
}

async function read(c: PennylaneClient, ref: string): Promise<SupplierInvoice | OpError> {
  if (!/^\d+$/.test(ref))
    return opError("invalid_input", "provider_ref must be a Pennylane supplier invoice id")
  let inv: SupplierInvoice
  try {
    inv = await c.get<SupplierInvoice>(`/supplier_invoices/${ref}`)
  } catch (e) {
    if (e instanceof PennylaneApiError && e.status === 404)
      return opError("received_not_found", `Pennylane has no supplier invoice ${ref}`)
    throw e
  }
  if (!inv.e_invoicing) {
    return opError(
      "not_received_einvoice",
      `Supplier invoice ${ref} was not received through the e-invoicing network`,
    )
  }
  return inv
}

async function readNormalised(c: PennylaneClient, ref: string): Promise<ReceivedInvoice | OpError> {
  const inv = await read(c, ref)
  if ("status" in inv && inv.status === "error") return inv
  const si = inv as SupplierInvoice
  let supplier: Supplier | null = null
  if (si.supplier?.id) {
    try {
      supplier = await c.get<Supplier>(`/suppliers/${si.supplier.id}`)
    } catch (e) {
      if (!(e instanceof PennylaneApiError && e.status === 404)) throw e
    }
  }
  return normalise(si, supplier)
}

// ---------------------------------------------------------------------------------------------

/** The catch-up cursor: last id seen per reception address. */
function parseCursor(c: unknown): Record<string, number> {
  if (typeof c !== "string" || c === "") return {}
  try {
    const o = JSON.parse(c) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(o ?? {}))
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v
    return out
  } catch {
    return {}
  }
}

const PAGE = 50

/** The registered reception addresses (SIRENs), each once. */
export async function receptionAddresses(c: PennylaneClient): Promise<string[]> {
  const reg = await registrationStatus(c)
  return [
    ...new Set(
      reg.registrations
        .filter((r) => !r.direction || /reception/.test(r.direction))
        .map((r) => r.siren)
        .filter((s): s is string => typeof s === "string" && s !== ""),
    ),
  ]
}

export async function listReceived(ctx: PennylaneToolCtx, p: { cursor?: string | null }) {
  try {
    const c = await client(ctx)
    const addresses = await receptionAddresses(c)
    const cursor = parseCursor(p?.cursor)
    const items: Array<{ provider_ref: string; received_at: string | null }> = []
    let hasMore = false
    for (const address of addresses) {
      const after = cursor[address] ?? 0
      const page = await c.list<SupplierInvoice>("/supplier_invoices", {
        filter: [
          { field: "electronic_billing_address", operator: "eq", value: address },
          { field: "id", operator: "gt", value: String(after) },
        ],
        sort: "id",
        limit: PAGE,
      })
      let last = after
      for (const inv of page.items) {
        if (!inv.e_invoicing) continue
        items.push({ provider_ref: String(inv.id), received_at: inv.created_at ?? null })
        last = Math.max(last, inv.id)
      }
      cursor[address] = last
      if (page.has_more) hasMore = true
    }
    return { items, cursor: JSON.stringify(cursor), has_more: hasMore, addresses }
  } catch (e) {
    return fromException(e, "list_received")
  }
}

export async function getReceived(ctx: PennylaneToolCtx, p: { provider_ref: string }) {
  try {
    return await readNormalised(await client(ctx), String(p?.provider_ref ?? ""))
  } catch (e) {
    return fromException(e, "get_received")
  }
}

export async function fetchReceivedFile(
  ctx: ReceptionCtx,
  p: {
    provider_ref: string
    file: "original" | "rendering"
    target: { app?: string; entity_type?: string; entity_id?: string }
  },
) {
  if (!ctx.files_importFromUrl)
    return opError("unsupported", "the host file import is not available here")
  const t = p?.target ?? {}
  if (!t.app || !t.entity_type || !t.entity_id)
    return opError("invalid_input", "target needs app, entity_type and entity_id")
  if (p?.file !== "original" && p?.file !== "rendering")
    return opError("invalid_input", 'file is "original" or "rendering"')
  try {
    const c = await client(ctx)
    // Re-read for a fresh URL (the rendering's link expires after 30 minutes).
    const inv = await read(c, String(p.provider_ref ?? ""))
    if ("status" in inv && inv.status === "error") return inv
    const si = inv as SupplierInvoice
    const url = p.file === "original" ? si.e_invoicing?.source_file_url : si.public_file_url
    if (!url)
      return opError(
        "received_file_missing",
        `Pennylane gives no ${p.file} file for supplier invoice ${p.provider_ref}`,
      )
    const host = hostOf(url)
    const name =
      p.file === "original"
        ? (fileName(url) ?? `${si.invoice_number ?? si.id}.xml`)
        : `${si.invoice_number ?? si.id}.pdf`
    const out = JSON.parse(
      await ctx.files_importFromUrl(
        JSON.stringify({
          targetApp: t.app,
          targetEntityType: t.entity_type,
          targetEntityId: t.entity_id,
          url,
          filename: name,
          // The token is the API host's; a URL already pointing at the storage host needs none.
          headers: host === API_HOST ? { Authorization: c.downloadAuthorization() } : {},
          credentials: "first-hop-only",
          timeoutMs: 50_000,
        }),
      ),
    ) as { id: string; sha256?: string; sizeBytes?: number; mimeType?: string; filename?: string }
    return {
      file_id: out.id,
      sha256: out.sha256 ?? null,
      byte_size: out.sizeBytes ?? null,
      mime_type: out.mimeType ?? mimeOf(name),
      filename: out.filename ?? name,
    }
  } catch (e) {
    // A host bridge refusal crosses the sandbox as a plain error-shaped value: read its message.
    const msg = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)
    if (
      /allowlist|private|redirect|import_fetch_failed|file_too_large|invalid_credentials_mode/i.test(
        msg,
      )
    ) {
      return opError("received_file_download_refused", `fetch_received_file: ${msg}`)
    }
    return fromException(e, "fetch_received_file")
  }
}

export async function setReceivedStatus(
  ctx: PennylaneToolCtx,
  p: { provider_ref: string; status: string; reason?: string | null; comment?: string | null },
) {
  const status = p?.status
  if (status !== "refused" && status !== "in_dispute" && status !== "approved") {
    return opError("invalid_input", 'status is "refused", "in_dispute" or "approved"')
  }
  const action = status === "refused" ? "refuse" : status === "in_dispute" ? "dispute" : "undispute"
  try {
    const c = await client(ctx)
    const ref = String(p.provider_ref ?? "")
    const current = await readNormalised(c, ref)
    if ("status" in current && (current as OpError).status === "error") return current
    const now = current as ReceivedInvoice
    const offer = now.actions.find((a) => a.action === action)
    if (!offer) {
      return opError(
        "received_action_not_allowed",
        `Pennylane does not allow to ${action} supplier invoice ${ref} now (status ${now.status.raw ?? "received"}${now.payment_linked ? ", a payment is linked" : ""})`,
        false,
        { status: now.status, payment_linked: now.payment_linked },
      )
    }
    if (action !== "undispute" && !offer.reasons.some((r) => r.reason === p.reason)) {
      return opError(
        "received_reason_invalid",
        `"${p.reason}" is not one of Pennylane's reasons to ${action}`,
        false,
        {
          reasons: offer.reasons.map((r) => r.reason),
        },
      )
    }
    const body =
      action === "undispute"
        ? { status: PENNYLANE_STATUS_FOR.approved }
        : { status: PENNYLANE_STATUS_FOR[status], reason: p.reason }
    try {
      await c.put(`/supplier_invoices/${ref}/e_invoice_status`, body)
    } catch (e) {
      if (e instanceof PennylaneApiError && (e.status === 422 || e.status === 400)) {
        const after = await readNormalised(c, ref)
        return opError(
          "provider_rejected",
          `Pennylane refused to ${action} supplier invoice ${ref} (${e.status})`,
          false,
          {
            status: e.status,
            body: e.body,
            now:
              "status" in after && (after as OpError).status === "error"
                ? null
                : (after as ReceivedInvoice).status,
          },
        )
      }
      throw e
    }
    return await readNormalised(c, ref)
  } catch (e) {
    return fromException(e, "set_received_status")
  }
}
