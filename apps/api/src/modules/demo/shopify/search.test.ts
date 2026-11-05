// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The search reader, against the REAL queries the apps send.
//
// The load-bearing case is Boxtal's worklist: `status:open AND (a OR b OR c)`.
// A matcher that treated the parentheses as noise would answer it as
// `status:open AND a AND b AND c` (empty) or as a bare OR (every order),
// and either way the operator's primary screen would be wrong.
import { describe, expect, it } from "bun:test"
import { type FieldValue, matchesShopifySearch } from "./search"

const BOXTAL_WORKLIST =
  "status:open AND (fulfillment_status:unfulfilled OR fulfillment_status:unshipped OR fulfillment_status:partial OR fulfillment_status:on_hold OR fulfillment_status:scheduled OR fulfillment_status:request_declined)"

function order(fields: Record<string, FieldValue>, text = "") {
  return (query: string) => matchesShopifySearch(query, (field) => fields[field], text)
}

describe("the Shopify search reader", () => {
  it("answers the Boxtal worklist query per order, not per connective", () => {
    const open = order({ status: "open", fulfillment_status: ["unfulfilled", "unshipped"] })
    const partial = order({ status: "open", fulfillment_status: ["partial", "unshipped"] })
    const shipped = order({ status: "open", fulfillment_status: ["fulfilled", "shipped"] })
    const cancelled = order({ status: "cancelled", fulfillment_status: ["unfulfilled"] })

    expect(open(BOXTAL_WORKLIST)).toBe(true)
    expect(partial(BOXTAL_WORKLIST)).toBe(true)
    expect(shipped(BOXTAL_WORKLIST)).toBe(false)
    expect(cancelled(BOXTAL_WORKLIST)).toBe(false)
  })

  it("reads Home's date bounded attention query", () => {
    const query =
      "status:open AND fulfillment_status:unfulfilled AND created_at:<'2026-09-15T00:00:00.000Z' AND created_at:>'2026-07-18T00:00:00.000Z'"
    const inside = order({
      status: "open",
      fulfillment_status: ["unfulfilled"],
      created_at: "2026-09-01T10:00:00.000Z",
    })
    const tooNew = order({
      status: "open",
      fulfillment_status: ["unfulfilled"],
      created_at: "2026-09-16T10:00:00.000Z",
    })
    const tooOld = order({
      status: "open",
      fulfillment_status: ["unfulfilled"],
      created_at: "2026-01-02T10:00:00.000Z",
    })
    expect(inside(query)).toBe(true)
    expect(tooNew(query)).toBe(false)
    expect(tooOld(query)).toBe(false)
  })

  it("reads Home's low inventory query, negation included", () => {
    const controller = order({ inventory_quantity: 3, product_type: "Controller" })
    const stocked = order({ inventory_quantity: 40, product_type: "Controller" })
    const giftcard = order({ inventory_quantity: 1, product_type: "giftcard" })
    const query = "inventory_quantity:<=5 AND product_type:-giftcard"
    expect(controller(query)).toBe(true)
    expect(stocked(query)).toBe(false)
    expect(giftcard(query)).toBe(false)
  })

  it("matches an order number with or without the hash", () => {
    const one = order({ name: "#1042" })
    expect(one("name:1042")).toBe(true)
    expect(one("name:#1042")).toBe(true)
    expect(one("name:1043")).toBe(false)
  })

  it("treats adjacency as AND and honours NOT", () => {
    const row = order({ status: "open", tag: ["dealer"] })
    expect(row("status:open tag:dealer")).toBe(true)
    expect(row("status:open tag:vip")).toBe(false)
    expect(row("status:open NOT tag:vip")).toBe(true)
    expect(row("-tag:dealer")).toBe(false)
  })

  it("falls back to free text for a bare term", () => {
    const row = order({}, "#1042 claudine.moreau@studiotone.example ral-flag-01")
    expect(row("claudine")).toBe(true)
    expect(row("RAL-FLAG-01")).toBe(true)
    expect(row("nobody")).toBe(false)
  })

  it("matches everything on an empty query", () => {
    expect(matchesShopifySearch(null, () => undefined)).toBe(true)
    expect(matchesShopifySearch("", () => undefined)).toBe(true)
    expect(matchesShopifySearch("   ", () => undefined)).toBe(true)
  })

  it("lets an unmodelled field through rather than emptying the screen", () => {
    const row = order({ status: "open" })
    expect(row("status:open AND risk_level:high")).toBe(true)
    expect(row("status:closed AND risk_level:high")).toBe(false)
  })

  it("does not spin on a malformed query", () => {
    const row = order({ status: "open" })
    expect(row("status:open AND ((")).toBe(true)
    expect(row(")))")).toBe(true)
    expect(row("status:")).toBe(false)
  })
})
