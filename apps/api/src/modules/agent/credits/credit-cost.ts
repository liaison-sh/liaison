// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Credits in the managed edition (spec S18, S21): what a call costs in
// credits, and how a model's price is shown without showing money.
//
//  - A call's credits = its raw provider cost in EUR (USD converted at the
//    recorded daily ECB rate) x the cell's credit rate, the setting the
//    control plane pushes (`modules/cloud/credit-rate.ts`), read per call so a
//    new rate applies without a restart. A stale catalogue price adds the
//    stale factor on top.
//  - A fixed-price item (a web call, a dictation minute) costs its own credit
//    price, pushed with the rate: never list price x rate, which would
//    let credits / the public list price reveal the rate.
//  - No pushed pricing, no metered managed usage: the call is refused
//    with CREDIT_PRICING_MISSING and an error log the watchdog sees (also
//    `cloud.creditPricing` on /diag). There is no fallback factor.
//  - A model's price is shown as a multiplier against the model Auto runs:
//    the blended list price (3 input tokens : 1 output token) of the model
//    over Auto's, one decimal below 2x, a whole number from 2x up.
// The rate never leaves the server.

import type { CloudUnitItem, CloudUnitPrices } from "@liaison/control-plane-contract"
import { rootLogger } from "~/lib/logger"
import { readCreditPricing } from "~/modules/cloud/credit-rate"

const log = rootLogger.child({ module: "credit-cost" })

/** Extra factor applied to the cost when the catalogue price is stale. */
export const STALE_PRICE_FACTOR = 1.0416666666666667

/** The error code of metered managed usage refused for want of a pushed rate. */
export const CREDIT_PRICING_MISSING = "credit_rate_missing"
/** What the person is told when it is refused. */
export const CREDIT_PRICING_MISSING_MESSAGE =
  "Usage is unavailable on this workspace for a moment: its billing setup is incomplete. Please try again shortly or contact support."

export interface CellCreditPricing {
  rate: number
  unitPrices: CloudUnitPrices
}

/** Thrown when metered managed usage is attempted without a pushed rate. */
export class CreditPricingMissingError extends Error {
  readonly code = CREDIT_PRICING_MISSING
  constructor() {
    super(CREDIT_PRICING_MISSING_MESSAGE)
    this.name = "CreditPricingMissingError"
  }
}

async function pushedPricing(): Promise<CellCreditPricing | null> {
  const pushed = await readCreditPricing()
  const rate = pushed === null ? Number.NaN : Number(pushed.rate)
  return pushed && Number.isFinite(rate) && rate > 0
    ? { rate, unitPrices: pushed.unitPrices }
    : null
}

/** For /diag (the watchdog): whether the cell holds a usable pushed rate. Logs nothing. */
export async function creditPricingStatus(): Promise<"ok" | "missing"> {
  return (await pushedPricing()) ? "ok" : "missing"
}

/**
 * The cell's pushed rate and unit prices now, or null when none (or an
 * unusable one) was pushed; null logs the alert line every time.
 */
export async function cellCreditPricing(context: string): Promise<CellCreditPricing | null> {
  const pricing = await pushedPricing()
  if (pricing) return pricing
  log.error(
    { alert: CREDIT_PRICING_MISSING, context },
    "credit rate missing: metered managed usage refused",
  )
  return null
}

/** The pushed pricing, or a CreditPricingMissingError. */
export async function requireCellCreditPricing(context: string): Promise<CellCreditPricing> {
  const pricing = await cellCreditPricing(context)
  if (!pricing) throw new CreditPricingMissingError()
  return pricing
}

/** Credits for `quantity` units of a fixed-price item at its pushed price. */
export function creditsForUnits(
  pricing: CellCreditPricing,
  item: CloudUnitItem,
  quantity: number,
): number {
  return Math.max(0, quantity) * Number(pricing.unitPrices[item])
}

/** Credits for a raw EUR cost at `rate`. */
export function creditsForEur(rawEur: number, rate: number, stale: boolean): number {
  return rawEur * rate * (stale ? STALE_PRICE_FACTOR : 1)
}

/** Blended price per million tokens: 3 input tokens for 1 output token. */
export function blendedPricePerM(inputPerM: number, outputPerM: number): number {
  return (3 * inputPerM + outputPerM) / 4
}

/**
 * `≈ N×` against Auto's model: one decimal below 2, a whole number from 2 up.
 * Null when either price is unknown or Auto's is zero.
 */
export function priceMultiplier(
  model: { inputCostPerM: unknown; outputCostPerM: unknown },
  auto: { inputCostPerM: unknown; outputCostPerM: unknown } | null,
): number | null {
  if (!auto) return null
  const m = blendedPricePerM(Number(model.inputCostPerM), Number(model.outputCostPerM))
  const a = blendedPricePerM(Number(auto.inputCostPerM), Number(auto.outputCostPerM))
  if (!Number.isFinite(m) || !Number.isFinite(a) || a <= 0 || m < 0) return null
  const ratio = m / a
  if (ratio < 2) {
    const one = Math.round(ratio * 10) / 10
    // 1.96 rounds to 2.0: from there it is a whole number.
    return one >= 2 ? 2 : Math.max(one, 0.1)
  }
  return Math.round(ratio)
}
