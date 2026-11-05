// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression: a dealer order of B2B goods on
// payment terms, unfulfilled, was invisible in the To-prepare worklist. Not
// ready, not needs_fix, not excluded: ABSENT, with no counter and no reason.
// The worklist derives from issued goods invoices, auto-invoicing fires on
// PAYMENT, and a terms customer never reaches `PAID`, so the order could never
// produce a row. An order you cannot see is an order you forget to ship.
import { describe, expect, it } from "bun:test"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"
import { createMockDb } from "./test-db"
import { unlinkedOrdersList } from "./unlinked"

interface Opts {
  orders?: unknown
  ordersStatus?: "completed" | "failed"
  docLinks?: Array<{ shopify_order_id: string | number | null }>
  docsStatus?: "completed" | "failed"
  prepMeta?: Array<Record<string, unknown>>
}

function makeCtx(o: Opts): BoxtalToolCtx {
  const db = createMockDb({ seed: { prep_meta: o.prepMeta ?? [] } })
  const executeTool = async (target: string): Promise<CrossAppEnvelope> => {
    if (target === "shopify:orders_search") {
      return o.ordersStatus === "failed"
        ? ({ status: "failed", result: null } as never)
        : ({ status: "completed", result: { results: o.orders ?? [] } } as never)
    }
    if (target === "invoicing:documents_for_orders") {
      return o.docsStatus === "failed"
        ? ({ status: "failed", result: null } as never)
        : ({ status: "completed", result: { links: o.docLinks ?? [] } } as never)
    }
    return { status: "completed", result: {} } as never
  }
  return { orgId: "org-1", db, executeTool, logger: { info() {}, warn() {}, error() {}, debug() {} } } as never
}

const order = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id: `gid://shopify/Order/${id}`,
  name,
  attributes: {
    financialStatus: "PENDING",
    fulfillmentStatus: "UNFULFILLED",
    cancelledAt: null,
    createdAt: "2026-08-10T09:00:00Z",
    tags: ["B2B", "DepotFR"],
    customer: { displayName: "Klangwerk GmbH" },
    shippingAddress: { countryCode: "DE" },
    ...extra,
  },
})

describe("unlinkedOrdersList", () => {
  it("surfaces an unfulfilled order that has no invoice -- the #3362 case", async () => {
    const ctx = makeCtx({ orders: [order("13070203027787", "#3362")] })
    const res = await unlinkedOrdersList(ctx)
    expect(res.total).toBe(1)
    expect(res.rows[0]).toMatchObject({
      order_id: "13070203027787",
      order_name: "#3362",
      customer: "Klangwerk GmbH",
      destination: "DE",
      financial_status: "PENDING",
    })
    // The operator must be told WHY it is missing and WHAT brings it in --
    // silent absence was the whole defect.
    expect(res.rows[0]!.reason).toMatch(/no invoice issued/i)
    expect(res.rows[0]!.action).toMatch(/invoice/i)
  })

  it("does NOT report an order the worklist already knows about", async () => {
    // Already synced (prep_meta) -- it has a row, so it is visible, not missing.
    const ctx = makeCtx({
      orders: [order("13070203027787", "#3362")],
      prepMeta: [{ id: "m1", document_ref: "doc-1", shopify_order_id: "13070203027787" }],
    })
    expect((await unlinkedOrdersList(ctx)).total).toBe(0)
  })

  it("does NOT report an order that HAS an invoice but was never prep_synced", async () => {
    // The authoritative second check. Without it, every freshly invoiced order
    // would show up as missing and the operator would learn to ignore this list.
    const ctx = makeCtx({
      orders: [order("999", "#3400")],
      docLinks: [{ shopify_order_id: "999" }],
    })
    expect((await unlinkedOrdersList(ctx)).total).toBe(0)
  })

  it("ignores a cancelled order -- not shipping work", async () => {
    const ctx = makeCtx({
      orders: [order("111", "#3401", { cancelledAt: "2026-08-11T00:00:00Z" })],
    })
    expect((await unlinkedOrdersList(ctx)).total).toBe(0)
  })

  it("accepts a bare numeric order id as well as a gid", async () => {
    const ctx = makeCtx({ orders: [{ ...order("222", "#3402"), id: "222" }] })
    expect((await unlinkedOrdersList(ctx)).rows[0]!.order_id).toBe("222")
  })

  it("reports oldest first -- three weeks invisible outranks this morning", async () => {
    const ctx = makeCtx({
      orders: [
        order("1", "#3500", { createdAt: "2026-08-26T09:00:00Z" }),
        order("2", "#3400", { createdAt: "2026-08-05T09:00:00Z" }),
      ],
    })
    expect((await unlinkedOrdersList(ctx)).rows.map((r) => r.order_name)).toEqual(["#3400", "#3500"])
  })

  it("fails SOFT when Shopify is unreachable rather than breaking the worklist", async () => {
    const ctx = makeCtx({ orders: [order("1", "#3400")], ordersStatus: "failed" })
    const res = await unlinkedOrdersList(ctx)
    expect(res.total).toBe(0)
    expect(res.rows).toEqual([])
  })

  it("reports NOTHING when invoicing is unreachable, never a false 'no invoice'", async () => {
    // Claiming "no invoice issued" without being able to check would send the
    // operator to issue a DUPLICATE invoice on a real customer's ledger.
    const ctx = makeCtx({ orders: [order("1", "#3400")], docsStatus: "failed" })
    expect((await unlinkedOrdersList(ctx)).total).toBe(0)
  })

  it("flags a truncated scan so the count reads as a floor, not a total", async () => {
    const many = Array.from({ length: 5 }, (_, i) => order(String(i + 1), `#${3400 + i}`))
    const ctx = makeCtx({ orders: many })
    const res = await unlinkedOrdersList(ctx, { limit: 5 })
    expect(res.truncated).toBe(true)
    expect(res.total).toBe(5)
  })
})
