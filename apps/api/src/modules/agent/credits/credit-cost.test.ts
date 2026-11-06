// SPDX-License-Identifier: FSL-1.1-ALv2
// The managed edition's price arithmetic (S18, S21): the `≈ N×` multiplier
// against Auto from the blended 3:1 list price, one decimal below 2×, a whole
// number from 2× up; credits per call and per dictation minute.
import { describe, expect, test } from "bun:test"
import { belowThreshold } from "~/modules/cloud/auto-topup-trigger"
import { previousUtcDay, reportRequestId } from "~/modules/cloud/usage-report"
import {
  blendedPricePerM,
  creditsForEur,
  creditsForUnits,
  priceMultiplier,
  STALE_PRICE_FACTOR,
} from "./credit-cost"

const auto = { inputCostPerM: "1", outputCostPerM: "4" } // blended (3 + 4) / 4 = 1.75

describe("priceMultiplier", () => {
  test("blends 3 input : 1 output", () => {
    expect(blendedPricePerM(1, 4)).toBe(1.75)
  })
  test("one decimal below 2×", () => {
    // blended 2.45 / 1.75 = 1.4
    expect(priceMultiplier({ inputCostPerM: "1.4", outputCostPerM: "5.6" }, auto)).toBe(1.4)
    expect(priceMultiplier(auto, auto)).toBe(1)
    // 1.97 rounds to 2.0, shown as 2
    expect(priceMultiplier({ inputCostPerM: "1.97", outputCostPerM: "7.88" }, auto)).toBe(2)
  })
  test("a whole number from 2× up", () => {
    // blended 5.25 / 1.75 = 3
    expect(priceMultiplier({ inputCostPerM: "3", outputCostPerM: "12" }, auto)).toBe(3)
    // 2.6 → 3
    expect(priceMultiplier({ inputCostPerM: "2.6", outputCostPerM: "10.4" }, auto)).toBe(3)
  })
  test("unknown when a price is missing or Auto's is zero", () => {
    expect(priceMultiplier(auto, null)).toBeNull()
    expect(priceMultiplier(auto, { inputCostPerM: "0", outputCostPerM: "0" })).toBeNull()
    expect(priceMultiplier({ inputCostPerM: "x", outputCostPerM: "1" }, auto)).toBeNull()
  })
})

describe("credits", () => {
  test("raw EUR × rate, × the stale factor when stale", () => {
    expect(creditsForEur(2, 1.4, false)).toBeCloseTo(2.8, 10)
    expect(creditsForEur(2, 1.4, true)).toBeCloseTo(2.8 * STALE_PRICE_FACTOR, 10)
    expect(STALE_PRICE_FACTOR).toBeCloseTo(1.0416666666667, 12)
  })
  test("a fixed-price item costs its pushed credit price, whatever the rate", () => {
    const unitPrices = { webCall: "0.05", dictationMinute: "0.25" }
    for (const rate of [1.1, 1.4, 9]) {
      const pricing = { rate, unitPrices }
      expect(creditsForUnits(pricing, "webCall", 1)).toBe(0.05)
      expect(creditsForUnits(pricing, "dictationMinute", 0.5)).toBe(0.125)
      expect(creditsForUnits(pricing, "dictationMinute", -1)).toBe(0)
    }
  })
})

describe("auto top-up level check", () => {
  const d = (balanceAfter: number, amount: number) => ({
    orgId: "o",
    transactionId: "t",
    balanceAfter,
    amount,
  })
  test("every deduction that leaves the org below the threshold, not only a crossing", () => {
    expect(belowThreshold(d(9, 3), 10)).toBe(true)
    expect(belowThreshold(d(9.99, 0.01), 10)).toBe(true)
    expect(belowThreshold(d(8, 1), 10)).toBe(true) // already below: asks again
    expect(belowThreshold(d(10, 2), 10)).toBe(false) // not below yet
    expect(belowThreshold(d(5, 0), 10)).toBe(false) // nothing spent
  })
})

describe("usage report", () => {
  test("the previous UTC day", () => {
    expect(previousUtcDay(new Date("2026-11-02T00:15:00Z"))).toBe("2026-11-01")
    expect(previousUtcDay(new Date("2026-03-01T23:59:00Z"))).toBe("2026-02-28")
  })
  test("a stable uuid per org and day", () => {
    const a = reportRequestId("o1", "2026-11-01")
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(reportRequestId("o1", "2026-11-01")).toBe(a)
    expect(reportRequestId("o1", "2026-11-02")).not.toBe(a)
  })
})
