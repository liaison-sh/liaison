// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 E2E harness H3 — paired order fixtures.
//
// See `customer-fixture.ts` header for the rationale; the same
// graphql/webhook lockstep applies here for `orders/create` ingestion.

export interface OrderFixture {
  shopifyId: string
  numericId: string
  name: string
  email: string
  marketId: string
  totalPrice: string
  currency: string
  fulfillmentStatus: "unfulfilled" | "fulfilled" | "partial"
}

export interface OrderGraphqlNode {
  id: string
  name: string
  email: string
  market: { id: string } | null
  totalPriceSet: { presentmentMoney: { amount: string; currencyCode: string } }
  displayFulfillmentStatus: string
  createdAt: string
  updatedAt: string
}

export interface OrderWebhookBody {
  id: number
  name: string
  email: string
  total_price: string
  currency: string
  fulfillment_status: string | null
  created_at: string
  updated_at: string
}

const FIXED_CREATED = "2026-05-01T12:00:00Z"
const FIXED_UPDATED = "2026-05-01T12:00:00Z"

export function orderFixture(opts: {
  numericId?: string
  name?: string
  email: string
  marketId?: string
  totalPrice?: string
  currency?: string
  fulfillmentStatus?: OrderFixture["fulfillmentStatus"]
}): OrderFixture {
  const numericId = opts.numericId ?? "1001"
  return {
    shopifyId: `gid://shopify/Order/${numericId}`,
    numericId,
    name: opts.name ?? `#${numericId}`,
    email: opts.email,
    marketId: opts.marketId ?? "gid://shopify/Market/1",
    totalPrice: opts.totalPrice ?? "100.00",
    currency: opts.currency ?? "EUR",
    fulfillmentStatus: opts.fulfillmentStatus ?? "unfulfilled",
  }
}

export function orderGraphqlNode(f: OrderFixture): OrderGraphqlNode {
  const fulfillmentMap: Record<OrderFixture["fulfillmentStatus"], string> = {
    unfulfilled: "UNFULFILLED",
    fulfilled: "FULFILLED",
    partial: "PARTIALLY_FULFILLED",
  }
  return {
    id: f.shopifyId,
    name: f.name,
    email: f.email,
    market: { id: f.marketId },
    totalPriceSet: {
      presentmentMoney: { amount: f.totalPrice, currencyCode: f.currency },
    },
    displayFulfillmentStatus: fulfillmentMap[f.fulfillmentStatus],
    createdAt: FIXED_CREATED,
    updatedAt: FIXED_UPDATED,
  }
}

export function orderWebhookBody(f: OrderFixture): OrderWebhookBody {
  return {
    id: Number(f.numericId),
    name: f.name,
    email: f.email,
    total_price: f.totalPrice,
    currency: f.currency,
    fulfillment_status: f.fulfillmentStatus === "unfulfilled" ? null : f.fulfillmentStatus,
    created_at: FIXED_CREATED,
    updated_at: FIXED_UPDATED,
  }
}

export function ordersGraphqlResponse(fixtures: OrderFixture[]): unknown {
  return {
    data: {
      orders: {
        nodes: fixtures.map(orderGraphqlNode),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    extensions: {
      cost: {
        actualQueryCost: fixtures.length,
        throttleStatus: {
          currentlyAvailable: 1999,
          maximumAvailable: 2000,
          restoreRate: 100,
        },
      },
    },
  }
}
