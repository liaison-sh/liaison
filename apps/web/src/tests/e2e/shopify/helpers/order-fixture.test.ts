// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 E2E harness H3 — paired-fixture invariants for orders.
import { describe, expect, it } from "bun:test"
import {
  orderFixture,
  orderGraphqlNode,
  ordersGraphqlResponse,
  orderWebhookBody,
} from "./order-fixture"

describe("Shopify order fixtures", () => {
  it("graphql + webhook share the same identity for a given fixture", () => {
    const f = orderFixture({
      numericId: "1001",
      email: "buyer@example.com",
      totalPrice: "199.99",
      currency: "USD",
    })
    const node = orderGraphqlNode(f)
    const webhook = orderWebhookBody(f)
    expect(node.id).toBe("gid://shopify/Order/1001")
    expect(webhook.id).toBe(1001)
    expect(node.totalPriceSet.presentmentMoney.amount).toBe(webhook.total_price)
    expect(node.totalPriceSet.presentmentMoney.currencyCode).toBe(webhook.currency)
    expect(node.email).toBe(webhook.email)
  })

  it("maps fulfillment status — unfulfilled emits null in webhook + UNFULFILLED in graphql", () => {
    const f = orderFixture({ email: "x@x.com", fulfillmentStatus: "unfulfilled" })
    expect(orderGraphqlNode(f).displayFulfillmentStatus).toBe("UNFULFILLED")
    expect(orderWebhookBody(f).fulfillment_status).toBeNull()
  })

  it("maps partial → PARTIALLY_FULFILLED", () => {
    const f = orderFixture({ email: "x@x.com", fulfillmentStatus: "partial" })
    expect(orderGraphqlNode(f).displayFulfillmentStatus).toBe("PARTIALLY_FULFILLED")
    expect(orderWebhookBody(f).fulfillment_status).toBe("partial")
  })

  it("ordersGraphqlResponse wraps N fixtures", () => {
    const a = orderFixture({ numericId: "1", email: "a@x.com" })
    const b = orderFixture({ numericId: "2", email: "b@x.com" })
    const resp = ordersGraphqlResponse([a, b]) as {
      data: { orders: { nodes: unknown[] } }
    }
    expect(resp.data.orders.nodes.length).toBe(2)
  })
})
