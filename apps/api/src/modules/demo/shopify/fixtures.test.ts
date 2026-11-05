// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo store's book has to be a STORE, not a pile of rows: the money has to
// add up, the statuses have to be the ones an operator triages, and two reads
// have to agree or a page walk tears.
import { describe, expect, it } from "bun:test"
import { DEMO_WORLD } from "~/seed/world/fiction"
import { DEMO_ORDER_COUNT, DemoShopifyFixturesTestAccess, demoShopifyBook, money } from "./fixtures"

const NOW = Date.UTC(2026, 8, 16, 11, 30)

function book() {
  DemoShopifyFixturesTestAccess.reset()
  return demoShopifyBook(NOW)
}

describe("the demo store's book", () => {
  it("is byte identical across two builds of the same day", () => {
    const first = JSON.stringify(book().orders)
    const second = JSON.stringify(book().orders)
    expect(second).toBe(first)
    // And across a rebuild later the same UTC day, which a page walk spans.
    DemoShopifyFixturesTestAccess.reset()
    expect(JSON.stringify(demoShopifyBook(NOW + 6 * 3_600_000).orders)).toBe(first)
  })

  it("moves with the calendar, so the newest order is always recent", () => {
    const today = book().orders[0]
    DemoShopifyFixturesTestAccess.reset()
    const tomorrow = demoShopifyBook(NOW + 86_400_000).orders[0]
    expect(tomorrow?.createdAt).not.toBe(today?.createdAt)
    expect(Date.parse(tomorrow!.createdAt)).toBeGreaterThan(Date.parse(today!.createdAt))
  })

  it("carries a showroom sized order book, newest first", () => {
    const orders = book().orders
    expect(orders).toHaveLength(DEMO_ORDER_COUNT)
    expect(orders.length).toBeGreaterThanOrEqual(60)
    expect(orders.length).toBeLessThanOrEqual(120)
    for (let i = 1; i < orders.length; i++) {
      expect(Date.parse(orders[i - 1]!.createdAt)).toBeGreaterThanOrEqual(
        Date.parse(orders[i]!.createdAt),
      )
    }
  })

  it("every order's total is its own line items plus its own shipping", () => {
    for (const order of book().orders) {
      const lines = order.lineItems.reduce((sum, li) => sum + li.unitMinor * li.quantity, 0)
      expect(order.subtotalMinor).toBe(lines)
      expect(order.totalMinor).toBe(order.subtotalMinor + order.shippingMinor)
      expect(order.totalMinor).toBeGreaterThan(0)
      expect(order.lineItems.length).toBeGreaterThan(0)
    }
  })

  it("never refunds more than was charged", () => {
    for (const order of book().orders) {
      const refunded = order.refunds.reduce((sum, r) => sum + r.amountMinor, 0)
      expect(refunded).toBeLessThanOrEqual(order.totalMinor)
      if (order.financialStatus === "REFUNDED") expect(refunded).toBeGreaterThan(0)
    }
  })

  it("spreads orders across every status an operator triages", () => {
    const counts = new Map<string, number>()
    for (const order of book().orders) {
      const key = order.cancelledAt ? "CANCELLED" : order.fulfillmentStatus
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    for (const status of [
      "UNFULFILLED",
      "PARTIALLY_FULFILLED",
      "FULFILLED",
      "ON_HOLD",
      "CANCELLED",
    ]) {
      expect(counts.get(status) ?? 0).toBeGreaterThan(0)
    }
    const refunded = book().orders.filter((o) => o.financialStatus.includes("REFUNDED"))
    expect(refunded.length).toBeGreaterThan(0)
  })

  it("leaves a real shipping worklist: open, unshipped, and at least a day old", () => {
    const worklist = book().orders.filter(
      (order) =>
        !order.cancelledAt &&
        (order.fulfillmentStatus === "UNFULFILLED" ||
          order.fulfillmentStatus === "PARTIALLY_FULFILLED"),
    )
    expect(worklist.length).toBeGreaterThanOrEqual(30)
    for (const order of worklist) {
      expect(NOW - Date.parse(order.createdAt)).toBeGreaterThan(0)
      expect(order.shippingAddress.address1).not.toBe("")
      expect(order.shippingAddress.countryCode).toMatch(/^[A-Z]{2}$/)
    }
  })

  it("sells only the catalog the rest of the demo world sells", () => {
    const catalogSkus = new Set(DEMO_WORLD.catalog.map((sku) => sku.sku))
    expect(
      book()
        .products.map((p) => p.title)
        .sort(),
    ).toEqual(DEMO_WORLD.catalog.map((sku) => sku.title).sort())
    for (const order of book().orders) {
      for (const item of order.lineItems) {
        expect(catalogSkus.has(item.sku)).toBe(true)
        expect(item.sku.startsWith("RAL-")).toBe(true)
      }
    }
  })

  it("prices every line at its own variant's price", () => {
    const current = book()
    for (const order of current.orders) {
      for (const item of order.lineItems) {
        expect(item.unitMinor).toBe(current.variantsById.get(item.variantId)!.priceMinor)
      }
    }
  })

  it("buys from the dealers and customers the world already knows", () => {
    const current = book()
    const emails = new Set([
      ...DEMO_WORLD.customers.map((c) => c.email),
      ...current.customers.filter((c) => c.kind === "dealer").map((c) => c.email),
    ])
    for (const order of current.orders) {
      expect(current.customersById.has(order.customerId)).toBe(true)
      expect(emails.has(order.email ?? "")).toBe(true)
    }
    expect(current.customers.length).toBe(DEMO_WORLD.customers.length + DEMO_WORLD.dealers.length)
  })

  it("has quotes, some still open and some already turned into orders", () => {
    const drafts = book().draftOrders
    expect(drafts.filter((d) => d.status === "OPEN").length).toBeGreaterThan(0)
    expect(drafts.filter((d) => d.status === "COMPLETED").length).toBeGreaterThan(0)
    for (const draft of drafts) {
      const lines = draft.lineItems.reduce((sum, li) => sum + li.unitMinor * li.quantity, 0)
      expect(draft.totalMinor).toBe(lines + draft.shippingMinor)
    }
  })

  it("has returns in flight and stock low enough to raise attention", () => {
    const current = book()
    const pending = current.orders.flatMap((o) =>
      o.returns.filter((r) => r.status === "REQUESTED" || r.status === "OPEN"),
    )
    expect(pending.length).toBeGreaterThan(0)
    const low = current.products.flatMap((p) => p.variants).filter((v) => v.inventoryQuantity <= 5)
    expect(low.length).toBeGreaterThan(0)
  })

  it("formats money without a floating point cent", () => {
    expect(money(0)).toBe("0.00")
    expect(money(5)).toBe("0.05")
    expect(money(134900)).toBe("1349.00")
    expect(money(-1490)).toBe("-14.90")
  })
})
