// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The credit note of one refund of a stream sale: citing the sale's invoice, capped at what
// remains uncredited, split over the invoice's VAT rates (the same reversal as a Stripe or Shopify
// refund), keyed by the refund so it is never issued twice. A Stripe sale's refund takes the key
// the Stripe refund handler uses (`stripe:<re_...>`), so whichever of the two comes first issues it
// and the other finds it.

import type { SaleRefund } from "@liaison/app-sdk/contracts"
import { autoCreditNoteCounterparty } from "../einvoicing/parked-credit-note"
import { buildAdjustmentReversalItems } from "../handlers/shopify-refund-created"
import type { LineKind } from "../issue"
import { creditedTotalMinor, creditNoteCreateAndIssue } from "../mutations"
import { type MutationsCtx, toBigInt } from "../mutations/shared"
import { readSale, type SaleCtx, streamSource } from "./issue-sale"
import { type RevenueStream, streamForSale, streamsOf } from "./streams"

export type SaleRefundCtx = SaleCtx & MutationsCtx

type Row = Record<string, unknown>

export type RefundCreditOutcome =
  | { outcome: "issued"; document_id: string; number: string }
  | { outcome: "exists"; document_id: string }
  | { outcome: "nothing_left" }
  | { outcome: "refused"; reason: string }

const AUTO_APPROVAL = {
  approvalRequestId: "auto:revenue-stream-refund",
  approvalDeciderId: "system",
  toolName: "invoicing:credit_note_create_and_issue",
}

export function refundRef(stream: RevenueStream, refundId: string): string {
  return stream.provider_app === "stripe"
    ? `stripe:${refundId}`
    : `rs:${stream.provider_app}:refund:${refundId}`
}

export async function creditSaleRefund(
  ctx: MutationsCtx,
  stream: RevenueStream,
  original: Row,
  refund: SaleRefund,
): Promise<RefundCreditOutcome> {
  const ref = refundRef(stream, refund.refund_id)
  const existing = (await ctx.db.findMany("documents", {
    where: { external_ref: ref },
    limit: 1,
  })) as Row[]
  if (existing[0]) return { outcome: "exists", document_id: String(existing[0].id) }
  const fresh = ((await ctx.db.findOne("documents", String(original.id))) as Row | null) ?? original
  const total = toBigInt(fresh.grand_total_minor)
  const credited = await creditedTotalMinor(ctx.db, {
    id: String(fresh.id),
    lifecycle_log: (fresh.lifecycle_log as Row[] | undefined) ?? [],
  })
  const remaining = (total < 0n ? -total : total) - credited
  if (remaining <= 0n) return { outcome: "nothing_left" }
  let amount = toBigInt(refund.amount_minor)
  if (amount > remaining) amount = remaining
  const lines = (await ctx.db.findMany("document_lines", {
    where: { document_id: String(fresh.id) },
  })) as Row[]
  const items = buildAdjustmentReversalItems(
    lines.map((l) => ({
      unit_price_minor: toBigInt(l.unit_price_minor),
      quantity: (l.quantity as string | number | undefined) ?? "1",
      tax_rate_bp: Number(l.tax_rate_bp ?? 0),
      line_kind: ((l.line_kind as LineKind | undefined) ?? "service") as LineKind,
    })),
    amount,
    (fresh.scope as string | null) ?? null,
  )
  const res = await creditNoteCreateAndIssue(
    { ...ctx, approval: AUTO_APPROVAL },
    {
      issuer_profile_id: (fresh.issuer_profile_id as string | null) ?? null,
      counterparty: autoCreditNoteCounterparty(fresh),
      currency: String(fresh.currency ?? "EUR"),
      // The reversal lines as the Stripe and Shopify refund paths pass them.
      items: items as never,
      original_document_id: String(fresh.id),
      reason: `Refund ${refund.refund_id}`,
    },
    { external_ref: ref, einvoice_send: "batch" },
  )
  if (res.status === "completed")
    return { outcome: "issued", document_id: res.document_id, number: res.number }
  return {
    outcome: "refused",
    reason: res.status === "error" ? `${res.error.code}: ${res.error.message}` : res.status,
  }
}

/**
 * `contract:revenue-stream@1/sale:refunded`: the sale is read again and each of its refunds that
 * has no credit note yet gets one, on the sale's invoice. A sale with no invoice (not bound, before
 * the stream, still parked) credits nothing: its refunds are credited when its invoice issues
 * (the catch-up issues the invoice and then the credit notes).
 */
export async function onSaleRefunded(
  event: { app?: string; data?: { external_id?: unknown } },
  ctx: SaleRefundCtx,
): Promise<{ status: "ok" | "skipped"; reason?: string; credit_notes: RefundCreditOutcome[] }> {
  const provider = typeof event?.app === "string" ? event.app : ""
  const externalId =
    typeof event?.data?.external_id === "string" ? event.data.external_id.trim() : ""
  if (!provider || !externalId)
    return { status: "skipped", reason: "not_an_event", credit_notes: [] }
  // The shop's and Stripe's refunds arrive through their own refund events (keyed alike).
  if (provider === "shopify" || provider === "stripe")
    return { status: "skipped", reason: "own_refund_path", credit_notes: [] }
  const streams = await streamsOf(ctx.db, provider)
  if (streams.length === 0) return { status: "skipped", reason: "no_stream", credit_notes: [] }
  const read = await readSale(ctx, provider, externalId)
  if (!read.ok) {
    if (read.reason === "not_found")
      return { status: "skipped", reason: "sale_not_found", credit_notes: [] }
    throw new Error(`revenue stream ${provider}: sale ${externalId} unreadable (${read.detail})`)
  }
  const stream = streamForSale(streams, read.sale.refs?.account)
  if (!stream) return { status: "skipped", reason: "no_stream", credit_notes: [] }
  const docs = (await streamSource(stream, read.sale).existingDocuments(ctx)).filter(
    (d) => d.type !== "credit_note",
  )
  const primary = docs[0]
  if (!primary) return { status: "skipped", reason: "not_invoiced", credit_notes: [] }
  const out: RefundCreditOutcome[] = []
  for (const r of read.sale.refunds ?? []) out.push(await creditSaleRefund(ctx, stream, primary, r))
  return { status: "ok", credit_notes: out }
}
