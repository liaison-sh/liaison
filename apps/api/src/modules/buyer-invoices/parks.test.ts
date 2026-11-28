// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { normaliseIdentity, saleMatches } from "./match"
import { type ParkRow, parkedSales } from "./parks"

const order = (over: Record<string, unknown> = {}, row: Partial<ParkRow> = {}): ParkRow => ({
  order_id: "6100000000001",
  created_at: "2026-11-25T09:00:00Z",
  payload: {
    id: "6100000000001",
    order_number: "#4100",
    shop_id: "shop.example",
    createdAt: "2026-11-24T22:10:00Z",
    total_price_minor: "45000",
    currency: "eur",
    customer: { id: "gid://shopify/Customer/777", email: " Dee@Example.com ", contact_id: null },
    ...over,
  },
  ...row,
})

describe("a parked Shopify order as a pending sale", () => {
  test("carries the order's identity, amount, date and name, and nothing about the park", () => {
    const [s] = parkedSales([order()])
    expect(s).toEqual({
      orderId: "6100000000001",
      name: "#4100",
      soldOn: "2026-11-24",
      totalMinor: "45000",
      currency: "EUR",
      identity: { email: "dee@example.com", shopifyCustomerId: "777", hubUserId: null },
    })
  })

  test("its identity follows the matching rule: an email alone never reaches an order with an id", () => {
    const [s] = parkedSales([order()])
    if (!s) throw new Error("no sale")
    expect(saleMatches(normaliseIdentity({ email: "dee@example.com" }), s.identity)).toBe(false)
    expect(
      saleMatches(
        normaliseIdentity({ email: "dee@example.com", shopifyCustomerId: "778" }),
        s.identity,
      ),
    ).toBe(false)
    expect(saleMatches(normaliseIdentity({ shopifyCustomerId: "777" }), s.identity)).toBe(true)
    const [guest] = parkedSales([order({ customer: { id: null, email: "g@example.com" } })])
    if (!guest) throw new Error("no sale")
    expect(saleMatches(normaliseIdentity({ email: "G@example.com" }), guest.identity)).toBe(true)
  })

  test("several parks of one order are one sale, and two identities among them are a conflict", () => {
    const same = parkedSales([order(), order({ order_number: null })])
    expect(same).toHaveLength(1)
    expect(same[0]?.name).toBe("#4100")
    const [split] = parkedSales([
      order(),
      order({ customer: { id: "778", email: "dee@example.com" } }),
    ])
    if (!split) throw new Error("no sale")
    expect(saleMatches(normaliseIdentity({ shopifyCustomerId: "777" }), split.identity)).toBe(false)
    expect(saleMatches(normaliseIdentity({ shopifyCustomerId: "778" }), split.identity)).toBe(false)
    const [twoEmails] = parkedSales([
      order({ customer: { id: null, email: "a@example.com" } }),
      order({ customer: { id: null, email: "b@example.com" } }),
    ])
    if (!twoEmails) throw new Error("no sale")
    expect(saleMatches(normaliseIdentity({ email: "a@example.com" }), twoEmails.identity)).toBe(
      false,
    )
  })

  test("a zero total, a payload of another order or a malformed id is never a sale", () => {
    expect(parkedSales([order({ total_price_minor: "0" })])).toEqual([])
    expect(parkedSales([order({ total_price_minor: 0 })])).toEqual([])
    expect(parkedSales([order({ id: "6100000000002" })])).toEqual([])
    expect(parkedSales([order({}, { order_id: "rs:stream:pi_1" })])).toEqual([])
    expect(parkedSales([order({}, { payload: null })])).toEqual([])
  })

  test("the park date stands in for an order date it lacks; an unknown amount stays unknown", () => {
    const [s] = parkedSales([order({ createdAt: undefined, total_price_minor: undefined })])
    expect(s?.soldOn).toBe("2026-11-25")
    expect(s?.totalMinor).toBeNull()
  })
})
