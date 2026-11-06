// SPDX-License-Identifier: FSL-1.1-ALv2
// Automatic credit notes (a Shopify refund, an order cancellation) that the e-invoicing gate
// refuses are parked with their OWN arguments, on the buyer's identity, and re-issued alone by the
// deferred-retry sweep once that identity is fixed. Re-running the whole refund or cancellation
// handler would not do: the refund is already recorded (the handler returns early and issues
// nothing) and the cancellation would be recorded and announced a second time.
import { AUTO_CREDIT_NOTE_PARK_KIND, park } from "../deferred"
import type { DeferredRow } from "../deferred"
import { type Counterparty, type LineKind, storedTaxCountry } from "../issue"
import { creditedTotalMinor, creditNoteCreateAndIssue, type MutationsCtx } from "../mutations"
import { buildAdjustmentReversalItems } from "../handlers/shopify-refund-created"
import { EINVOICE_IDENTITY_PARK_KIND, GATE_CODE_STATUS, type GateCode, raiseIdentityAttention } from "./gate"
import { counterpartyEinvoiceFields, readEinvoiceRowColumns } from "./issue-gate"
import { toBigInt } from "../mutations/shared"

export const PARKED_CREDIT_NOTE_KIND = "parked_credit_note"

/** Non-null approval sentinels: the refund / the cancellation authorises the reversal, so it is
 *  never held for approval regardless of amount (issueDocument does not read `approval`). */
export const AUTO_CREDIT_NOTE_APPROVAL = {
  refund: {
    approvalRequestId: "auto:shopify-refund",
    approvalDeciderId: "system",
    toolName: "invoicing:credit_note_create_and_issue",
  },
  cancel: {
    approvalRequestId: "auto:shopify-order-cancelled",
    approvalDeciderId: "system",
    toolName: "invoicing:credit_note_create_and_issue",
  },
} as const

/** A parked automatic credit note: everything needed to issue it again, money as strings. */
export interface ParkedCreditNotePayload {
  kind: typeof PARKED_CREDIT_NOTE_KIND
  source: "refund" | "cancel"
  original_document_id: string
  /** Gross amount the credit note reverses, minor units. */
  amount_minor: string
  full_reversal: boolean
  refund_id?: string
  order_id?: string
  issuer_profile_id: string | null
  counterparty: Counterparty
  currency: string
  items: Array<Record<string, unknown>>
  reason: string
}

export interface AutoCreditNote {
  source: "refund" | "cancel"
  original_document_id: string
  amount_minor: bigint
  full_reversal: boolean
  refund_id?: string
  order_id?: string
  issuer_profile_id: string | null
  counterparty: Counterparty
  currency: string
  items: Array<Record<string, unknown>>
  reason: string
  /** Order reference shown on the attention item. */
  order_label: string
}

/**
 * The recipient of an automatic credit note: the ORIGINAL invoice's snapshot verbatim, with its
 * e-invoicing columns (kind, identity, structured billing). No "Customer" fallback: fabricating a
 * name would issue a NEW legal document to a recipient nobody named, so an original with an
 * incomplete recipient refuses (and parks) until it is completed with documents_update.
 */
export function autoCreditNoteCounterparty(original: Record<string, unknown>): Counterparty {
  return {
    ...counterpartyEinvoiceFields(readEinvoiceRowColumns(original)),
    contact_id: (original.counterparty_contact_id as string | null) ?? null,
    legal_name: String(original.counterparty_name ?? ""),
    country: String(original.counterparty_country ?? ""),
    tax_country: storedTaxCountry(original),
    vat_id: (original.counterparty_vat_id as string | null) ?? null,
    address: (original.counterparty_address as string | null) ?? null,
    shipping_address: (original.counterparty_shipping_address as string | null) ?? null,
    shipping_name: (original.counterparty_shipping_name as string | null) ?? null,
    email: (original.counterparty_email as string | null) ?? null,
  }
}

export function isParkedCreditNote(payload: unknown): payload is ParkedCreditNotePayload {
  return (
    !!payload &&
    typeof payload === "object" &&
    (payload as Record<string, unknown>).kind === PARKED_CREDIT_NOTE_KIND
  )
}

function isGateCode(code: unknown): code is GateCode {
  return typeof code === "string" && Object.hasOwn(GATE_CODE_STATUS, code)
}

/** Items as stored on a park: bigints become decimal strings (JSON has no bigint). */
function storableItems(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return items.map((it) =>
    Object.fromEntries(Object.entries(it).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
  )
}

function issueItems(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return items.map((it) => ({
    ...it,
    unit_price_minor: toBigInt(it.unit_price_minor),
    ...(it.discount_minor != null ? { discount_minor: toBigInt(it.discount_minor) } : {}),
  }))
}

function issue(
  ctx: MutationsCtx,
  note: Pick<AutoCreditNote, "source" | "issuer_profile_id" | "counterparty" | "currency" | "original_document_id" | "reason">,
  items: Array<Record<string, unknown>>,
) {
  return creditNoteCreateAndIssue(
    { ...ctx, approval: AUTO_CREDIT_NOTE_APPROVAL[note.source] },
    {
      issuer_profile_id: note.issuer_profile_id,
      counterparty: note.counterparty,
      currency: note.currency,
      items: issueItems(items) as never,
      original_document_id: note.original_document_id,
      reason: note.reason,
    },
    { source: "shopify" },
  )
}

export function parkedCreditNoteEventId(note: Pick<AutoCreditNote, "source" | "refund_id" | "order_id" | "original_document_id">): string {
  return note.source === "refund"
    ? `cn:${note.refund_id ?? ""}:${note.original_document_id}`
    : `cn:cancel:${note.order_id ?? ""}:${note.original_document_id}`
}

interface AutoCtx {
  logger?: { error(msg: string, data?: unknown): void }
}

/**
 * Issue one automatic credit note. Never dropped: an e-invoicing refusal (enforce) parks it on
 * the buyer's identity (no dead-letter, re-driven on identity change) and raises the identity
 * attention item (one per contact); any other refusal (an incomplete recipient, an over-credit)
 * parks it as `auto_credit_note` with its own attention item. Never throws on a refusal.
 */
export async function issueOrParkAutoCreditNote(
  ctx: MutationsCtx & AutoCtx,
  note: AutoCreditNote,
): Promise<"issued" | "parked"> {
  const res = await issue(ctx, note, note.items)
  if (res.status === "completed") return "issued"
  const code = res.status === "error" ? (res.error.code ?? "error") : res.status
  const payload: ParkedCreditNotePayload = {
      kind: PARKED_CREDIT_NOTE_KIND,
      source: note.source,
      original_document_id: note.original_document_id,
      amount_minor: note.amount_minor.toString(),
      full_reversal: note.full_reversal,
      ...(note.refund_id !== undefined ? { refund_id: note.refund_id } : {}),
      ...(note.order_id !== undefined ? { order_id: note.order_id } : {}),
      issuer_profile_id: note.issuer_profile_id,
      counterparty: note.counterparty,
      currency: note.currency,
      items: storableItems(note.items),
      reason: note.reason,
    }
  const contactId = note.counterparty.contact_id ?? null
  if (res.status === "error" && isGateCode(code)) {
    const def = await park(
      { db: ctx.db },
      {
        event_id: parkedCreditNoteEventId(note),
        event_payload_json: payload,
        status: "awaiting_data",
        reason: code,
        blocked_on: {
          kind: EINVOICE_IDENTITY_PARK_KIND,
          contact_id: contactId,
          document_id: note.original_document_id,
          code,
        },
      },
    )
    await raiseIdentityAttention(ctx, {
      park: def,
      contact_id: contactId,
      code,
      data: {
        order_label: note.order_label,
        contact_label: note.counterparty.legal_name,
        document_id: note.original_document_id,
      },
    })
    return "parked"
  }
  const message = res.status === "error" ? res.error.message : undefined
  ctx.logger?.error?.("invoicing: automatic credit note refused, parked", {
    source: note.source,
    document_id: note.original_document_id,
    code,
    message,
  })
  const def = await park(
    { db: ctx.db },
    {
      event_id: parkedCreditNoteEventId(note),
      event_payload_json: payload,
      status: code === "issuer_timezone_invalid" ? "awaiting_config" : "awaiting_data",
      reason: code,
      blocked_on: {
        kind: AUTO_CREDIT_NOTE_PARK_KIND,
        contact_id: contactId,
        document_id: note.original_document_id,
        code,
      },
    },
  )
  if (def.created && ctx.emit) {
    await ctx.emit({
      entity: "deferred",
      action: "credit_note_refused",
      entityId: def.id,
      data: {
        deferred_id: def.id,
        order_label: note.order_label,
        document_id: note.original_document_id,
        code,
        message: message ?? null,
        resolved: false,
      },
    })
  }
  return "parked"
}

/**
 * Re-issue ONE parked automatic credit note. Idempotent: when this park's credit note already
 * exists (same original, same reason) or the original is fully credited, nothing is issued; when
 * part of the original was credited meanwhile, only what remains is reversed (never over-credit).
 */
export async function retryParkedCreditNote(
  ctx: MutationsCtx,
  row: Pick<DeferredRow, "event_payload_json">,
): Promise<{ status: "ok" } | { status: "still_blocked"; reason: string }> {
  const p = row.event_payload_json
  if (!isParkedCreditNote(p)) return { status: "still_blocked", reason: "invalid_parked_credit_note" }
  const original = (await ctx.db.findOne("documents", p.original_document_id)) as Record<string, unknown> | null
  if (!original) return { status: "still_blocked", reason: "original_missing" }

  const orderId = (original.shopify_order_id as string | null) ?? null
  const candidates = orderId
    ? ((await ctx.db.findMany("documents", { where: { shopify_order_id: orderId }, limit: 50 })) as Array<
        Record<string, unknown>
      >)
    : []
  const lifecycle = (original.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? []
  const linkedIds = new Set(
    lifecycle
      .filter((e) => String(e.event ?? "") === "credit_note_issued" && typeof e.credit_note_id === "string")
      .map((e) => String(e.credit_note_id)),
  )
  const notes: Array<Record<string, unknown>> = candidates.filter((d) => {
    const refs = (d.external_refs as Record<string, unknown> | undefined) ?? {}
    return d.type === "credit_note" && (d.original_document_id ?? refs.original_document_id) === p.original_document_id
  })
  for (const id of linkedIds) {
    if (notes.some((n) => String(n.id) === id)) continue
    const n = (await ctx.db.findOne("documents", id)) as Record<string, unknown> | null
    if (n) notes.push(n)
  }
  const alreadyIssued = notes.some(
    (n) =>
      n.type === "credit_note" &&
      String(n.status ?? "draft") !== "draft" &&
      ((n.external_refs as Record<string, unknown> | undefined) ?? {}).reason === p.reason,
  )
  if (alreadyIssued) return { status: "ok" }

  const credited = await creditedTotalMinor(
    ctx.db,
    { id: String(original.id), lifecycle_log: lifecycle },
    candidates,
  )
  const total = toBigInt(original.grand_total_minor)
  const remaining = (total < 0n ? -total : total) - credited
  if (remaining <= 0n) return { status: "ok" }

  let items = p.items
  if (toBigInt(p.amount_minor) > remaining) {
    const lines = (await ctx.db.findMany("document_lines", {
      where: { document_id: p.original_document_id },
    })) as Array<Record<string, unknown>>
    items = buildAdjustmentReversalItems(
      lines.map((l) => ({
        unit_price_minor: toBigInt(l.unit_price_minor),
        quantity: (l.quantity as string | number | undefined) ?? "1",
        tax_rate_bp: Number(l.tax_rate_bp ?? 0),
        line_kind: ((l.line_kind as LineKind | undefined) ?? "goods") as LineKind,
      })),
      remaining,
      (original.scope as string | null) ?? null,
    )
  }

  // The recipient is the original's, as it stands now: a person may have completed it, or linked
  // it to its buyer's contact, since the park.
  const res = await issue(ctx, { ...p, counterparty: autoCreditNoteCounterparty(original) }, items)
  if (res.status === "completed") return { status: "ok" }
  return { status: "still_blocked", reason: res.status === "error" ? (res.error.code ?? "error") : res.status }
}
