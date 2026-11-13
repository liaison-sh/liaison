// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { GoogleConfigError } from "./lib/google-config"
import { merchant_feed_status, merchant_product_issues } from "./merchant-reads"
import { oneAccount, settingsFor } from "./test-connections.testutil"

interface FetchCall {
  url: string
  method: string
}

interface MockResponse {
  status: number
  body: string
}

function makeCtx(fetchResponses: MockResponse[]) {
  const calls: FetchCall[] = []
  let idx = 0
  const fetch = async (url: string, opts?: Record<string, unknown>) => {
    calls.push({ url, method: String(opts?.method ?? "GET") })
    const resp = fetchResponses[idx++]
    if (!resp) throw new Error(`No mock response for call ${idx} to ${url}`)
    return { status: resp.status, headers: {}, body: resp.body }
  }
  const connections = {
    google: { getAccounts: async () => oneAccount() },
    "google-config": {
      getSettings: async () =>
        settingsFor("google-config", {
          developerToken: "dev_tok_123",
          loginCustomerId: "9998887777",
          customerId: "1234567890",
          merchantId: "mc_1",
        }),
    },
  }
  return { ctx: { fetch, connections }, calls }
}

function noConnCtx() {
  return {
    ctx: {
      fetch: async () => {
        throw new Error("must not be called")
      },
      connections: {},
    },
  }
}

// ─── merchant_feed_status ──────────────────────────────────────────────────────

describe("merchant_feed_status", () => {
  it("hits GET /issueresolution/v1/accounts/{merchantId}/aggregateProductStatuses (live-verified sub-API)", async () => {
    const { ctx, calls } = makeCtx([
      {
        status: 200,
        body: JSON.stringify({
          aggregateProductStatuses: [
            {
              reportingContext: "SHOPPING_ADS",
              countryCode: "US",
              stats: {
                activeCount: "120",
                disapprovedCount: "8",
                pendingCount: "3",
                expiringCount: "2",
              },
              itemLevelIssues: [{ code: "price_mismatch", numProducts: "8" }],
            },
          ],
        }),
      },
    ])
    await merchant_feed_status({}, ctx)
    expect(calls[0]?.url).toContain("/issueresolution/v1/accounts/mc_1/aggregateProductStatuses")
  })

  it("sums stats.{activeCount,disapprovedCount,pendingCount,expiringCount} across every reportingContext entry", async () => {
    const { ctx } = makeCtx([
      {
        status: 200,
        body: JSON.stringify({
          aggregateProductStatuses: [
            {
              reportingContext: "SHOPPING_ADS",
              countryCode: "US",
              stats: {
                activeCount: "120",
                disapprovedCount: "8",
                pendingCount: "3",
                expiringCount: "2",
              },
              itemLevelIssues: [{ code: "price_mismatch", numProducts: "8" }],
            },
            {
              reportingContext: "FREE_LISTINGS",
              countryCode: "US",
              stats: {
                activeCount: "10",
                disapprovedCount: "1",
                pendingCount: "0",
                expiringCount: "0",
              },
              itemLevelIssues: [],
            },
          ],
        }),
      },
    ])
    const result = (await merchant_feed_status({}, ctx)) as {
      total: number
      approved: number
      disapproved: number
      pending: number
      expiring: number
      by_destination: Array<Record<string, unknown>>
    }
    expect(result.approved).toBe(130)
    expect(result.disapproved).toBe(9)
    expect(result.pending).toBe(3)
    expect(result.expiring).toBe(2)
    expect(result.total).toBe(139)
    expect(result.by_destination[0]?.destination).toBe("SHOPPING_ADS")
    expect(result.by_destination[0]?.num_items).toBe(8)
  })

  it("returns a structured google_not_connected envelope when the google connection is absent", async () => {
    const { ctx } = noConnCtx()
    const result = (await merchant_feed_status({}, ctx)) as { error?: { code: string } }
    expect(result.error?.code).toBe("google_not_connected")
  })
})

// ─── merchant_product_issues ────────────────────────────────────────────────────

describe("merchant_product_issues", () => {
  it("hits GET /products/v1/accounts/{merchantId}/products (no global version prefix)", async () => {
    const { ctx, calls } = makeCtx([
      {
        status: 200,
        body: JSON.stringify({ products: [] }),
      },
    ])
    await merchant_product_issues({}, ctx)
    expect(calls[0]?.url).toContain("/products/v1/accounts/mc_1/products")
  })

  it("reads issues from p.productStatus.itemLevelIssues and classifies a MIX of product-data and non-product-data issues correctly", async () => {
    const { ctx } = makeCtx([
      {
        status: 200,
        body: JSON.stringify({
          products: [
            {
              productId: "online:en:US:sku123",
              title: "Widget",
              productStatus: {
                itemLevelIssues: [
                  {
                    code: "price_mismatch",
                    description: "Price in feed does not match landing page",
                    detail: "Feed price €19.99 vs page price €24.99",
                    resolution: "merchant_action",
                    documentation: "https://support.google.com/merchants/answer/6324486",
                  },
                  {
                    code: "shipping_settings_missing",
                    description: "Shipping settings not configured",
                    detail: "Set up shipping settings in Merchant Center",
                    resolution: "merchant_action",
                    documentation: "https://support.google.com/merchants/answer/6069284",
                  },
                ],
              },
            },
          ],
        }),
      },
    ])
    const result = (await merchant_product_issues({}, ctx)) as {
      products: Array<{
        product_id: string
        issues: Array<{
          code: string
          klass: string
          recommended_action?: string
          shopify_edit_hint?: string
        }>
      }>
    }
    const issues = result.products[0]?.issues ?? []
    const priceIssue = issues.find((i) => i.code === "price_mismatch")
    const shippingIssue = issues.find((i) => i.code === "shipping_settings_missing")

    expect(priceIssue?.klass).toBe("product-data")
    expect(priceIssue?.shopify_edit_hint).toBeTruthy()

    expect(shippingIssue?.klass).toBe("non-product-data")
    // v1 has NO recommendedAction field — informational string is built from
    // detail/documentation/resolution.
    expect(shippingIssue?.recommended_action).toContain("shipping settings")
    // Non-product-data issues carry NO tool call / shopify edit hint.
    expect(shippingIssue?.shopify_edit_hint).toBeUndefined()
  })

  it("falls back to a top-level itemLevelIssues[] when productStatus is absent (fixture-compat)", async () => {
    const { ctx } = makeCtx([
      {
        status: 200,
        body: JSON.stringify({
          products: [
            {
              productId: "online:en:US:sku456",
              title: "Gadget",
              itemLevelIssues: [
                { code: "gtin_invalid", description: "Invalid GTIN", detail: "Bad GTIN value" },
              ],
            },
          ],
        }),
      },
    ])
    const result = (await merchant_product_issues({}, ctx)) as {
      products: Array<{ issues: Array<{ code: string; klass: string }> }>
    }
    expect(result.products[0]?.issues[0]?.code).toBe("gtin_invalid")
  })

  it("returns a structured google_not_connected envelope when the google connection is absent", async () => {
    const { ctx } = noConnCtx()
    const result = (await merchant_product_issues({}, ctx)) as { error?: { code: string } }
    expect(result.error?.code).toBe("google_not_connected")
  })
})
