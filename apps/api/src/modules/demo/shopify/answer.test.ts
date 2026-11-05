// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The GraphQL surface, operation by operation: what a demo org gets back when
// the bundled app asks the demo store a question, and what it gets back when it
// asks one the demo store does not answer.
//
// The end to end proof (the same operations issued by the REAL bundled app
// through the real runtime) is in demo-shopify-runtime.test.ts. This file is the
// cheap, broad half: every modelled operation returns a populated, coherent
// payload, and the unmodelled ones say so in Shopify's own error channel.
import { beforeEach, describe, expect, it } from "bun:test"
import { answerDemoShopify } from "./answer"
import { DemoShopifyFixturesTestAccess, demoShopifyBook } from "./fixtures"
import { resetDemoShopifyOverlay } from "./overlay"

const ORG = "00000000-0000-0000-0000-0000000d5001"
const UNSUPPORTED = "not modelled by the demo"
const WRITE_BLOCKED = "cannot be changed in the demo"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function call(
  operation: string,
  variables: Record<string, unknown> = {},
  kind: "query" | "mutation" = "query",
  document?: string,
): Promise<{ status: number; data: any; errors: any }> {
  const doc = document ?? `${kind} ${operation} { placeholder }`
  const response = answerDemoShopify({
    orgId: ORG,
    path: "/admin/api/2026-04/graphql.json",
    method: "POST",
    body: JSON.stringify({ query: doc, operationName: operation, variables }),
    unsupported: UNSUPPORTED,
    writeBlocked: WRITE_BLOCKED,
    json,
    extensions: {},
  })
  const body = (await response.json()) as { data?: unknown; errors?: unknown }
  return { status: response.status, data: body.data as any, errors: body.errors as any }
}

beforeEach(() => {
  DemoShopifyFixturesTestAccess.reset()
  resetDemoShopifyOverlay()
})

describe("the demo store answers the reads the apps send", () => {
  it("orders_search: a page, a server count and a usable cursor", async () => {
    const first = await call("OrdersSearch", { query: null, first: 10, after: null })
    expect(first.data.orders.edges).toHaveLength(10)
    expect(first.data.ordersCount.count).toBe(demoShopifyBook().orders.length)
    expect(first.data.orders.pageInfo.hasNextPage).toBe(true)

    const second = await call("OrdersSearch", {
      query: null,
      first: 10,
      after: first.data.orders.pageInfo.endCursor,
    })
    const firstIds = first.data.orders.edges.map((e: any) => e.node.id)
    const secondIds = second.data.orders.edges.map((e: any) => e.node.id)
    expect(secondIds).toHaveLength(10)
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false)
  })

  it("orders_search: the money on a hit adds up to its own line items", async () => {
    const page = await call("OrdersSearch", { query: null, first: 25 })
    for (const edge of page.data.orders.edges) {
      const node = edge.node
      const lines = node.lineItems.edges.reduce(
        (sum: number, li: any) =>
          sum +
          Math.round(Number(li.node.originalUnitPriceSet.presentmentMoney.amount) * 100) *
            li.node.quantity,
        0,
      )
      const subtotal = Math.round(Number(node.subtotalPriceSet.presentmentMoney.amount) * 100)
      const shipping = Math.round(
        Number(node.shippingLine?.originalPriceSet.presentmentMoney.amount ?? 0) * 100,
      )
      const total = Math.round(Number(node.originalTotalPriceSet.presentmentMoney.amount) * 100)
      expect(subtotal).toBe(lines)
      expect(total).toBe(subtotal + shipping)
    }
  })

  it("orders_search: the worklist filter narrows the page to shipping work", async () => {
    const worklist =
      "status:open AND (fulfillment_status:unfulfilled OR fulfillment_status:unshipped OR fulfillment_status:partial OR fulfillment_status:on_hold OR fulfillment_status:scheduled OR fulfillment_status:request_declined)"
    const all = await call("OrdersSearch", { query: null, first: 250 })
    const open = await call("OrdersSearch", { query: worklist, first: 250 })
    expect(open.data.ordersCount.count).toBeGreaterThanOrEqual(30)
    expect(open.data.ordersCount.count).toBeLessThan(all.data.ordersCount.count)
    for (const edge of open.data.orders.edges) {
      expect(edge.node.cancelledAt).toBeNull()
      expect(["UNFULFILLED", "PARTIALLY_FULFILLED", "ON_HOLD"]).toContain(
        edge.node.displayFulfillmentStatus,
      )
    }
  })

  it("orders_get: one order, by gid and by bare number, with its detail", async () => {
    const order = demoShopifyBook().orders[3]!
    const byGid = await call("OrderGet", { id: order.id })
    expect(byGid.data.order.name).toBe(order.name)
    expect(byGid.data.order.lineItems.edges.length).toBe(order.lineItems.length)
    expect(byGid.data.order.customer.email).toBe(order.email)
    const byNumber = await call("OrderGet", { id: String(order.numericId) })
    expect(byNumber.data.order.id).toBe(order.id)
    const missing = await call("OrderGet", { id: "gid://shopify/Order/1" })
    expect(missing.data.order).toBeNull()
  })

  it("customers_search: a populated page with counts and spend", async () => {
    const page = await call("CustomersSearch", { query: null, first: 50 })
    expect(page.data.customersCount.count).toBe(demoShopifyBook().customers.length)
    expect(page.data.customers.edges.length).toBeGreaterThan(20)
    const withOrders = page.data.customers.edges.filter(
      (e: any) => Number(e.node.numberOfOrders) > 0,
    )
    expect(withOrders.length).toBeGreaterThan(0)
    for (const edge of page.data.customers.edges) {
      expect(edge.node.email).toContain("@")
      expect(edge.node.defaultAddress.city).toBeTruthy()
    }
  })

  it("customers_search: a query narrows to the customer asked for", async () => {
    const target = demoShopifyBook().customers.find((c) => c.kind === "person")!
    const page = await call("CustomersSearch", { query: `email:${target.email}`, first: 10 })
    expect(page.data.customersCount.count).toBe(1)
    expect(page.data.customers.edges[0].node.email).toBe(target.email)
  })

  it("products_search and variants_search: the RAL catalog, priced and stocked", async () => {
    const products = await call("ProductsSearch", { query: null, first: 50 })
    expect(products.data.products.edges.length).toBe(demoShopifyBook().products.length)
    for (const edge of products.data.products.edges) {
      expect(edge.node.variants.edges[0].node.sku.startsWith("RAL-")).toBe(true)
      expect(Number(edge.node.variants.edges[0].node.price)).toBeGreaterThan(0)
    }
    const variants = await call("VariantsSearch", { query: "RAL-FLAG-01", first: 10 })
    expect(variants.data.productVariants.edges).toHaveLength(1)
    expect(
      variants.data.productVariants.edges[0].node.inventoryItem.harmonizedSystemCode,
    ).toBeTruthy()
  })

  it("draft_orders_list and get: quotes, some open, one with its order", async () => {
    const list = await call("DraftOrdersList", { query: null, first: 50 })
    expect(list.data.draftOrders.edges.length).toBeGreaterThan(5)
    const completed = list.data.draftOrders.edges.find((e: any) => e.node.status === "COMPLETED")
    expect(completed).toBeDefined()
    const detail = await call("DraftOrderGet", { id: completed.node.id })
    expect(detail.data.draftOrder.order.name).toBeTruthy()
    expect(detail.data.draftOrder.lineItems.edges.length).toBeGreaterThan(0)
  })

  it("home_load's four probes all come back populated", async () => {
    const recent = await call("RecentOrders", { first: 10 })
    expect(recent.data.orders.edges).toHaveLength(10)
    expect(recent.data.orders.edges[0].node.customer.displayName).toBeTruthy()

    const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString()
    const lookback = new Date(Date.now() - 60 * 86_400_000).toISOString()
    const unfulfilled = await call("Unfulfilled", {
      first: 20,
      query: `status:open AND fulfillment_status:unfulfilled AND created_at:<'${cutoff}' AND created_at:>'${lookback}'`,
    })
    expect(unfulfilled.data.orders.edges.length).toBeGreaterThan(0)

    const low = await call(
      "LowInventory",
      { first: 20 },
      "query",
      `query LowInventory($first: Int!) { productVariants(first: $first, query: "inventory_quantity:<=5 AND product_type:-giftcard") { edges { node { id sku } } } }`,
    )
    expect(low.data.productVariants.edges.length).toBeGreaterThan(0)

    const returns = await call("PendingReturns", { first: 20 })
    expect(returns.data.returns.edges.length).toBeGreaterThan(0)
    expect(returns.data.returns.edges[0].node.order.name).toBeTruthy()
  })

  it("locations and inventory levels agree with the variant's own stock", async () => {
    const locations = await call("LocationsList", { first: 10 })
    expect(locations.data.locations.edges).toHaveLength(2)
    const variant = [...demoShopifyBook().variantsById.values()][0]!
    const levels = await call("InventoryLevels", { id: variant.inventoryItemId, first: 10 })
    const onHand = levels.data.inventoryItem.inventoryLevels.edges.reduce(
      (sum: number, e: any) =>
        sum + (e.node.quantities.find((q: any) => q.name === "on_hand")?.quantity ?? 0),
      0,
    )
    expect(onHand).toBe(variant.inventoryQuantity)
  })

  it("fulfillment orders count down what is still owed", async () => {
    const partial = demoShopifyBook().orders.find(
      (o) => o.fulfillmentStatus === "PARTIALLY_FULFILLED",
    )!
    const result = await call("OrderFulfillmentOrdersGet", { id: partial.id })
    const lines = result.data.order.fulfillmentOrders.nodes[0].lineItems.nodes
    expect(lines.length).toBe(partial.lineItems.length)
    expect(lines.filter((l: any) => l.remainingQuantity === 0).length).toBeGreaterThan(0)
    expect(lines.filter((l: any) => l.remainingQuantity > 0).length).toBeGreaterThan(0)
  })

  it("returns are reachable per order and by status", async () => {
    const withReturn = demoShopifyBook().orders.find((o) => o.returns.length > 0)!
    const byOrder = await call("ReturnsByOrderId", { id: withReturn.id })
    expect(byOrder.data.order.returns.edges.length).toBe(withReturn.returns.length)
    const search = await call("ReturnsByOrders", {
      query:
        "(return_status:in_progress OR return_status:returned OR return_status:return_requested)",
      first: 50,
    })
    expect(search.data.orders.edges.length).toBeGreaterThan(0)
  })

  it("answers the bare shop probe every connection check sends", async () => {
    const response = answerDemoShopify({
      orgId: ORG,
      path: "/admin/api/2026-04/graphql.json",
      method: "POST",
      body: JSON.stringify({ query: "{ shop { id name myshopifyDomain } }" }),
      unsupported: UNSUPPORTED,
      writeBlocked: WRITE_BLOCKED,
      json,
      extensions: {},
    })
    const body = (await response.json()) as any
    expect(body.data.shop.myshopifyDomain).toBe("resonant-audio-labs-demo.myshopify.com")
  })

  it("says so, in the error channel, for a read it does not model", async () => {
    const result = await call("SomethingNobodyModelled", { first: 10 })
    expect(result.data).toBeNull()
    expect(result.errors[0].message).toBe(UNSUPPORTED)
    expect(result.errors[0].extensions.code).toBe("DEMO_UNSUPPORTED")
  })

  it("refuses the OAuth token exchange rather than minting a fake install", async () => {
    const response = answerDemoShopify({
      orgId: ORG,
      path: "/admin/oauth/access_token",
      method: "POST",
      body: "{}",
      unsupported: UNSUPPORTED,
      writeBlocked: WRITE_BLOCKED,
      json,
      extensions: {},
    })
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain("access_token")
  })
})

describe("the demo store takes the writes that tell a story", () => {
  it("tagging an order is visible on the very next read", async () => {
    const order = demoShopifyBook().orders[0]!
    const added = await call("TagsAdd", { id: order.id, tags: ["priority"] }, "mutation")
    expect(added.data.tagsAdd.userErrors).toEqual([])
    const read = await call("OrderGet", { id: order.id })
    expect(read.data.order.tags).toContain("priority")
    await call("TagsRemove", { id: order.id, tags: ["priority"] }, "mutation")
    const after = await call("OrderGet", { id: order.id })
    expect(after.data.order.tags).not.toContain("priority")
  })

  it("shipping the rest of an order takes it off the worklist", async () => {
    const worklist =
      "status:open AND (fulfillment_status:unfulfilled OR fulfillment_status:partial)"
    const before = await call("OrdersSearch", { query: worklist, first: 250 })
    const target = before.data.orders.edges.find(
      (e: any) => e.node.displayFulfillmentStatus === "UNFULFILLED",
    ).node

    const shipped = await call(
      "FulfillmentCreateV2",
      {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: `${target.id}/FulfillmentOrder/1` }],
          trackingInfo: { company: "DHL Express", number: "TRACK-DEMO-1" },
        },
      },
      "mutation",
    )
    expect(shipped.data.fulfillmentCreateV2.userErrors).toEqual([])
    expect(shipped.data.fulfillmentCreateV2.fulfillment.trackingInfo[0].number).toBe("TRACK-DEMO-1")

    const read = await call("OrderGet", { id: target.id })
    expect(read.data.order.displayFulfillmentStatus).toBe("FULFILLED")
    const after = await call("OrdersSearch", { query: worklist, first: 250 })
    expect(after.data.ordersCount.count).toBe(before.data.ordersCount.count - 1)
  })

  it("a refund lands on the order and never exceeds what was charged", async () => {
    const order = demoShopifyBook().orders.find(
      (o) => o.refunds.length === 0 && o.cancelledAt === null,
    )!
    const first = await call(
      "RefundCreate",
      {
        input: {
          orderId: order.id,
          note: "Goodwill refund",
          transactions: [{ amount: "10.00", kind: "REFUND" }],
        },
        idempotencyKey: "k1",
      },
      "mutation",
    )
    expect(first.data.refundCreate.userErrors).toEqual([])
    expect(first.data.refundCreate.refund.totalRefundedSet.presentmentMoney.amount).toBe("10.00")

    const huge = await call(
      "RefundCreate",
      {
        input: {
          orderId: order.id,
          transactions: [{ amount: "999999.00", kind: "REFUND" }],
        },
        idempotencyKey: "k2",
      },
      "mutation",
    )
    const refunded = Number(huge.data.refundCreate.refund.totalRefundedSet.presentmentMoney.amount)
    expect(refunded).toBe((order.totalMinor - 1000) / 100)

    const read = await call("OrderGet", { id: order.id })
    expect(read.data.order.displayFinancialStatus).toBe("REFUNDED")
    expect(Number(read.data.order.currentTotalPriceSet.presentmentMoney.amount)).toBe(0)

    const third = await call(
      "RefundCreate",
      { input: { orderId: order.id, transactions: [{ amount: "1.00" }] }, idempotencyKey: "k3" },
      "mutation",
    )
    expect(third.data.refundCreate.refund).toBeNull()
    expect(third.data.refundCreate.userErrors[0].message).toContain("already been refunded")
  })

  it("completing a quote links it to an order, once", async () => {
    const list = await call("DraftOrdersList", { query: "status:open", first: 50 })
    const draft = list.data.draftOrders.edges[0].node
    const done = await call(
      "DraftOrderComplete",
      { id: draft.id, paymentPending: false },
      "mutation",
    )
    expect(done.data.draftOrderComplete.userErrors).toEqual([])
    expect(done.data.draftOrderComplete.draftOrder.order.name).toMatch(/^#/)

    const read = await call("DraftOrderGet", { id: draft.id })
    expect(read.data.draftOrder.status).toBe("COMPLETED")

    const again = await call("DraftOrderComplete", { id: draft.id }, "mutation")
    expect(again.data.draftOrderComplete.userErrors[0].message).toContain("already")
  })

  it("creating a quote lists it first, reads it back, and it completes like any other", async () => {
    const variant = [...demoShopifyBook().variantsById.values()][0]!
    const made = await call(
      "DraftOrderCreate",
      {
        input: {
          email: "buyer@school.example",
          note: "Education tier pricing.",
          lineItems: [
            { variantId: variant.id, quantity: 2 },
            {
              title: "Extended Care Plan",
              quantity: 10,
              originalUnitPriceWithCurrency: { amount: "79.00", currencyCode: "EUR" },
            },
          ],
        },
      },
      "mutation",
    )
    expect(made.data.draftOrderCreate.userErrors).toEqual([])
    const created = made.data.draftOrderCreate.draftOrder
    const total = (variant.priceMinor * 2 + 7900 * 10) / 100
    expect(Number(created.totalPriceSet.presentmentMoney.amount)).toBe(total)

    const list = await call("DraftOrdersList", { query: "status:open", first: 5 })
    expect(list.data.draftOrders.edges[0].node.id).toBe(created.id)
    const read = await call("DraftOrderGet", { id: created.id })
    expect(read.data.draftOrder.email).toBe("buyer@school.example")
    expect(read.data.draftOrder.lineItems.edges.map((e: any) => e.node.quantity)).toEqual([2, 10])

    const done = await call("DraftOrderComplete", { id: created.id }, "mutation")
    expect(done.data.draftOrderComplete.userErrors).toEqual([])
    expect((await call("DraftOrderGet", { id: created.id })).data.draftOrder.status).toBe(
      "COMPLETED",
    )
  })

  it("refuses a quote with no lines or an unknown variant, as Shopify does", async () => {
    const empty = await call("DraftOrderCreate", { input: { lineItems: [] } }, "mutation")
    expect(empty.data.draftOrderCreate.draftOrder).toBeNull()
    expect(empty.data.draftOrderCreate.userErrors).toHaveLength(1)
    const unknown = await call(
      "DraftOrderCreate",
      { input: { lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }] } },
      "mutation",
    )
    expect(unknown.data.draftOrderCreate.draftOrder).toBeNull()
    expect(unknown.data.draftOrderCreate.userErrors[0].message).toContain("Variant")
  })

  it("setting a note keeps it, and cancelling closes the order", async () => {
    const order = demoShopifyBook().orders.find((o) => o.cancelledAt === null)!
    await call(
      "OrderNoteSet",
      { input: { id: order.id, note: "Call before delivery" } },
      "mutation",
    )
    expect((await call("OrderNoteGet", { id: order.id })).data.order.note).toBe(
      "Call before delivery",
    )
    const cancelled = await call(
      "OrderCancel",
      { orderId: order.id, reason: "CUSTOMER", refund: false, restock: true },
      "mutation",
    )
    expect(cancelled.data.orderCancel.userErrors).toEqual([])
    const read = await call("OrderGet", { id: order.id })
    expect(read.data.order.cancelledAt).not.toBeNull()
    expect(read.data.order.cancelReason).toBe("CUSTOMER")
  })

  it("keeps one org's writes out of another org's store", async () => {
    const order = demoShopifyBook().orders[1]!
    await call("TagsAdd", { id: order.id, tags: ["mine"] }, "mutation")
    const other = answerDemoShopify({
      orgId: "00000000-0000-0000-0000-0000000d5002",
      path: "/admin/api/2026-04/graphql.json",
      method: "POST",
      body: JSON.stringify({
        query: "query OrderGet($id: ID!) { order(id: $id) { tags } }",
        operationName: "OrderGet",
        variables: { id: order.id },
      }),
      unsupported: UNSUPPORTED,
      writeBlocked: WRITE_BLOCKED,
      json,
      extensions: {},
    })
    const body = (await other.json()) as any
    expect(body.data.order.tags).not.toContain("mine")
  })

  it("creates a discount code, and the discounts list and read back show it", async () => {
    const created = await call(
      "DiscountCodeBasicCreate",
      {
        basicCodeDiscount: {
          title: "Autumn teaching rooms",
          code: "TEACHING26",
          startsAt: "2020-01-01T00:00:00.000Z",
          endsAt: null,
          customerSelection: { all: true },
          customerGets: { value: { percentage: 0.15 }, items: { all: true } },
          appliesOncePerCustomer: true,
          usageLimit: 40,
        },
      },
      "mutation",
    )
    expect(created.errors).toBeUndefined()
    const payload = created.data.discountCodeBasicCreate
    expect(payload.userErrors).toEqual([])
    expect(payload.codeDiscountNode.id).toMatch(/^gid:\/\/shopify\/DiscountCodeNode\/\d+$/)
    expect(payload.codeDiscountNode.codeDiscount).toMatchObject({
      __typename: "DiscountCodeBasic",
      title: "Autumn teaching rooms",
      status: "ACTIVE",
      usageLimit: 40,
      summary: "15% off entire order",
    })

    const list = await call("DiscountsSearch", { query: null, first: 10, after: null })
    expect(list.data.codeDiscountNodes.edges).toHaveLength(1)
    const node = list.data.codeDiscountNodes.edges[0].node
    expect(node.id).toBe(payload.codeDiscountNode.id)
    expect(node.codeDiscount.codes.edges[0].node.code).toBe("TEACHING26")
    const byKeyword = await call("DiscountsSearch", { query: "teaching", first: 10 })
    expect(byKeyword.data.codeDiscountNodes.edges).toHaveLength(1)
    const miss = await call("DiscountsSearch", { query: "blackfriday", first: 10 })
    expect(miss.data.codeDiscountNodes.edges).toHaveLength(0)

    const back = await call("DiscountNodeCodes", { id: node.id, first: 5 })
    expect(back.data.codeDiscountNode.codeDiscount.title).toBe("Autumn teaching rooms")
    expect(back.data.codeDiscountNode.codeDiscount.codes.nodes).toEqual([
      expect.objectContaining({ code: "TEACHING26" }),
    ])
  })

  it("reads a discount that starts later as SCHEDULED, as Shopify does", async () => {
    await call(
      "DiscountCodeBasicCreate",
      {
        basicCodeDiscount: {
          title: "Next week",
          code: "LATER",
          startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        },
      },
      "mutation",
    )
    const list = await call("DiscountsSearch", { first: 10 })
    expect(list.data.codeDiscountNodes.edges[0].node.codeDiscount.status).toBe("SCHEDULED")
  })

  it("refuses a duplicate discount code in Shopify's userErrors, and keeps it per org", async () => {
    const input = { basicCodeDiscount: { title: "Once", code: "ONCE10" } }
    await call("DiscountCodeBasicCreate", input, "mutation")
    const again = await call(
      "DiscountCodeBasicCreate",
      { basicCodeDiscount: { title: "Twice", code: "once10" } },
      "mutation",
    )
    expect(again.data.discountCodeBasicCreate.codeDiscountNode).toBeNull()
    expect(again.data.discountCodeBasicCreate.userErrors[0].message).toMatch(/unique/i)

    const other = answerDemoShopify({
      orgId: "00000000-0000-0000-0000-0000000d5002",
      path: "/admin/api/2026-04/graphql.json",
      method: "POST",
      body: JSON.stringify({
        query: "query DiscountsSearch { codeDiscountNodes { edges { node { id } } } }",
        operationName: "DiscountsSearch",
        variables: { first: 10 },
      }),
      unsupported: UNSUPPORTED,
      writeBlocked: WRITE_BLOCKED,
      json,
      extensions: {},
    })
    const body = (await other.json()) as any
    expect(body.data.codeDiscountNodes.edges).toEqual([])
  })

  it("bulk-adds codes to a created discount, as discounts_bulk_create runs it", async () => {
    // The bundled handler's sequence: create with the first code, bulk-add the
    // rest, poll the job until done, read the codes back.
    const created = await call(
      "DiscountCodeBasicCreate",
      { basicCodeDiscount: { title: "Press", code: "PRESS-AAAA001", usageLimit: 1 } },
      "mutation",
    )
    const discountId = created.data.discountCodeBasicCreate.codeDiscountNode.id as string
    const rest = ["PRESS-AAAA002", "PRESS-AAAA003", "PRESS-AAAA004"]
    const added = await call(
      "DiscountRedeemCodeBulkAdd",
      { discountId, codes: rest.map((code) => ({ code })) },
      "mutation",
    )
    expect(added.errors).toBeUndefined()
    expect(added.data.discountRedeemCodeBulkAdd.userErrors).toEqual([])
    const jobId = added.data.discountRedeemCodeBulkAdd.bulkCreation.id as string
    expect(jobId).toMatch(/^gid:\/\/shopify\/DiscountRedeemCodeBulkCreation\/\d+$/)

    const status = await call("DiscountBulkCreationStatus", { id: jobId })
    expect(status.data.discountRedeemCodeBulkCreation).toEqual({
      id: jobId,
      done: true,
      codesCount: 3,
      importedCount: 3,
      failedCount: 0,
    })

    const back = await call("DiscountNodeCodes", { id: discountId, first: 9 })
    expect(
      back.data.codeDiscountNode.codeDiscount.codes.nodes.map((n: { code: string }) => n.code),
    ).toEqual(["PRESS-AAAA001", ...rest])

    const list = await call("DiscountsSearch", { query: null, first: 10 })
    expect(list.data.codeDiscountNodes.edges).toHaveLength(1)
    expect(list.data.codeDiscountNodes.edges[0].node.codeDiscount.codesCount.count).toBe(4)
    // A bulk-added code finds its discount by keyword too.
    const byCode = await call("DiscountsSearch", { query: "PRESS-AAAA003", first: 10 })
    expect(byCode.data.codeDiscountNodes.edges[0].node.id).toBe(discountId)
  })

  it("does not import a bulk code the org already has, in any case, and says so in failedCount", async () => {
    await call(
      "DiscountCodeBasicCreate",
      { basicCodeDiscount: { title: "Other", code: "TAKEN" } },
      "mutation",
    )
    const created = await call(
      "DiscountCodeBasicCreate",
      { basicCodeDiscount: { title: "Press", code: "NEW-1" } },
      "mutation",
    )
    const discountId = created.data.discountCodeBasicCreate.codeDiscountNode.id as string
    const added = await call(
      "DiscountRedeemCodeBulkAdd",
      {
        discountId,
        codes: [{ code: "taken" }, { code: "new-1" }, { code: "NEW-2" }, { code: "new-2" }],
      },
      "mutation",
    )
    const jobId = added.data.discountRedeemCodeBulkAdd.bulkCreation.id as string
    const status = await call("DiscountBulkCreationStatus", { id: jobId })
    expect(status.data.discountRedeemCodeBulkCreation).toMatchObject({
      done: true,
      codesCount: 4,
      importedCount: 1,
      failedCount: 3,
    })
    const back = await call("DiscountNodeCodes", { id: discountId, first: 9 })
    expect(
      back.data.codeDiscountNode.codeDiscount.codes.nodes.map((n: { code: string }) => n.code),
    ).toEqual(["NEW-1", "NEW-2"])
  })

  it("refuses a bulk add to a discount this org does not have, and caps the per-org overlay", async () => {
    const missing = await call(
      "DiscountRedeemCodeBulkAdd",
      { discountId: "gid://shopify/DiscountCodeNode/1", codes: [{ code: "X" }] },
      "mutation",
    )
    expect(missing.data.discountRedeemCodeBulkAdd.bulkCreation).toBeNull()
    expect(missing.data.discountRedeemCodeBulkAdd.userErrors).toHaveLength(1)

    const created = await call(
      "DiscountCodeBasicCreate",
      { basicCodeDiscount: { title: "Many", code: "MANY-0" } },
      "mutation",
    )
    const discountId = created.data.discountCodeBasicCreate.codeDiscountNode.id as string
    const batch = (from: number) =>
      Array.from({ length: 250 }, (_, i) => ({ code: `MANY-${from + i}` }))
    const first = await call(
      "DiscountRedeemCodeBulkAdd",
      { discountId, codes: batch(1) },
      "mutation",
    )
    expect(first.data.discountRedeemCodeBulkAdd.userErrors).toEqual([])
    // 1 + 250 codes + 1 job are held; another 250 would pass the 500 cap.
    const second = await call(
      "DiscountRedeemCodeBulkAdd",
      { discountId, codes: batch(251) },
      "mutation",
    )
    expect(second.data.discountRedeemCodeBulkAdd.userErrors[0].message).toBe(WRITE_BLOCKED)
    const back = await call("DiscountNodeCodes", { id: discountId, first: 250 })
    expect(back.data.codeDiscountNode.codeDiscount.codesCount.count).toBe(251)
  })

  it("still refuses every other discount write", async () => {
    for (const [operation, variables] of [
      [
        "DiscountCodeBasicUpdate",
        { id: "gid://shopify/DiscountCodeNode/1", basicCodeDiscount: {} },
      ],
      ["DiscountCodeDelete", { id: "gid://shopify/DiscountCodeNode/1" }],
    ] as const) {
      const result = await call(operation, variables, "mutation")
      expect(result.data).toBeNull()
      expect(result.errors[0].extensions.code).toBe("DEMO_WRITE_BLOCKED")
    }
  })

  it("refuses a write it does not model, rather than reporting a success", async () => {
    const result = await call("ProductCreate", { input: { title: "Fake" } }, "mutation")
    expect(result.data).toBeNull()
    expect(result.errors[0].message).toBe(WRITE_BLOCKED)
    expect(result.errors[0].extensions.code).toBe("DEMO_WRITE_BLOCKED")
  })
})
