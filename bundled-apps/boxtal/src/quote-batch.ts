// SPDX-License-Identifier: FSL-1.1-ALv2
//
// quote_batch (a.k.a. shipping-cost rollup) — the WHOLE-WALL pricing tool. The
// per-route `quote` is one carrier-rate call per route and there is no in-app
// way to price many routes at once or sum projected shipping spend, so before
// this tool an agent had to quote each order one-by-one inside the 10-step/60s
// runtime budget and HAND-total a bounded sample (the BL-270 capability gap).
//
// quote_batch closes that gap with a SERVER-SIDE FAN-OUT: given a set of orders
// to price (explicit invoice/document refs, OR — by default — the To-prepare
// worklist of shippable invoices), it opens a draft + quotes EACH order, filters
// each order's offers to those whose ETA meets the `max_eta_business_days`
// constraint, picks the CHEAPEST within-ETA offer per order, and SUMS the
// selected prices into one authoritative aggregate projected spend — all in a
// single tool call.
//
// READ-ONLY / UNGATED: it only QUOTES + totals; it creates NOTHING. The per-order
// label BUY (create_shipment) stays a SEPARATE gated per-order approval — this
// tool never stages or buys a label. A quote is a point-in-time estimate.
//
// HONEST BOUNDING: the fan-out is capped (`limit`, default 25) so a genuinely huge
// wall is reported as "priced N of M" via `covered_count`/`total_count` (never
// silently truncated). When `covered_count < total_count` the caller MUST disclose
// the bound (more orders remain to price in another pass).

import { quote } from "./shipment"
import { toPrepareList, type ToPrepareRow } from "./queues"
import type { CotationParty, Offer } from "./lib/boxtal-v1-client"
import type { BoxtalToolCtx } from "./ctx"

/** A placeholder party for a draft-driven quote: `quote` overwrites `from` (org
 *  ship-from) and `to` (draft recipient) entirely, so these blanks never reach
 *  the carrier — they only satisfy the CotationInput shape. */
const EMPTY_PARTY: CotationParty = { country: "", postalCode: "", city: "", type: "particulier" }

/**
 * Default hard cap on how many orders one batch call prices. Sized so a NORMAL
 * batch (a day's wall of orders) is priced AUTHORITATIVELY in ONE call — the whole
 * point of the rollup. An earlier default of 8 split a 9-order wall into "priced 8
 * of 9", forcing a second pass for the 9th order where the agent fell back to a
 * single per-route quote that returned the WRONG (domestic) offers and fabricated
 * the total (l715 gate run-1). The cap still exists so a genuinely huge wall is
 * reported priced N of M (covered_count/total_count) rather than running unbounded,
 * but it must comfortably exceed a typical wall so the authoritative total is one
 * call, not a stitched-together multi-pass. The caller can still pass a smaller
 * `limit` to deliberately bound a call.
 */
const DEFAULT_LIMIT = 25
/** Default ETA constraint when the caller omits it (the scenario's "within 5
 *  business days"). */
const DEFAULT_MAX_ETA_BUSINESS_DAYS = 5

export interface QuoteBatchInput {
  /** Explicit invoice/document refs to price. When omitted, the batch prices the
   *  To-prepare worklist (shippable issued invoices with no live shipment yet). */
  order_refs?: string[]
  /** Pick the cheapest offer whose ETA (collection→delivery) is within this many
   *  BUSINESS days (Mon–Fri). Defaults to 5. */
  max_eta_business_days?: number
  /** Optional ISO-3166 alpha-2 destination filter (e.g. "US"): only orders whose
   *  recipient country matches are priced. Applies only to the default
   *  to-prepare-worklist source (explicit `order_refs` are priced as given). */
  destination_country?: string
  /** Hard cap on how many orders this call prices (default 25). Orders beyond the
   *  cap are reported as un-priced via `covered_count`/`total_count`. */
  limit?: number
}

/** The cheapest within-ETA offer chosen for one order, or a flag that no offer
 *  met the ETA. Prices are in MAJOR currency units (EUR), as the v1 quote returns
 *  them; `price_minor` is the same value in minor units (the money convention). */
export interface QuoteBatchSelection {
  carrier: string
  offer_code: string
  /** Carrier cost excl. tax, MAJOR units (e.g. 48.9 EUR). */
  price_ht: number
  /** Carrier cost excl. tax, MINOR units (e.g. 4890), per the money convention. */
  price_minor: number
  currency: string
  collection_date: string | null
  delivery_date: string | null
  /** Business days (Mon–Fri) from collection to delivery for the chosen offer. */
  eta_business_days: number | null
}

export interface QuoteBatchRow {
  /** The order's invoice/document ref (the draft id). */
  order_ref: string
  recipient: string | null
  destination_country: string | null
  /** The cheapest within-ETA offer for this order; null when none met the ETA
   *  (then `no_offer_within_eta` is true and `reason` explains). */
  selected: QuoteBatchSelection | null
  /** True when NO offer met `max_eta_business_days` (the order is flagged, NOT
   *  silently summed at the cheapest-overall price). */
  no_offer_within_eta: boolean
  /** How many carrier offers the quote returned for this route (all ETAs). */
  offers_considered: number
  /** Set when the order could not be priced (no offers at all, quote error, or
   *  no offer within the ETA) — a grounded reason, never a fabricated price. */
  reason?: string
}

export interface QuoteBatchResult {
  rows: QuoteBatchRow[]
  /** The authoritative aggregate over the orders that were PRICED with a within-ETA
   *  offer. */
  aggregate: {
    /** Sum of the selected per-order prices, MINOR units (the money convention). */
    total_projected_spend_minor: number
    /** The same total in MAJOR currency units, for display. */
    total_projected_spend: number
    currency: string
    /** Orders this call actually priced (drafted + quoted), within `limit`. */
    covered_count: number
    /** Total orders in scope (the whole wall) — `covered_count < total_count`
     *  means the batch was bounded and the rest still need pricing. */
    total_count: number
    /** Of the covered orders, how many had a within-ETA offer that fed the total. */
    priced_count: number
    /** Of the covered orders, how many had NO offer within the ETA (flagged, not
     *  summed). */
    no_offer_count: number
    /** The ETA constraint applied (business days). */
    max_eta_business_days: number
  }
  /** A standing honesty note: a quote is a point-in-time estimate and each label
   *  buy is a SEPARATE gated create_shipment — this tool prices, it never ships. */
  notice: string
}

/**
 * Count BUSINESS days (Mon–Fri) from a collection date to a delivery date,
 * inclusive of neither endpoint's weekend-ness beyond the count of weekdays
 * strictly after collection up to and including delivery. Returns null when
 * either date is missing/unparseable. The count excludes Saturdays and Sundays
 * so a delivery N CALENDAR days out can be fewer business days — the exact ETA
 * arithmetic the cheapest-within-deadline pick depends on. (No public-holiday
 * calendar is modelled — weekends only, matching the quote tool's guidance.)
 */
export function businessDaysBetween(collection: string | null, delivery: string | null): number | null {
  if (!collection || !delivery) return null
  const start = new Date(`${collection}T00:00:00Z`)
  const end = new Date(`${delivery}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
  if (end.getTime() < start.getTime()) return null
  let count = 0
  const cursor = new Date(start.getTime())
  // Walk one calendar day at a time from the day AFTER collection up to and
  // including delivery, tallying only weekdays.
  while (cursor.getTime() < end.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    const day = cursor.getUTCDay() // 0=Sun, 6=Sat
    if (day !== 0 && day !== 6) count += 1
  }
  return count
}

/** Round a major-unit EUR amount to integer minor units (cents). Guards float
 *  drift (48.9 → 4890, not 4889) by rounding rather than truncating. */
function toMinor(major: number): number {
  return Math.round(major * 100)
}

/**
 * From a route's offers and the ETA constraint, pick the CHEAPEST offer whose ETA
 * meets the deadline. Returns the selection, or null when no offer is within the
 * ETA (the order is then flagged `no_offer_within_eta`, NEVER summed at a
 * cheaper-but-slower price). Cheapest is by `price_ht` (the carrier cost the
 * quote tool itself ranks on); ties broken by the faster ETA.
 */
export function pickCheapestWithinEta(
  offers: Offer[],
  maxEtaBusinessDays: number,
): QuoteBatchSelection | null {
  let best: { offer: Offer; eta: number } | null = null
  for (const offer of offers) {
    const eta = businessDaysBetween(offer.collection_date, offer.delivery_date)
    // Reject an offer with no computable ETA OR one that exceeds the deadline —
    // the ABSOLUTE-cheapest-but-too-slow offer must NOT win (the documented trap).
    if (eta == null || eta > maxEtaBusinessDays) continue
    if (
      best == null ||
      offer.price_ht < best.offer.price_ht ||
      (offer.price_ht === best.offer.price_ht && eta < best.eta)
    ) {
      best = { offer, eta }
    }
  }
  if (best == null) return null
  return {
    carrier: best.offer.carrier,
    offer_code: best.offer.offer_code,
    price_ht: best.offer.price_ht,
    price_minor: toMinor(best.offer.price_ht),
    currency: best.offer.currency,
    collection_date: best.offer.collection_date,
    delivery_date: best.offer.delivery_date,
    eta_business_days: best.eta,
  }
}

/** A candidate order to price: its draft id (= invoice/document ref) + display
 *  fields. */
interface BatchCandidate {
  order_ref: string
  recipient: string | null
  destination_country: string | null
}

/**
 * Resolve the candidate orders for a batch. Explicit `order_refs` are used as
 * given (no display join — the per-order quote backfills recipient/country from
 * the draft). Otherwise the candidates are the To-prepare worklist's
 * ready-to-prepare rows (a needs_fix invoice cannot be drafted/quoted), optionally
 * filtered to a destination country.
 */
async function resolveCandidates(
  ctx: BoxtalToolCtx,
  input: QuoteBatchInput,
): Promise<BatchCandidate[]> {
  if (input.order_refs && input.order_refs.length > 0) {
    return input.order_refs.map((ref) => ({
      order_ref: ref,
      recipient: null,
      destination_country: null,
    }))
  }
  const { rows } = await toPrepareList(ctx)
  const wantCountry = input.destination_country?.trim().toUpperCase()
  return rows
    .filter((r: ToPrepareRow) => r.prep_status === "ready_to_prepare")
    // A row with no anchor document has nothing to quote against (its draft_id IS the anchor).
    .filter((r) => r.id != null)
    .filter((r) => !wantCountry || (r.destination ?? "").trim().toUpperCase() === wantCountry)
    .map((r) => ({
      order_ref: r.id!,
      recipient: r.customer ?? null,
      destination_country: r.destination ?? null,
    }))
}

/**
 * Price a whole batch of orders in one call: fan out over the candidates (bounded
 * by `limit`), quote each, pick the cheapest within-ETA offer, and sum the
 * selected prices into one authoritative projected spend. READ-ONLY — creates
 * nothing. `covered_count`/`total_count` report the honest bound when the wall
 * exceeds the cap.
 */
export async function quoteBatch(ctx: BoxtalToolCtx, input: QuoteBatchInput): Promise<QuoteBatchResult> {
  const maxEta = input.max_eta_business_days ?? DEFAULT_MAX_ETA_BUSINESS_DAYS
  const limit = Math.max(1, input.limit ?? DEFAULT_LIMIT)
  const candidates = await resolveCandidates(ctx, input)
  const totalCount = candidates.length
  const toPrice = candidates.slice(0, limit)

  const rows: QuoteBatchRow[] = []
  let totalMinor = 0
  // The aggregate currency is fixed by the FIRST priced order. Today every order is
  // EUR (FR ship-from), but if a later order's selected offer comes back in a
  // DIFFERENT currency we must NOT add its minor units onto a different-currency total
  // (silently summing cents across currencies + last-writer-wins stamping the wrong
  // code). Instead that order is flagged per-row (the same reason/skip mechanism a
  // no-offer order uses) and excluded from the total — never silently summed.
  let aggregateCurrency: string | null = null
  let pricedCount = 0
  let noOfferCount = 0

  for (const cand of toPrice) {
    let offers: Offer[] = []
    let quoteError: string | undefined
    try {
      // Quote the draft directly: `quote` defaults the route (`to`), parcels and
      // content from the draft (enrichFromDraft) and the ship-from from org config
      // (enrichCotation), so the empty `from`/`to`/`parcels` here are placeholders
      // the draft fully overwrites — the offers come back route-correct (FR→US =
      // an EXPORT, international carriers).
      const result = await quote(ctx, {
        draft_id: cand.order_ref,
        from: EMPTY_PARTY,
        to: EMPTY_PARTY,
        parcels: [],
      })
      offers = result.offers
      if (result.error) quoteError = result.error.message
    } catch (err) {
      quoteError = err instanceof Error ? err.message : String(err)
    }

    if (offers.length === 0) {
      rows.push({
        order_ref: cand.order_ref,
        recipient: cand.recipient,
        destination_country: cand.destination_country,
        selected: null,
        no_offer_within_eta: true,
        offers_considered: 0,
        reason: quoteError ? `quote failed: ${quoteError}` : "no carrier offers for this route",
      })
      noOfferCount += 1
      continue
    }

    const selected = pickCheapestWithinEta(offers, maxEta)
    if (selected == null) {
      rows.push({
        order_ref: cand.order_ref,
        recipient: cand.recipient,
        destination_country: cand.destination_country,
        selected: null,
        no_offer_within_eta: true,
        offers_considered: offers.length,
        reason: `no offer arrives within ${maxEta} business days`,
      })
      noOfferCount += 1
      continue
    }

    // Fix the aggregate currency to the first priced order's currency. A later order
    // whose selected offer is in a DIFFERENT currency is NOT summed onto the running
    // (different-currency) total — flag it per-row and skip it, so the aggregate stays
    // a single-currency authoritative sum rather than a meaningless cross-currency
    // minor-unit blend stamped with whichever currency happened to come last.
    const offerCurrency: string = selected.currency || aggregateCurrency || "EUR"
    if (aggregateCurrency == null) {
      aggregateCurrency = offerCurrency
    } else if (offerCurrency !== aggregateCurrency) {
      rows.push({
        order_ref: cand.order_ref,
        recipient: cand.recipient,
        destination_country: cand.destination_country,
        selected,
        no_offer_within_eta: false,
        offers_considered: offers.length,
        reason:
          `selected offer is priced in ${offerCurrency} but the batch total is in ` +
          `${aggregateCurrency}; excluded from the aggregate to avoid summing across ` +
          `currencies (price it in a separate single-currency pass)`,
      })
      continue
    }

    totalMinor += selected.price_minor
    pricedCount += 1
    rows.push({
      order_ref: cand.order_ref,
      recipient: cand.recipient,
      destination_country: cand.destination_country,
      selected,
      no_offer_within_eta: false,
      offers_considered: offers.length,
    })
  }

  return {
    rows,
    aggregate: {
      total_projected_spend_minor: totalMinor,
      total_projected_spend: totalMinor / 100,
      currency: aggregateCurrency ?? "EUR",
      covered_count: toPrice.length,
      total_count: totalCount,
      priced_count: pricedCount,
      no_offer_count: noOfferCount,
      max_eta_business_days: maxEta,
    },
    notice:
      "Projected shipping spend is a point-in-time quote estimate, not a booked cost. " +
      "This tool prices and totals only: it creates no shipments. Buying each label is a " +
      "separate, gated create_shipment that needs per-order approval." +
      (toPrice.length < totalCount
        ? ` Priced ${toPrice.length} of ${totalCount} orders in scope; ${totalCount - toPrice.length} remain to price in another pass.`
        : ""),
  }
}
