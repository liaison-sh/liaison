// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Whether a Shopify order may still be shipped.
//
// Prod, 2026-08-05: order #3320 was FULLY REFUNDED (1064 USD refunded, its
// fulfillment CANCELLED) and was sitting in the To-prepare worklist. Nothing in
// the queue consulted the order's financial or cancellation state — it filters
// on channel, shippable lines and absence of a live shipment. The only reason
// #3320 was not preparable is that its refund had zeroed the order totals, which
// made the customs FX lookup fail and blocked the row for an unrelated reason.
// Fixing that FX bug alone would have turned a refunded order into "ready to
// prepare", which is strictly worse than the block it replaced.
//
// So this is the invariant, stated once and enforced in two places: the queue
// (so it is never offered) and `create_shipment` (so it cannot be bought even
// if reached directly, by search, by a stale UI, or by the agent). A queue
// filter alone is presentation; the create-time guard is the actual rule.
//
// Deliberately conservative: ANY refund disqualifies, not just a full one. A
// partial refund on a physical-goods order usually means part of it is not
// being sent, and shipping the whole thing is the expensive mistake. An
// operator who genuinely wants to ship a partially-refunded order can say so
// explicitly; we do not infer that intent.

/** Shopify `displayFinancialStatus` values that mean money went back or never landed. */
const REFUNDED_STATUSES = new Set(["REFUNDED", "PARTIALLY_REFUNDED", "VOIDED", "EXPIRED"])

export interface OrderShippabilityFacts {
  /** Shopify `displayFinancialStatus`, e.g. PAID / REFUNDED / PARTIALLY_REFUNDED. */
  financial_status?: string | null
  /** Shopify `cancelledAt` — null/absent on a live order. */
  cancelled_at?: string | null
}

export type UnshippableReason = "order_cancelled" | "order_refunded"

/**
 * Why this order must not be shipped, or null when it may be.
 *
 * Returns null when the facts are ABSENT (an order we could not read, or a row
 * cached before these fields existed). Blocking on missing data would empty the
 * whole queue on a transient Shopify read failure; the create-time guard
 * re-reads live, so an unknown here is re-checked before any money is spent.
 */
export function unshippableReason(facts: OrderShippabilityFacts | null | undefined): UnshippableReason | null {
  if (!facts) return null
  if (typeof facts.cancelled_at === "string" && facts.cancelled_at.trim() !== "") {
    return "order_cancelled"
  }
  const status = facts.financial_status?.trim().toUpperCase()
  if (status && REFUNDED_STATUSES.has(status)) return "order_refunded"
  return null
}

/** Convenience predicate for queue filtering. */
export function isOrderShippable(facts: OrderShippabilityFacts | null | undefined): boolean {
  return unshippableReason(facts) === null
}

/** Operator-facing sentence. No dash punctuation (house style). */
export function unshippableMessage(reason: UnshippableReason, orderName?: string | null): string {
  const which = orderName ? `Order ${orderName}` : "This order"
  return reason === "order_cancelled"
    ? `${which} was cancelled in Shopify, so it cannot be shipped. Nothing was bought.`
    : `${which} was refunded in Shopify, so it cannot be shipped. Nothing was bought.`
}
