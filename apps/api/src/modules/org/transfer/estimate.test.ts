// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The estimate's constants are the timing spike's measured rates; this pins
// the arithmetic so a change to them is deliberate.
import { describe, expect, it } from "bun:test"
import {
  APPLY_ROWS_PER_SECOND,
  DELTA_SHARE,
  FIXED_GAP_SECONDS,
  gapSeconds,
  SCAN_ROWS_PER_SECOND,
} from "./estimate"

describe("estimate constants", () => {
  it("keeps the measured rates", () => {
    expect(SCAN_ROWS_PER_SECOND).toBe(225_000)
    expect(APPLY_ROWS_PER_SECOND).toBe(12_000)
    expect(DELTA_SHARE).toBe(0.001)
    expect(FIXED_GAP_SECONDS).toBe(5.5)
  })

  it("an empty org costs the fixed steps only", () => {
    expect(gapSeconds(0)).toBe(FIXED_GAP_SECONDS)
  })

  it("a lively org (3.4k rows) and a 400k-row org fit the 12 s target", () => {
    expect(gapSeconds(3_414)).toBeCloseTo(5.52, 2)
    expect(gapSeconds(400_285)).toBeCloseTo(5.5 + 400_285 / 225_000 + 401 / 12_000, 1)
    expect(gapSeconds(400_285)).toBeLessThan(12)
  })

  it("grows with the row count and crosses 12 s at about 1.4M rows", () => {
    expect(gapSeconds(2_000_000)).toBeGreaterThan(12)
    expect(gapSeconds(1_000_000)).toBeLessThan(12)
  })
})
