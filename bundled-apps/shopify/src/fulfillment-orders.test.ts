// SPDX-License-Identifier: FSL-1.1-ALv2
//
// fulfillment_orders_get — the read half of truthful PARTIAL fulfillment.
// Mock-driven (fetch stub, no Postgres/shop creds) so it belongs in the vetted
// bundled-shopify CI list. Asserts the per-FO line items carry the ids and the
// remaining quantities an agent needs to build a partial fulfillments_create.
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { fulfillment_orders_get } from "./reads"

interface FetchCall {
  url: string
  body: string
}

function makeCtx(opts: { fetchResponses: unknown[] }): { ctx: AppContext; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const responses = [...opts.fetchResponses]
  const ctx = {
    userId: "u",
    orgId: "o",
    db: {
      findMany: async (entity: string) => {
        if (entity === "install_metadata") {
          return [
            {
              id: "i1",
              shopDomain: "demo.myshopify.com",
              connectionId: "ca1",
              apiVersion: "2026-04",
            },
          ]
        }
        return []
      },
      findOne: async () => null,
      insert: async () => ({ id: "x" }),
      update: async () => undefined,
      updateMany: async () => ({ count: 0 }),
      delete: async () => undefined,
      count: async () => 0,
    },
    emit: async () => undefined,
    enqueueJob: async () => undefined,
    resolveContact: async () => ({}),
    connections: {
      shop: {
        getAccounts: async () => [
          {
            id: "ca1",
            ownerType: "org" as const,
            ownerId: null,
            identifier: "demo.myshopify.com",
            displayName: null,
          },
        ],
        getToken: async () => "test-token",
      },
    },
    fetch: async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ?? "" })
      const next = responses.shift()
      return { status: 200, headers: {}, body: JSON.stringify(next ?? {}) }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as AppContext
  return { ctx, calls }
}

const fixture = {
  data: {
    order: {
      id: "gid://shopify/Order/1056",
      name: "#1056",
      fulfillmentOrders: {
        nodes: [
          {
            id: "gid://shopify/FulfillmentOrder/9001",
            status: "OPEN",
            assignedLocation: { name: "Paris Warehouse" },
            lineItems: {
              nodes: [
                {
                  id: "gid://shopify/FulfillmentOrderLineItem/1",
                  totalQuantity: 5,
                  remainingQuantity: 3,
                  lineItem: { id: "gid://shopify/LineItem/11", sku: "KS6-44", title: "Kestrel 6" },
                },
                {
                  id: "gid://shopify/FulfillmentOrderLineItem/2",
                  totalQuantity: 2,
                  remainingQuantity: 0,
                  lineItem: { id: "gid://shopify/LineItem/12", sku: "CASE-1", title: "Case" },
                },
              ],
            },
          },
          {
            id: "gid://shopify/FulfillmentOrder/9002",
            status: "CLOSED",
            assignedLocation: null,
            lineItems: { nodes: [] },
          },
        ],
      },
    },
  },
}

describe("fulfillment_orders_get — per-FO line items with remaining quantities", () => {
  it("returns the order's fulfillment orders with FO line item ids + remaining quantities", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [fixture] })
    const result = (await fulfillment_orders_get({ orderId: "gid://shopify/Order/1056" }, ctx)) as {
      orderId: string
      orderName: string | null
      fulfillmentOrders: Array<{
        id: string
        status: string | null
        assignedLocation: string | null
        lineItems: Array<{
          fulfillmentOrderLineItemId: string
          orderLineItemId: string | null
          sku: string | null
          title: string | null
          totalQuantity: number | null
          remainingQuantity: number | null
        }>
      }>
    }
    expect(calls).toHaveLength(1)
    const req = JSON.parse(calls[0]!.body) as { variables: { id: string } }
    expect(req.variables.id).toBe("gid://shopify/Order/1056")
    expect(result.orderId).toBe("gid://shopify/Order/1056")
    expect(result.orderName).toBe("#1056")
    expect(result.fulfillmentOrders).toHaveLength(2)
    const fo = result.fulfillmentOrders[0]!
    expect(fo.id).toBe("gid://shopify/FulfillmentOrder/9001")
    expect(fo.status).toBe("OPEN")
    expect(fo.assignedLocation).toBe("Paris Warehouse")
    expect(fo.lineItems).toEqual([
      {
        fulfillmentOrderLineItemId: "gid://shopify/FulfillmentOrderLineItem/1",
        orderLineItemId: "gid://shopify/LineItem/11",
        sku: "KS6-44",
        title: "Kestrel 6",
        totalQuantity: 5,
        remainingQuantity: 3,
      },
      {
        fulfillmentOrderLineItemId: "gid://shopify/FulfillmentOrderLineItem/2",
        orderLineItemId: "gid://shopify/LineItem/12",
        sku: "CASE-1",
        title: "Case",
        totalQuantity: 2,
        remainingQuantity: 0,
      },
    ])
    expect(result.fulfillmentOrders[1]!.status).toBe("CLOSED")
    expect(result.fulfillmentOrders[1]!.lineItems).toEqual([])
  })

  it("requires orderId", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    await expect(fulfillment_orders_get({}, ctx)).rejects.toThrow(/orderId/)
  })

  it("errors NOT_FOUND when the order does not exist", async () => {
    const { ctx } = makeCtx({ fetchResponses: [{ data: { order: null } }] })
    await expect(
      fulfillment_orders_get({ orderId: "gid://shopify/Order/404" }, ctx),
    ).rejects.toThrow(/not found/i)
  })
})
