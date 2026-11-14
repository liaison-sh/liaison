// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What one billed line of a planned vs done card charges. One rule, used by the card's preview,
// the draft made from it and a correction of it: the billed minutes become a quantity in the
// line's unit (days at the project's hours per day, or hours), rounded half up to two decimals,
// and the line amount is that quantity times the rate, computed as the issued line computes it
// (`lineSubtotal`). So the preview a person reads is what issues.

import { lineSubtotal } from "./money"

export type BilledUnit = "day" | "hour"

/** The quantity, in `unit`, of `minutes` billed: half up to two decimals, as a decimal string. */
export function lineQuantity(
  minutes: number,
  unit: BilledUnit,
  hoursPerDayMinutes: number,
): string {
  const per = unit === "day" ? hoursPerDayMinutes : 60
  if (!Number.isFinite(minutes) || minutes < 0 || !Number.isFinite(per) || per <= 0) {
    throw new Error(`lineQuantity: cannot bill ${minutes} minutes at ${per} minutes per ${unit}`)
  }
  // Hundredths, half up, in integers: (minutes * 100 / per) rounded.
  const hundredths = Math.floor((Math.round(minutes) * 100 * 2 + per) / (2 * per))
  const whole = Math.floor(hundredths / 100)
  const frac = hundredths % 100
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`
}

/** The amount, in minor units, of `minutes` billed at `rateMinor` per `unit`. */
export function lineAmountMinor(
  minutes: number,
  unit: BilledUnit,
  rateMinor: number | bigint,
  hoursPerDayMinutes: number,
): bigint {
  return lineSubtotal({
    quantity: lineQuantity(minutes, unit, hoursPerDayMinutes),
    unit_price_minor: BigInt(rateMinor),
  })
}
