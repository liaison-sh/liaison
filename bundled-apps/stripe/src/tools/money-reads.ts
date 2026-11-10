// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The two reads invoicing makes of the Stripe app, hidden from the agent:
//
//   refunds_for_charge   every refund of one charge, by id, read from Stripe
//                        (`GET /v1/refunds?charge=`), never the charge's cumulative
//                        refunded amount, with the charge's invoice and the key of the
//                        document the charge became (`stripeDocumentRef`).
//   reconcile_candidates what an event may have missed, from the mirror: Stripe invoices
//                        finalized in the last 35 days that name no Liaison document
//                        (re-read from Stripe, in the `invoice:finalized` shape), paid
//                        invoices of the last 3 days that name one (to mark them paid),
//                        and succeeded refunds of the last 35 days with no credit note.
//                        Invoicing's own handlers decide; each is idempotent by its key.
import { refuseTool } from "@liaison/app-sdk"
import { type StripeHttpCtx, stripeFetch } from "../http"
import { type MirrorDb, newTally } from "../mirror"
import { invoiceEventPayload, invoiceOfCharge, listRefunds, refundItem, stripeDocumentRef } from "../money-events"
import { moneyActionHold, type StateDb } from "../states"

type Obj = Record<string, unknown>

export interface MoneyReadCtx extends StripeHttpCtx {
  db: StateDb & MirrorDb
}

const CHARGE = /^(ch|py)_[A-Za-z0-9_]+$/
const DAY = 86_400_000
const WINDOW_DAYS = 35
const PAID_DAYS = 3
const MAX_INVOICES = 20
const MAX_REFUNDS = 100

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === "string" && v ? new Date(v).toISOString() : null
const minor = (v: unknown): string => String(v ?? "0")

export async function refundsForCharge(params: Obj | undefined, ctx: MoneyReadCtx) {
  const chargeId = typeof params?.chargeId === "string" ? params.chargeId.trim() : ""
  if (!CHARGE.test(chargeId)) {
    return refuseTool("charge_id_invalid", `"${chargeId}" is not a Stripe charge id (ch_...), so no refund was read.`)
  }
  const hold = await moneyActionHold(ctx.db)
  if (hold) return refuseTool(hold.error.code ?? "stripe_unavailable", `Stripe cannot be asked about charge ${chargeId}: ${hold.error.message}`, { retryable: true })
  let charge: Obj
  let refunds: Obj[]
  try {
    charge = await stripeFetch<Obj>(ctx, `/v1/charges/${encodeURIComponent(chargeId)}`, {}, { maxRetries: 1 })
    refunds = await listRefunds(ctx, chargeId)
  } catch (err) {
    return refuseTool(
      "stripe_unavailable",
      `Stripe did not list the refunds of charge ${chargeId} (${err instanceof Error ? err.message : String(err)}). Nothing changed; ask again later.`,
      { retryable: true },
    )
  }
  const invoiceId = await invoiceOfCharge(ctx, charge).catch(() => null)
  const items = refunds.filter((r) => typeof r.id === "string").map(refundItem)
  return {
    charge_id: chargeId,
    invoice_id: invoiceId,
    document_ref: stripeDocumentRef({ id: chargeId, invoice: invoiceId }),
    refunds: items,
    summary:
      items.length === 0
        ? `Charge ${chargeId} has no refund in Stripe.`
        : `Charge ${chargeId} has ${items.length} refund(s) in Stripe: ${items.map((r) => `${r.id} ${r.amount_minor} ${r.status}`).join(", ")}.`,
  }
}

export async function reconcileCandidates(_params: Obj | undefined, ctx: MoneyReadCtx) {
  const hold = await moneyActionHold(ctx.db)
  if (hold) return refuseTool(hold.error.code ?? "stripe_unavailable", `No reconcile candidates were read: ${hold.error.message}`, { retryable: true })
  const now = Date.now()
  const since = now - WINDOW_DAYS * DAY

  const invoiceRows = (await ctx.db.findMany("stripe_invoices", {
    orderBy: { finalized_at: "desc" },
    limit: 500,
  })) as Obj[]
  const recent = invoiceRows.filter((r) => {
    const f = iso(r.finalized_at)
    return f !== null && Date.parse(f) >= since && (r.status === "open" || r.status === "paid")
  })
  const missing = recent
    .filter((r) => !r.liaison_document_id && r.issuer !== "before_connection" && r.issuer !== "stripe")
    .slice(0, MAX_INVOICES)
  const invoices: Obj[] = []
  let unread = 0
  for (const r of missing) {
    try {
      const obj = await stripeFetch<Obj>(ctx, `/v1/invoices/${encodeURIComponent(String(r.stripe_id))}`, {}, { maxRetries: 1 })
      invoices.push(await invoiceEventPayload(ctx, r, obj, newTally(), new Date(now).toISOString(), false))
    } catch {
      // Read again on the next run.
      unread++
    }
  }
  for (const r of recent) {
    const paid = iso(r.paid_at)
    if (r.liaison_document_id && r.status === "paid" && paid && Date.parse(paid) >= now - PAID_DAYS * DAY) {
      invoices.push({
        stripe_invoice_id: r.stripe_id,
        status: "paid",
        paid_at: paid,
        total_minor: minor(r.total_minor),
        currency: r.currency,
      })
    }
  }

  const refundRows = (await ctx.db.findMany("stripe_refunds", {
    where: { status: "succeeded", liaison_document_id: null },
    orderBy: { created_at_stripe: "desc" },
    limit: MAX_REFUNDS,
  })) as Obj[]
  const refunds: Obj[] = []
  const invoiceByCharge = new Map<string, string | null>()
  for (const r of refundRows) {
    const created = iso(r.created_at_stripe)
    if (created && Date.parse(created) < since) continue
    const chargeId = String(r.payment_id ?? "")
    if (!chargeId) continue
    if (!invoiceByCharge.has(chargeId)) {
      const [p] = (await ctx.db.findMany("stripe_payments", { where: { stripe_id: chargeId }, limit: 1 })) as Obj[]
      invoiceByCharge.set(chargeId, typeof p?.invoice_id === "string" && p.invoice_id ? p.invoice_id : null)
    }
    const invoiceId = invoiceByCharge.get(chargeId) ?? null
    refunds.push({
      refund_id: String(r.stripe_id),
      charge_id: chargeId,
      invoice_id: invoiceId,
      document_ref: stripeDocumentRef({ id: chargeId, invoice: invoiceId }),
      amount_minor: minor(r.amount_minor),
      currency: r.currency ?? null,
      status: "succeeded",
    })
  }
  return {
    invoices,
    refunds,
    summary: `${missing.length} Stripe invoice(s) with no Liaison document${unread ? ` (${unread} not read from Stripe this time)` : ""}, ${invoices.length - (missing.length - unread)} paid invoice(s) to check, ${refunds.length} succeeded refund(s) with no credit note recorded.`,
  }
}
