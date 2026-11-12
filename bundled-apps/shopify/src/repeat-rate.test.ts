// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BL-169 #1: computeRepeatRate — the pure aggregate behind the repeat_rate tool.
// (Live customer pagination is exercised by the chaos gate against the dev store.)

import { describe, expect, it } from "bun:test"
import { type CustomerOrderCount, computeRepeatRate } from "./repeat-rate"

function c(name: string, orders: number | string | null): CustomerOrderCount {
  return { displayName: name, numberOfOrders: orders }
}

describe("computeRepeatRate (BL-169 #1)", () => {
  it("computes the share of customers with >1 order", () => {
    const r = computeRepeatRate([
      c("Marie", 2),
      c("Jean", 3),
      c("Once", 1),
      c("Never", 0),
      c("Solo", 1),
    ])
    expect(r.totalCustomers).toBe(5)
    expect(r.repeatCustomers).toBe(2)
    expect(r.repeatRatePct).toBe(40) // 2/5
    expect(r.sampleRepeatCustomers[0]).toEqual({ name: "Jean", orders: 3 })
  })

  it("coerces a string numberOfOrders (GraphQL UnsignedInt64)", () => {
    const r = computeRepeatRate([c("A", "2"), c("B", "1"), c("C", "5")])
    expect(r.repeatCustomers).toBe(2)
    expect(r.repeatRatePct).toBe(66.7) // 2/3 → 66.7
  })

  it("rounds to one decimal and handles an empty base", () => {
    expect(computeRepeatRate([]).repeatRatePct).toBe(0)
    const r = computeRepeatRate([c("X", 2), c("Y", 1), c("Z", 1)]) // 1/3
    expect(r.repeatRatePct).toBe(33.3)
  })

  it("treats 1 order (and 0/null) as non-repeat", () => {
    const r = computeRepeatRate([c("A", 1), c("B", 0), c("C", null)])
    expect(r.repeatCustomers).toBe(0)
    expect(r.repeatRatePct).toBe(0)
  })
})
