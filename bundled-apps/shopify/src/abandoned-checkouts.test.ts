// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BL-169 #3: summarizeAbandonedCheckouts — the pure normalize/window/total behind the
// abandoned_checkouts_list tool. (Live pagination is exercised by the chaos gate against the
// dev store, which legitimately returns an EMPTY list — abandoned checkouts can't be seeded.)

import { describe, expect, it } from "bun:test"
import { summarizeAbandonedCheckouts, type RawAbandonedCheckout } from "./abandoned-checkouts"

function co(
  id: string,
  amount: string,
  createdAt: string,
  customer?: { displayName?: string; email?: string },
  items?: Array<{ title: string; quantity: number }>,
): RawAbandonedCheckout {
  return {
    id,
    createdAt,
    totalPriceSet: { shopMoney: { amount, currencyCode: "EUR" } },
    customer: customer ?? null,
    lineItems: { nodes: items ?? [] },
    abandonedCheckoutUrl: `https://shop.example/recover/${id}`,
  }
}

describe("summarizeAbandonedCheckouts (BL-169 #3)", () => {
  it("normalizes checkouts, sums recoverable value, and carries the recovery URL", () => {
    const r = summarizeAbandonedCheckouts([
      co("gid://1", "120.50", "2026-06-10T10:00:00Z", { displayName: "Ada", email: "ada@x.test" }, [
        { title: "Kestrel 6 Studio Bundle", quantity: 1 },
      ]),
      co("gid://2", "80.00", "2026-06-09T10:00:00Z"),
    ])
    expect(r.total).toBe(2)
    expect(r.totalRecoverableValue).toBe(200.5)
    expect(r.currency).toBe("EUR")
    const c0 = r.checkouts[0]!
    expect(c0.customerName).toBe("Ada")
    expect(c0.customerEmail).toBe("ada@x.test")
    expect(c0.lineItems[0]!.title).toBe("Kestrel 6 Studio Bundle")
    expect(c0.recoveryUrl).toBe("https://shop.example/recover/gid://1")
  })

  it("returns an EMPTY result (the dogfood-store reality) — no fabricated carts", () => {
    const r = summarizeAbandonedCheckouts([])
    expect(r.total).toBe(0)
    expect(r.checkouts).toEqual([])
    expect(r.totalRecoverableValue).toBe(0)
    expect(r.currency).toBeNull()
  })

  it("drops checkouts older than the sinceMs cutoff", () => {
    const cutoff = Date.parse("2026-06-08T00:00:00Z")
    const r = summarizeAbandonedCheckouts(
      [
        co("gid://recent", "50.00", "2026-06-10T10:00:00Z"),
        co("gid://old", "999.00", "2026-06-01T10:00:00Z"),
      ],
      cutoff,
    )
    expect(r.total).toBe(1)
    expect(r.checkouts[0]!.id).toBe("gid://recent")
    expect(r.totalRecoverableValue).toBe(50)
  })

  it("skips nodes with no id and tolerates missing money/customer/line items", () => {
    const r = summarizeAbandonedCheckouts([
      { id: null },
      { id: "gid://3", createdAt: "2026-06-10T10:00:00Z" }, // no money/customer/items
    ])
    expect(r.total).toBe(1)
    const only = r.checkouts[0]!
    expect(only.totalValue).toBe(0)
    expect(only.customerName).toBeNull()
    expect(only.lineItems).toEqual([])
  })
})
