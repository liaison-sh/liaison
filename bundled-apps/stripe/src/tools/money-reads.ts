// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The reads invoicing makes of the Stripe app, hidden from the agent:
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
//   waiting_state        customers and invoices by id as the mirror holds them now, for the
//                        invoices invoicing keeps parked; Stripe is not asked.
//   invoice_payload      one Stripe invoice read again (`GET /v1/invoices/{id}`), in the
//                        `invoice:finalized` shape: its status, amounts and dates as Stripe
//                        answers them (an event may have been missed), the buyer as the mirror
//                        holds it, and the charges known to have paid it.
//   payment_payload      one charge read again (`GET /v1/charges/{id}`), in the
//                        `payment:unmatched` shape, with its status and its invoice, if any.
import { refuseTool } from "@liaison/app-sdk/errors"
import { type StripeHttpCtx, stripeFetch } from "../http"
import { invoiceRow, type MirrorDb, newTally } from "../mirror"
import {
  buyerOf,
  chargedAt,
  customerOf,
  invoiceEventPayload,
  invoiceOfCharge,
  listRefunds,
  refundItem,
  stripeDocumentRef,
  unmatchedPayload,
} from "../money-events"
import { moneyActionHold, type StateDb } from "../states"

type Obj = Record<string, unknown>

export interface MoneyReadCtx extends StripeHttpCtx {
  db: StateDb & MirrorDb
}

const CHARGE = /^(ch|py)_[A-Za-z0-9_]+$/
const INVOICE = /^in_[A-Za-z0-9_]+$/
const DAY = 86_400_000
const WINDOW_DAYS = 35
const PAID_DAYS = 3
const MAX_INVOICES = 20
const MAX_REFUNDS = 100
const MAX_PAID = 100
const PAGE = 200

const iso = (v: unknown): string | null =>
  v instanceof Date
    ? v.toISOString()
    : typeof v === "string" && v
      ? new Date(v).toISOString()
      : null
const minor = (v: unknown): string => String(v ?? "0")

export async function refundsForCharge(params: Obj | undefined, ctx: MoneyReadCtx) {
  const chargeId = typeof params?.chargeId === "string" ? params.chargeId.trim() : ""
  if (!CHARGE.test(chargeId)) {
    return refuseTool(
      "charge_id_invalid",
      `"${chargeId}" is not a Stripe charge id (ch_...), so no refund was read.`,
    )
  }
  const hold = await moneyActionHold(ctx.db)
  if (hold)
    return refuseTool(
      hold.error.code ?? "stripe_unavailable",
      `Stripe cannot be asked about charge ${chargeId}: ${hold.error.message}`,
      { retryable: true },
    )
  let charge: Obj
  let refunds: Obj[]
  try {
    charge = await stripeFetch<Obj>(ctx, `/v1/charges/${encodeURIComponent(chargeId)}`, {})
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

/** Rows of `entity` matching `where`, newest first by `order`, read a page at a time until `keep`
 *  has taken `max` of them or a row falls before `since`. Rows invoicing already decided are
 *  filtered out by the query, so they never take a place. */
async function newestWhere(
  ctx: MoneyReadCtx,
  entity: string,
  where: Obj,
  order: string,
  since: number,
  max: number,
  keep: (r: Obj) => boolean,
): Promise<Obj[]> {
  const out: Obj[] = []
  for (let offset = 0; out.length < max; offset += PAGE) {
    const page = (await ctx.db.findMany(entity, {
      where,
      orderBy: { [order]: "desc" },
      limit: PAGE,
      offset,
    })) as Obj[]
    for (const r of page) {
      const at = iso(r[order])
      if (at === null) continue
      if (Date.parse(at) < since) return out
      if (keep(r)) out.push(r)
      if (out.length >= max) return out
    }
    if (page.length < PAGE) return out
  }
  return out
}

const ids = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []

export async function waitingState(params: Obj | undefined, ctx: MoneyReadCtx) {
  const hold = await moneyActionHold(ctx.db)
  if (hold)
    return refuseTool(
      hold.error.code ?? "stripe_unavailable",
      `The waiting invoices' customers were not read: ${hold.error.message}`,
      { retryable: true },
    )
  const customers = ids(params?.customers)
  const invoices = ids(params?.invoices)
  const customerRows =
    customers.length === 0
      ? []
      : ((await ctx.db.findMany("stripe_customers", {
          where: { stripe_id: { in: customers }, deleted_at: null },
          limit: customers.length,
        })) as Obj[])
  const invoiceRows =
    invoices.length === 0
      ? []
      : ((await ctx.db.findMany("stripe_invoices", {
          where: { stripe_id: { in: invoices } },
          limit: invoices.length,
        })) as Obj[])
  return {
    buyers: customerRows.map((r) => ({
      customer_id: String(r.stripe_id),
      customer: buyerOf(r),
    })),
    invoices: invoiceRows.map((r) => ({
      stripe_invoice_id: String(r.stripe_id),
      status: typeof r.status === "string" ? r.status : null,
    })),
    summary: `${customerRows.length} of ${customers.length} customer(s) and ${invoiceRows.length} of ${invoices.length} invoice(s) read from the Stripe mirror.`,
  }
}

/** A mirror row with what Stripe answers of the invoice now: an event may have been missed. */
function asStripeAnswers(row: Obj, obj: Obj): Obj {
  const now = invoiceRow(obj, newTally())
  const said: Obj = {}
  for (const [field, key] of [
    ["status", "status"],
    ["total_minor", "total"],
    ["amount_paid_minor", "amount_paid"],
    ["currency", "currency"],
    ["next_payment_attempt", "next_payment_attempt"],
  ] as const)
    if (obj[key] !== undefined) said[field] = now[field]
  if (Array.isArray(obj.total_taxes)) said.tax_minor = now.tax_minor
  if (obj.status_transitions) {
    // A finalization never moves: the mirror's stands.
    said.finalized_at = row.finalized_at ?? now.finalized_at
    if (said.status === "paid") said.paid_at = now.paid_at ?? row.paid_at
  }
  return { ...row, ...said }
}

const invoiceNow = (ctx: MoneyReadCtx, row: Obj, obj: Obj, now: string): Promise<Obj> =>
  invoiceEventPayload(ctx, asStripeAnswers(row, obj), obj, newTally(), now, false)

export async function reconcileCandidates(params: Obj | undefined, ctx: MoneyReadCtx) {
  const hold = await moneyActionHold(ctx.db)
  if (hold)
    return refuseTool(
      hold.error.code ?? "stripe_unavailable",
      `No reconcile candidates were read: ${hold.error.message}`,
      { retryable: true },
    )
  const now = Date.now()
  const since = now - WINDOW_DAYS * DAY
  // Invoices and refunds invoicing holds parked: its retry sweep re-drives them, not this job.
  const waiting = new Set(ids(params?.waiting))

  // Invoicing decides each finalized invoice once: a document (linked), or Stripe's own invoice
  // stands (issuer recorded). Only the undecided ones are candidates, and a zero total never is.
  const missing = await newestWhere(
    ctx,
    "stripe_invoices",
    {
      liaison_document_id: null,
      issuer: { in: ["liaison", "undecided"] },
      status: { in: ["open", "paid"] },
    },
    "finalized_at",
    since,
    MAX_INVOICES,
    (r) => minor(r.total_minor) !== "0" && !waiting.has(String(r.stripe_id)),
  )
  const invoices: Obj[] = []
  let unread = 0
  for (const r of missing) {
    try {
      const obj = await stripeFetch<Obj>(
        ctx,
        `/v1/invoices/${encodeURIComponent(String(r.stripe_id))}`,
        {},
      )
      invoices.push(await invoiceNow(ctx, r, obj, new Date(now).toISOString()))
    } catch {
      // Read again on the next run.
      unread++
    }
  }
  const paidRows = await newestWhere(
    ctx,
    "stripe_invoices",
    { status: "paid" },
    "paid_at",
    now - PAID_DAYS * DAY,
    MAX_PAID,
    (r) => typeof r.liaison_document_id === "string" && r.liaison_document_id !== "",
  )
  for (const r of paidRows) {
    invoices.push({
      stripe_invoice_id: r.stripe_id,
      status: "paid",
      paid_at: iso(r.paid_at),
      total_minor: minor(r.total_minor),
      currency: r.currency,
    })
  }

  const refundRows = await newestWhere(
    ctx,
    "stripe_refunds",
    { status: "succeeded", liaison_document_id: null, liaison_skipped: null },
    "created_at_stripe",
    since,
    MAX_REFUNDS,
    (r) => !waiting.has(String(r.stripe_id)) && !!r.payment_id,
  )
  const refunds: Obj[] = []
  const paymentByCharge = new Map<string, { invoice: string | null; charged_at: string | null }>()
  for (const r of refundRows) {
    const chargeId = String(r.payment_id)
    if (!paymentByCharge.has(chargeId)) {
      const [p] = (await ctx.db.findMany("stripe_payments", {
        where: { stripe_id: chargeId },
        limit: 1,
      })) as Obj[]
      paymentByCharge.set(chargeId, {
        invoice: typeof p?.invoice_id === "string" && p.invoice_id ? p.invoice_id : null,
        charged_at: chargedAt(p),
      })
    }
    const payment = paymentByCharge.get(chargeId)
    const invoiceId = payment?.invoice ?? null
    refunds.push({
      refund_id: String(r.stripe_id),
      charge_id: chargeId,
      invoice_id: invoiceId,
      document_ref: stripeDocumentRef({ id: chargeId, invoice: invoiceId }),
      amount_minor: minor(r.amount_minor),
      currency: r.currency ?? null,
      status: "succeeded",
      charged_at: payment?.charged_at ?? null,
    })
  }
  return {
    invoices,
    refunds,
    summary: `${missing.length} Stripe invoice(s) with no Liaison document${unread ? ` (${unread} not read from Stripe this time)` : ""}, ${paidRows.length} paid invoice(s) to check, ${refunds.length} succeeded refund(s) with no credit note recorded.`,
  }
}

export async function invoicePayload(params: Obj | undefined, ctx: MoneyReadCtx) {
  const id = typeof params?.stripeInvoiceId === "string" ? params.stripeInvoiceId.trim() : ""
  if (!INVOICE.test(id)) {
    return refuseTool(
      "invoice_id_invalid",
      `"${id}" is not a Stripe invoice id (in_...), so no invoice was read.`,
    )
  }
  const hold = await moneyActionHold(ctx.db)
  if (hold)
    return refuseTool(
      hold.error.code ?? "stripe_unavailable",
      `Stripe cannot be asked about invoice ${id}: ${hold.error.message}`,
      { retryable: true },
    )
  const [row] = (await ctx.db.findMany("stripe_invoices", {
    where: { stripe_id: id },
    limit: 1,
  })) as Obj[]
  if (!row) {
    return refuseTool(
      "invoice_not_mirrored",
      `Invoice ${id} is not in the Stripe mirror yet, so it was not read. It is read again on the next run.`,
      { retryable: true },
    )
  }
  try {
    const obj = await stripeFetch<Obj>(ctx, `/v1/invoices/${encodeURIComponent(id)}`, {})
    return { invoice: await invoiceNow(ctx, row, obj, new Date().toISOString()) }
  } catch (err) {
    return refuseTool(
      "stripe_unavailable",
      `Stripe did not answer for invoice ${id} (${err instanceof Error ? err.message : String(err)}). Nothing changed; it is read again on the next run.`,
      { retryable: true },
    )
  }
}

export async function paymentPayload(params: Obj | undefined, ctx: MoneyReadCtx) {
  const id = typeof params?.chargeId === "string" ? params.chargeId.trim() : ""
  if (!CHARGE.test(id)) {
    return refuseTool(
      "charge_id_invalid",
      `"${id}" is not a Stripe charge id (ch_...), so no payment was read.`,
    )
  }
  const hold = await moneyActionHold(ctx.db)
  if (hold)
    return refuseTool(
      hold.error.code ?? "stripe_unavailable",
      `Stripe cannot be asked about charge ${id}: ${hold.error.message}`,
      { retryable: true },
    )
  try {
    const charge = await stripeFetch<Obj>(ctx, `/v1/charges/${encodeURIComponent(id)}`, {})
    const invoiceId = await invoiceOfCharge(ctx, charge)
    const customerId =
      typeof charge.customer === "string"
        ? charge.customer
        : (((charge.customer as Obj | null)?.id as string | undefined) ?? null)
    const customer = await customerOf(ctx, customerId, new Date().toISOString(), false)
    return {
      payment: {
        ...unmatchedPayload({ ...charge, id }, customer, newTally()),
        invoice_id: invoiceId,
        document_ref: stripeDocumentRef({ id, invoice: invoiceId }),
        status: typeof charge.status === "string" ? charge.status : null,
      },
    }
  } catch (err) {
    return refuseTool(
      "stripe_unavailable",
      `Stripe did not answer for charge ${id} (${err instanceof Error ? err.message : String(err)}). Nothing changed; ask again later.`,
      { retryable: true },
    )
  }
}
