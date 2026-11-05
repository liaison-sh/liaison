// SPDX-License-Identifier: FSL-1.1-ALv2
//
// documents_for_orders — batched, exact order → invoice lookup backing the
// Shopify order list's "linked invoices" affordance. Exercises the same
// generic-CRUD mock-db harness the other invoicing read tests use.

import { describe, expect, test } from "bun:test"
import { documentsForOrders } from "./reads"
import { createMockDb } from "./test-db"

function makeCtx(documents: Array<Record<string, unknown>>) {
  const db = createMockDb({ seed: { documents } })
  return { db }
}

describe("documentsForOrders", () => {
  test("the HUMAN order name resolves too — a '#3276' lookup finds the order's invoice", async () => {
    // Handing the order NAME instead of the numeric id used to return [], which
    // reads as "this order has no invoice" on an order that plainly has one.
    const ctx = makeCtx([
      {
        id: "doc-1",
        type: "invoice",
        scope: "goods",
        number: "EMB-2026-08201",
        status: "issued",
        payment_status: "paid",
        shopify_order_id: "12768069779622",
        shopify_order_number: "#3276",
      },
    ])
    const result = await documentsForOrders(ctx, { shopify_order_ids: ["#3276"] })
    expect(result.links).toHaveLength(1)
    expect(result.links[0]).toMatchObject({ shopify_order_id: "#3276", id: "doc-1" })
  })

  test("the order number without its '#' (or a gid built from it) resolves too", async () => {
    const ctx = makeCtx([
      {
        id: "doc-1",
        type: "invoice",
        scope: "goods",
        number: "INV-2026-0023",
        status: "issued",
        payment_status: "paid",
        shopify_order_id: "6100097",
        shopify_order_number: "#1097",
      },
    ])
    for (const asked of ["1097", "gid://shopify/Order/1097"]) {
      const result = await documentsForOrders(ctx, { shopify_order_ids: [asked] })
      expect(result.links, asked).toHaveLength(1)
      expect(result.links[0]).toMatchObject({ shopify_order_id: "1097", id: "doc-1" })
    }
  })

  // red: drop the po_number field from toOrderInvoiceLink -> an order->invoice deep link
  // built from documents_for_orders cannot show the PO number without a second lookup.
  test("returns po_number on the link", async () => {
    const ctx = makeCtx([
      {
        id: "doc-po",
        type: "invoice",
        scope: "goods",
        number: "EMB-2026-08300",
        status: "issued",
        payment_status: "unpaid",
        shopify_order_id: "12768069779700",
        po_number: "PO-4471",
      },
    ])
    const result = await documentsForOrders(ctx, { shopify_order_ids: ["12768069779700"] })
    expect(result.links).toHaveLength(1)
    expect(result.links[0]?.po_number).toBe("PO-4471")
  })

  test("two orders — one goods+software split (2 docs), one single doc — grouped by shopify_order_id", async () => {
    const ctx = makeCtx([
      {
        id: "doc-goods",
        type: "invoice",
        scope: "goods",
        number: "INV-2026-0001",
        status: "issued",
        payment_status: "unpaid",
        shopify_order_id: "1001",
      },
      {
        id: "doc-software",
        type: "invoice",
        scope: "software",
        number: "INV-2026-0002",
        status: "issued",
        payment_status: "unpaid",
        shopify_order_id: "1001",
      },
      {
        id: "doc-single",
        type: "invoice",
        scope: null,
        number: "INV-2026-0003",
        status: "draft",
        payment_status: "unpaid",
        shopify_order_id: "1002",
      },
    ])

    const result = await documentsForOrders(ctx, { shopify_order_ids: ["1001", "1002"] })

    const forOrder1001 = result.links.filter((l) => l.shopify_order_id === "1001")
    const forOrder1002 = result.links.filter((l) => l.shopify_order_id === "1002")
    expect(forOrder1001).toHaveLength(2)
    expect(forOrder1001.map((l) => l.id).sort()).toEqual(["doc-goods", "doc-software"])
    expect(forOrder1001.find((l) => l.id === "doc-goods")).toMatchObject({
      shopify_order_id: "1001",
      number: "INV-2026-0001",
      type: "invoice",
      scope: "goods",
      status: "issued",
      payment_status: "unpaid",
    })
    expect(forOrder1002).toHaveLength(1)
    expect(forOrder1002[0]).toMatchObject({
      shopify_order_id: "1002",
      id: "doc-single",
      number: "INV-2026-0003",
      scope: null,
      status: "draft",
    })
    expect(result.links).toHaveLength(3)
  })

  test("an order id with no documents contributes nothing", async () => {
    const ctx = makeCtx([
      {
        id: "doc-1",
        type: "invoice",
        scope: null,
        number: "INV-2026-0010",
        status: "issued",
        payment_status: "paid",
        shopify_order_id: "2001",
      },
    ])
    const result = await documentsForOrders(ctx, { shopify_order_ids: ["2001", "9999"] })
    expect(result.links).toHaveLength(1)
    expect(result.links[0]!.shopify_order_id).toBe("2001")
  })

  test("empty input → { links: [] }", async () => {
    const ctx = makeCtx([])
    expect(await documentsForOrders(ctx, {})).toEqual({ links: [] })
    expect(await documentsForOrders(ctx, { shopify_order_ids: [] })).toEqual({ links: [] })
  })

  test("invalid input (non-array, non-string entries) → { links: [] } / ignored", async () => {
    const ctx = makeCtx([
      {
        id: "doc-1",
        type: "invoice",
        scope: null,
        number: "INV-2026-0020",
        status: "issued",
        payment_status: "unpaid",
        shopify_order_id: "3001",
      },
    ])
    // biome-ignore lint/suspicious/noExplicitAny: exercising the input-coercion boundary
    expect(await documentsForOrders(ctx, { shopify_order_ids: "not-an-array" as any })).toEqual({
      links: [],
    })
    const mixed = await documentsForOrders(ctx, {
      // biome-ignore lint/suspicious/noExplicitAny: exercising the input-coercion boundary
      shopify_order_ids: ["3001", 42, null, "", "   "] as any,
    })
    expect(mixed.links).toHaveLength(1)
    expect(mixed.links[0]!.shopify_order_id).toBe("3001")
  })

  test("dedup of a repeated id — the lookup runs once, links are not duplicated", async () => {
    const ctx = makeCtx([
      {
        id: "doc-1",
        type: "invoice",
        scope: null,
        number: "INV-2026-0030",
        status: "issued",
        payment_status: "unpaid",
        shopify_order_id: "4001",
      },
    ])
    const result = await documentsForOrders(ctx, {
      shopify_order_ids: ["4001", "4001", "4001"],
    })
    expect(result.links).toHaveLength(1)
  })

  test("coerces numeric ids and strips a gid prefix to the same string id", async () => {
    const ctx = makeCtx([
      {
        id: "doc-1",
        type: "invoice",
        scope: null,
        number: "INV-2026-0040",
        status: "issued",
        payment_status: "unpaid",
        shopify_order_id: "5001",
      },
    ])
    const result = await documentsForOrders(ctx, {
      shopify_order_ids: [5001, "gid://shopify/Order/5001", "5001"],
    })
    expect(result.links).toHaveLength(1)
    expect(result.links[0]!.shopify_order_id).toBe("5001")
  })
})
