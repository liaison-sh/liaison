// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Declared-value currency conversion for the carrier boundary.
//
// Boxtal reads every money figure we send it (the v1 quote's `colis.valeur`
// carries NO currency at all, and the v3 create's `Money.currency` is not
// honored on the customs paperwork) as EUR. An invoice issued in another
// currency therefore reached customs with its NUMBER intact and its unit
// swapped: a 1000 USD invoice was declared as 1000 EUR, over-valuing the parcel
// and over-charging duty (field report 2026-07-31, ticket-10154).
//
// So the app converts to EUR itself before anything leaves for Boxtal. The rate
// is NOT fetched from an FX feed: the Shopify order behind the invoice already
// carries the exact rate Shopify itself applied, as the ratio between the
// buyer-facing presentment total and the store-currency (EUR) shop total. That
// rate is the one the customer actually transacted at, needs no external
// dependency, and cannot drift between order time and label time.
//
// When no rate can be derived (no linked Shopify order, missing/zero totals, a
// shop currency that is not EUR), we do NOT guess: the caller marks the article
// blocked so quote/create refuse until an operator enters the value by hand
// (shipment_draft_set_customs unit values are read as EUR).

import { currencyExponent } from "./money"

/** The currency Boxtal declares in, whatever the invoice is issued in. */
export const DECLARED_CURRENCY = "EUR"

export interface FxConversion {
  /** Multiply a major-unit amount in `from` by this to get EUR. */
  rate: number
  from: string
  to: typeof DECLARED_CURRENCY
  /** Provenance, surfaced on the draft so the approval card can show it. */
  source: "shopify_order_totals"
}

/** Order totals as `shopify:orders_get` surfaces them (`attributes.*`). */
export interface ShopifyOrderTotals {
  /** Buyer-facing (presentment) total, e.g. "1000.00" USD. */
  totalAmount?: string | number | null
  /** Store-currency (shopMoney) total for the SAME order, e.g. "917.43". */
  totalAmountShop?: string | number | null
  /** Store currency — only EUR yields a usable rate here. */
  shopCurrency?: string | null
  /** PRE-REFUND totals. `totalAmount`/`totalAmountShop` are the CURRENT
   *  (post-refund) totals, so a refunded order reports 0.00 in both currencies
   *  and the rate derivable from the pair is destroyed. The FX rate is a
   *  property of the order's currency pair, not of how much is still owed, so a
   *  refund must not erase it. See the fallback in deriveShopifyOrderRate. */
  originalTotalAmount?: string | number | null
  originalTotalAmountShop?: string | number | null
  originalShopCurrency?: string | null
}

/** shop/presentment rate for one MoneyBag pair, or null when either side is unusable. */
function pairRate(
  presentmentRaw: string | number | null | undefined,
  shopRaw: string | number | null | undefined,
): number | null {
  const presentment = finitePositive(presentmentRaw)
  const shop = finitePositive(shopRaw)
  if (presentment == null || shop == null) return null
  return shop / presentment
}

function finitePositive(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Derive the invoice-currency → EUR rate from one Shopify order's two totals.
 * Returns null (never a guessed rate) when the order cannot answer: totals
 * missing or zero, or a store currency that is not EUR. `docCurrency` is the
 * invoice's currency; an invoice already in EUR needs no conversion and yields
 * null too.
 */
export function deriveShopifyOrderRate(
  docCurrency: string,
  totals: ShopifyOrderTotals | null | undefined,
): FxConversion | null {
  const from = String(docCurrency ?? "").toUpperCase()
  if (!from || from === DECLARED_CURRENCY) return null
  if (!totals) return null
  // Current totals first; fall back to the ORIGINAL (pre-refund) pair when they
  // are missing or zeroed. Prod 2026-08-05: fully refunded order #3320 reported
  // 0.00 / 0.00 here, so every customs article blocked `fx_unavailable` and the
  // row read "Customs value needs a manual EUR amount" — for a reason that has
  // nothing to do with the currency pair. Each pair carries its OWN store
  // currency, so the EUR check is applied per pair rather than once up front.
  const currentUsable =
    String(totals.shopCurrency ?? "").toUpperCase() === DECLARED_CURRENCY
      ? pairRate(totals.totalAmount, totals.totalAmountShop)
      : null
  const originalUsable =
    String(totals.originalShopCurrency ?? totals.shopCurrency ?? "").toUpperCase() ===
    DECLARED_CURRENCY
      ? pairRate(totals.originalTotalAmount, totals.originalTotalAmountShop)
      : null
  const rate = currentUsable ?? originalUsable
  if (rate == null) return null
  return { rate, from, to: DECLARED_CURRENCY, source: "shopify_order_totals" }
}

/**
 * Convert a major-unit amount into EUR major units, rounded to EUR's minor-unit
 * precision (2 decimals) so the figure we declare is a real money amount and not
 * a float tail. Exponent-aware via `currencyExponent` rather than a hardcoded
 * /100 (zero-decimal currencies exist — the money oracle in gestalt/README.md).
 */
export function convertToDeclared(majorValue: number, fx: FxConversion): number {
  const scale = 10 ** currencyExponent(DECLARED_CURRENCY)
  return Math.round(majorValue * fx.rate * scale) / scale
}
