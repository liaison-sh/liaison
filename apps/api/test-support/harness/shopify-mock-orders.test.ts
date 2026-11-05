// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The offline Shopify mock's SEEDABLE OPEN ORDERS.
//
// The boxtal prep grid's worklist IS the set of open unfulfilled orders, and it reads each order's
// ship-to address and line items. The mock's legacy order window is all FULFILLED and carries
// neither, so a local scenario could not host a single row of that grid. These pin the seam:
// seeded orders answer OrdersSearch and OrderGet, the query terms the worklist actually sends are
// honoured, and the analytics fixtures are untouched while nothing is seeded.

import { afterEach, describe, expect, it } from "bun:test"
import {
  clearShopifyMockOrders,
  makeShopifyMockFetch,
  seedShopifyMockOrders,
} from "./shopify-mock-fetch"

const mockFetch = makeShopifyMockFetch()
const ENDPOINT = "https://mock-dev-store.myshopify.com/admin/api/2025-01/graphql.json"

const OPEN_ORDERS_QUERY = "fulfillment_status:unfulfilled status:open"

async function graphql(
  operationName: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await mockFetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationName, query, variables }),
  })
  const body = (await res.json()) as { data: Record<string, unknown> }
  return body.data
}

function ordersSearch(query: string) {
  return graphql(
    "OrdersSearch",
    "query OrdersSearch($query: String, $first: Int!) { orders { edges { node { id } } } }",
    {
      query,
      first: 50,
    },
  ) as Promise<{ orders: { edges: Array<{ node: Record<string, unknown> }> } }>
}

function orderGet(id: string) {
  return graphql("OrderGet", "query OrderGet($id: ID!) { order(id: $id) { id } }", {
    id,
  }) as Promise<{
    order: Record<string, unknown> | null
  }>
}

describe("Shopify mock: seedable open orders", () => {
  afterEach(() => clearShopifyMockOrders())

  it("serves a seeded UNFULFILLED order to the worklist query, and hides a fulfilled one", async () => {
    seedShopifyMockOrders([
      { name: "#9001", email: "open@example.test", fulfillmentStatus: "UNFULFILLED" },
      { name: "#9002", email: "done@example.test", fulfillmentStatus: "FULFILLED" },
    ])
    const data = await ordersSearch(OPEN_ORDERS_QUERY)
    const names = data.orders.edges.map((e) => e.node.name)
    expect(names).toContain("#9001")
    expect(names).not.toContain("#9002")
    // The legacy analytics window is fulfilled too, so it never pollutes the worklist.
    expect(names).not.toContain("#1001")
  })

  it("hides a cancelled order from status:open, and finds one by name", async () => {
    seedShopifyMockOrders([
      { name: "#9003" },
      { name: "#9004", cancelledAt: "2026-08-01T00:00:00.000Z" },
    ])
    const open = await ordersSearch(OPEN_ORDERS_QUERY)
    expect(open.orders.edges.map((e) => e.node.name)).toEqual(["#9003"])
    const byName = await ordersSearch("name:#9004")
    expect(byName.orders.edges.map((e) => e.node.name)).toEqual(["#9004"])
  })

  it("returns the shipping address, its phone and the line items on OrderGet", async () => {
    const [id] = seedShopifyMockOrders([
      {
        name: "#9005",
        email: "quinn@example.test",
        shippingAddress: {
          name: "Quinn Buyer",
          address1: "12 rue des Lilas",
          city: "Nantes",
          zip: "44000",
          country: "France",
          countryCode: "FR",
          phone: "+33612345678",
        },
        lineItems: [{ title: "Tessera 2", sku: "RAL-44", quantity: 2 }],
      },
    ])
    const { order } = await orderGet(id!)
    expect(order).not.toBeNull()
    const addr = (order as { shippingAddress: Record<string, string> }).shippingAddress
    expect(addr).toMatchObject({
      name: "Quinn Buyer",
      address1: "12 rue des Lilas",
      city: "Nantes",
      zip: "44000",
      countryCode: "FR",
      phone: "+33612345678",
    })
    const lines = (order as { lineItems: { edges: Array<{ node: Record<string, unknown> }> } })
      .lineItems.edges
    expect(lines).toHaveLength(1)
    expect(lines[0]!.node).toMatchObject({ title: "Tessera 2", quantity: 2 })
    expect((lines[0]!.node.variant as { sku: string }).sku).toBe("RAL-44")
    // A search hit for the same order carries the country and the SKU summary too.
    const hit = (await ordersSearch(OPEN_ORDERS_QUERY)).orders.edges[0]!.node
    expect((hit.shippingAddress as { countryCode: string }).countryCode).toBe("FR")
  })

  it("returns a null order for an id nothing was seeded under, rather than inventing one", async () => {
    const { order } = await orderGet("gid://shopify/Order/999999")
    expect(order).toBeNull()
  })

  it("clears seeded orders on reset, and leaves the legacy analytics window answering as before", async () => {
    seedShopifyMockOrders([{ name: "#9006" }])
    expect((await ordersSearch(OPEN_ORDERS_QUERY)).orders.edges).toHaveLength(1)
    clearShopifyMockOrders()
    expect((await ordersSearch(OPEN_ORDERS_QUERY)).orders.edges).toHaveLength(0)
    // The bounded-tally degrade sends no fulfillment term and must still see its three orders.
    const legacy = await ordersSearch("")
    expect(legacy.orders.edges.map((e) => e.node.name)).toEqual(["#1001", "#1002", "#1003"])
  })
})
