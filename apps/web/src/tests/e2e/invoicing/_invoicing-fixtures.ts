// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 — Shared Playwright fixtures for the Invoicing E2E scenarios.
//
// Extends the base test with optional Shopify-real-creds detection so
// scenario S2 (auto-flow from a real-Shopify webhook) can self-skip in
// CI without dragging the rest of the suite. The Shopify env detection
// mirrors `shopify/_shopify-fixtures.ts` exactly — the
// invoicing app's auto-flow goes through the same `customers/create` +
// `orders/paid` webhook plumbing.
import { test as base } from "../fixtures/test"

export interface ShopifyRealConfigForInvoicing {
  shopDomain: string
  offlineToken: string
  webhookSecret: string
  apiVersion: string
  baseUrl: string
  available: boolean
  missing: string[]
}

type WorkerFixtures = {
  shopifyConfig: ShopifyRealConfigForInvoicing
}

function readShopifyConfig(): ShopifyRealConfigForInvoicing {
  const shopDomain = process.env.SHOPIFY_DEV_STORE_DOMAIN ?? ""
  const offlineToken = process.env.SHOPIFY_DEV_STORE_OFFLINE_TOKEN ?? ""
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET ?? ""
  const apiVersion = process.env.SHOPIFY_API_VERSION ?? "2026-01"

  const missing: string[] = []
  if (!shopDomain) missing.push("SHOPIFY_DEV_STORE_DOMAIN")
  if (!offlineToken) missing.push("SHOPIFY_DEV_STORE_OFFLINE_TOKEN")
  if (!webhookSecret) missing.push("SHOPIFY_WEBHOOK_SECRET")

  return {
    shopDomain,
    offlineToken,
    webhookSecret,
    apiVersion,
    baseUrl: shopDomain ? `https://${shopDomain}` : "",
    available: missing.length === 0,
    missing,
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const test = base.extend<{}, WorkerFixtures>({
  shopifyConfig: [
    async ({}, use) => {
      await use(readShopifyConfig())
    },
    { scope: "worker" },
  ],
})

export { expect } from "../fixtures/test"
// Hard-fail (not skip) when real Shopify creds are absent. Shared with the shopify suite
// so both suites enforce identical gating semantics.
export { requireShopifyCreds } from "../shopify/_shopify-fixtures"
