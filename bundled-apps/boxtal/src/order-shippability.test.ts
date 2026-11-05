// SPDX-License-Identifier: FSL-1.1-ALv2
//
// STANDING ORACLE — "never ship a refunded product".
//
// Prod, 2026-08-05: order #3320 was fully refunded (1064 USD back, fulfillment
// CANCELLED) and was sitting in the To-prepare worklist. Nothing consulted the
// order's financial state; the only thing keeping it un-preparable was an
// unrelated customs-FX failure caused by the refund zeroing the order totals.
// Fixing that FX bug alone would have promoted a refunded order to "ready to
// prepare".
//
// This oracle pins the invariant itself rather than that one order. If a future
// change makes a refunded or cancelled order shippable again, this fails.

import { describe, expect, it } from "bun:test"
import {
  isOrderShippable,
  unshippableMessage,
  unshippableReason,
} from "./order-shippability"

describe("order shippability", () => {
  it("blocks a fully refunded order (the #3320 shape)", () => {
    expect(unshippableReason({ financial_status: "REFUNDED" })).toBe("order_refunded")
    expect(isOrderShippable({ financial_status: "REFUNDED" })).toBe(false)
  })

  // Deliberate: a partial refund usually means part of the order is not being
  // sent. Shipping the whole thing is the expensive mistake.
  it("blocks a PARTIALLY refunded order", () => {
    expect(unshippableReason({ financial_status: "PARTIALLY_REFUNDED" })).toBe("order_refunded")
  })

  it.each(["VOIDED", "EXPIRED"])("blocks financial status %s", (status) => {
    expect(isOrderShippable({ financial_status: status })).toBe(false)
  })

  it("blocks a cancelled order even when it was paid", () => {
    expect(
      unshippableReason({ financial_status: "PAID", cancelled_at: "2026-08-04T10:00:00Z" }),
    ).toBe("order_cancelled")
  })

  it("cancellation wins over refund in the reported reason", () => {
    expect(
      unshippableReason({ financial_status: "REFUNDED", cancelled_at: "2026-08-04T10:00:00Z" }),
    ).toBe("order_cancelled")
  })

  it("is case- and whitespace-insensitive on the status", () => {
    expect(isOrderShippable({ financial_status: " refunded " })).toBe(false)
  })

  it("allows a normal paid order", () => {
    expect(unshippableReason({ financial_status: "PAID", cancelled_at: null })).toBeNull()
    expect(isOrderShippable({ financial_status: "PAID" })).toBe(true)
  })

  it.each(["PAID", "PENDING", "AUTHORIZED", "PARTIALLY_PAID"])(
    "allows financial status %s",
    (status) => {
      expect(isOrderShippable({ financial_status: status })).toBe(true)
    },
  )

  // Absent facts must not block: a transient Shopify read failure would
  // otherwise empty the entire worklist. The create-time guard re-reads live,
  // so an unknown is re-checked before any money is spent.
  it("does NOT block when the facts are unknown", () => {
    expect(isOrderShippable(null)).toBe(true)
    expect(isOrderShippable(undefined)).toBe(true)
    expect(isOrderShippable({})).toBe(true)
    expect(isOrderShippable({ financial_status: null, cancelled_at: null })).toBe(true)
  })

  // An empty-string cancelled_at is "not cancelled", not "cancelled at the
  // epoch" — a JSON round-trip through the DB can produce one.
  it("treats an empty cancelled_at as not cancelled", () => {
    expect(isOrderShippable({ financial_status: "PAID", cancelled_at: "" })).toBe(true)
    expect(isOrderShippable({ financial_status: "PAID", cancelled_at: "   " })).toBe(true)
  })

  it("names the order in the operator message and uses no dash punctuation", () => {
    const msg = unshippableMessage("order_refunded", "#3320")
    expect(msg).toContain("#3320")
    expect(msg).toContain("refunded")
    expect(msg).toContain("Nothing was bought")
    expect(msg).not.toMatch(/[—–]|--/)
    expect(unshippableMessage("order_cancelled", null)).toContain("This order")
  })
})
