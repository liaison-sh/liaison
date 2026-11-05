// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 — Shopify customs data flow.
//
// Proves, against the REAL dev store, that (a) the Shopify connection works and
// (b) we receive products AND retrieve their customs details. HS code +
// country of origin are NATIVE Shopify fields (InventoryItem); the goods
// description is the `custom.customs_description` metafield — all three are now
// fetched by `shopify:products_search`/`products_get` and surfaced per variant.
//
// The invoicing side that consumes this — `onShopifyProductChanged` syncing
// each variant into `product_customs_overlay` so export invoices auto-carry
// HS/CoO/description — is unit-tested in
// `bundled-apps/invoicing/src/handlers/shopify-product-changed.test.ts`.
//
// Real-creds gated (honest Phase-16 mirror): runs only with SHOPIFY_DEV_STORE_*
// present. The customs *values* are whatever the dev store has set; this test
// asserts the fields are fetched (present on the shape) and logs whether any
// product actually carries an HS code.
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import { bundledAppTarball } from "../bundled-app-tarball"
import { installShopifyApp } from "../shopify/helpers/install-shopify-app"
import { expect, requireShopifyCreds, test } from "./_invoicing-fixtures"
import { EXPECTED_CUSTOMS, seedShopifyCustomsProduct } from "./helpers/seed-shopify-customs"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const SHOPIFY_BUNDLE = bundledAppTarball(LIAISON_ROOT, "shopify")
const SEEDED_TITLE = "Liaison E2E — Customs Test Product"
const API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-01"

interface NormalizedHit {
  id?: string
  title?: string
  attributes?: {
    customs_description?: unknown
    variants?: Array<{
      hs_code?: unknown
      country_of_origin?: unknown
      customs_description?: unknown
    }>
  }
}

test.describe("Invoicing: Shopify customs data", () => {
  test("connection works; products_search retrieves real customs data (HS / CoO / description)", async ({
    env,
    world,
    qa,
    shopifyConfig,
  }) => {
    requireShopifyCreds(shopifyConfig)

    // 0. Seed the dogfood store: ensure the `custom.customs_description` metafield
    //    definition exists and a dedicated test product carries HS code + country
    //    of origin + the metafield. Idempotent — never touches the real catalog.
    await seedShopifyCustomsProduct({
      shopDomain: shopifyConfig.shopDomain,
      token: shopifyConfig.offlineToken,
      apiVersion: API_VERSION,
    })

    // 1. Connection works — install + connect against the REAL dev store
    //    (real offline token), not the mock, so products_search hits live data.
    const shopify = await installShopifyApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: SHOPIFY_BUNDLE,
      shopDomain: shopifyConfig.shopDomain,
      realOfflineToken: shopifyConfig.offlineToken,
      realWebhookSecret: shopifyConfig.webhookSecret,
    })
    expect(shopify.connectionId).toBeTruthy()

    // 2. We receive products from Shopify, narrowed to the seeded fixture. The
    //    real-creds install writes install_metadata via the async
    //    connected_account:create handler, so poll through that race.
    const productsSearch = () =>
      api(env.serverUrl, "/api/apps/shopify/tools/products_search", {
        method: "POST",
        token: qa.admin.token,
        body: { params: { query: SEEDED_TITLE, limit: 25 } },
      })
    let resp = await productsSearch()
    const startedAt = Date.now()
    while (resp.status !== 200 && Date.now() - startedAt < 20_000) {
      await new Promise((r) => setTimeout(r, 1000))
      resp = await productsSearch()
    }
    expect(resp.status, JSON.stringify(resp.body)).toBe(200)
    const body = (resp.body ?? {}) as Record<string, unknown>
    const data = ("data" in body && body.data ? body.data : body) as { results?: NormalizedHit[] }
    const results = data.results ?? []
    expect(results.length, "expected the dev store to return products").toBeGreaterThan(0)

    // 3. We retrieve the REAL customs details — every variant carries the native
    //    HS/CoO keys and the product carries the customs-description metafield.
    const seeded = results.find((p) => p.title === SEEDED_TITLE)
    expect(seeded, `seeded product "${SEEDED_TITLE}" should be in the results`).toBeTruthy()
    const variants = seeded?.attributes?.variants ?? []
    expect(variants.length).toBeGreaterThan(0)
    const customsVariant = variants.find((v) => v.hs_code === EXPECTED_CUSTOMS.hsCode)
    expect(customsVariant, "expected a variant carrying the seeded HS code").toBeTruthy()
    expect(customsVariant?.country_of_origin).toBe(EXPECTED_CUSTOMS.countryOfOrigin)
    expect(seeded?.attributes?.customs_description).toBe(EXPECTED_CUSTOMS.customsDescription)

    // eslint-disable-next-line no-console
    console.log(
      `[shopify-customs] retrieved HS=${customsVariant?.hs_code} CoO=${customsVariant?.country_of_origin} desc="${seeded?.attributes?.customs_description}"`,
    )
  })
})
