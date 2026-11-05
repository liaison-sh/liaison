// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Prep-dashboard offer selection resolution. Shared by prep.ts (which surfaces the
// selected offer on each worklist row) and shipment.ts's create_shipment (which
// stages the operator's chosen offer instead of the cheapest). Deliberately depends
// on NEITHER prep.ts nor shipment.ts (it only reads the prep_state / prep_quote
// tables through the generic db bridge), so it can be imported by both without a
// module cycle.
//
// The operator picks an offer per row via prep_select_offer, persisting its
// offer_code on prep_state. That choice DRIVES the eventual create_shipment: staging
// resolves to the chosen offer, falling back to the cached cheapest (offers[0], stored
// cheapest-first) when the operator has not chosen one. The choice is invalidated the
// same way the quote is — see pickSelectedOffer's `stale` gate for the row view; at
// stage time create_shipment's live re-quote is the backstop that rejects a chosen
// offer that is no longer available for the route.

/** The subset of a cached prep_quote offer this module reads. */
interface StoredOffer {
  offer_code: string
  price_ht_minor?: number
  price_ttc_minor?: number | null
  currency?: string | null
  is_pickup_point?: boolean
}

/** Minimal db surface (the generic bridge's exact-match `findMany`). */
interface SelectionDb {
  findMany(entity: string, opts?: { where?: Record<string, unknown>; limit?: number }): Promise<unknown[]>
}
interface SelectionCtx {
  db: SelectionDb
}

/**
 * Resolve the persisted selection against a row's CURRENT cached offers. Returns the
 * chosen offer, or null when there is no selection, the selection no longer matches a
 * cached offer (e.g. a re-quote replaced it), OR the cached quote is stale (an edit
 * happened since the quote — the selection is invalidated exactly like the quote it
 * was made against). Pure; the row view (prep_list) uses it to show the operator's
 * current effective offer without a DB read.
 */
export function pickSelectedOffer<T extends { offer_code: string }>(
  offers: readonly T[],
  selectedCode: string | null | undefined,
  stale: boolean,
): T | null {
  if (stale || !selectedCode) return null
  return offers.find((o) => o.offer_code === selectedCode) ?? null
}

export interface ResolvedStageOffer {
  offer_code: string
  /** TTC price of the chosen offer in minor units, when the cache carries it. */
  price_ttc_minor: number | null
  currency: string | null
  /** True when the chosen offer is a relay / pickup-point service — create_shipment
   *  ORs this into its re-quote's include_pickup_point so a deliberately-chosen relay
   *  offer survives the org exclusion policy at validation time. */
  is_pickup_point: boolean
  /** Whether the resolved offer came from the operator's selection or the cheapest fallback. */
  source: "selected" | "cheapest"
}

/**
 * The offer create_shipment should stage for a draft when the caller omits an explicit
 * offer_code: the operator's persisted selection when it still matches a cached offer,
 * else the cached cheapest (offers[0]). Null when the row has no cached quote at all
 * (nothing to stage — the caller then errors asking to quote or pass an offer_code).
 * Does NOT gate on staleness: create_shipment re-quotes live and validates the code, so
 * a stale-but-still-available cached offer stages fine and an unavailable one is rejected
 * there, not silently dropped here.
 */
export async function resolveStageOffer(
  ctx: SelectionCtx,
  documentRef: string,
): Promise<ResolvedStageOffer | null> {
  const quoteRows = (await ctx.db.findMany("prep_quote", {
    where: { document_ref: documentRef },
    limit: 1,
  })) as Array<{ offers?: StoredOffer[] | null }>
  const offers = quoteRows[0]?.offers ?? []
  if (offers.length === 0) return null

  const stateRows = (await ctx.db.findMany("prep_state", {
    where: { document_ref: documentRef },
    limit: 1,
  })) as Array<{ selected_offer_code?: string | null }>
  const selectedCode = stateRows[0]?.selected_offer_code ?? null
  const selected = selectedCode ? offers.find((o) => o.offer_code === selectedCode) : undefined
  const chosen = selected ?? offers[0]!

  return {
    offer_code: chosen.offer_code,
    price_ttc_minor: typeof chosen.price_ttc_minor === "number" ? chosen.price_ttc_minor : null,
    currency: chosen.currency ?? null,
    is_pickup_point: chosen.is_pickup_point ?? false,
    source: selected ? "selected" : "cheapest",
  }
}
