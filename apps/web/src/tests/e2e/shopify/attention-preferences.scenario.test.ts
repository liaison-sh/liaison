// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 e2e S4 — attention preferences UI.
//
// Validates Task A8b — the in-tree `/settings/attention-rules` page
// renders a row per installed app with a filterable-axes panel and an
// enable/disable toggle. The Shopify app's `attention.filterableAxes`
// (declared in the manifest at `bundled-apps/shopify/app.manifest.json`)
// surface here once the app is installed.
//
// Full A8a/A8b coverage (webhook injection → attention-row materialization
// gated by user subscription) is a deeper integration concern; this
// scenario covers the user-facing settings surface.
import { resolve } from "node:path"
import { bundledAppTarball } from "../bundled-app-tarball"
import { loginAs } from "../fixtures/test"
import { expect, requireShopifyCreds, test } from "./_shopify-fixtures"
import { installShopifyApp } from "./helpers/install-shopify-app"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const SHOPIFY_BUNDLE = bundledAppTarball(LIAISON_ROOT, "shopify")

test.describe("Shopify: attention preferences", () => {
  test("attention-rules page lists shopify row + toggle after install", async ({
    page,
    env,
    world,
    qa,
    shopifyConfig,
  }) => {
    requireShopifyCreds(shopifyConfig)
    // 1. Install shopify against the real dev store so the kernel manifest
    //    registry surfaces its `attention.filterableAxes` block.
    const installed = await installShopifyApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      shopDomain: shopifyConfig.shopDomain,
      realOfflineToken: shopifyConfig.offlineToken,
      realWebhookSecret: shopifyConfig.webhookSecret,
      bundlePath: SHOPIFY_BUNDLE,
    })
    expect(installed.appName).toBe("shopify")

    // 2. Navigate to the attention-rules settings page.
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/settings/attention-rules`)
    await page.waitForLoadState("networkidle")

    // 3. The page root testid is visible (in-tree kernel page — no plugin
    //    bundle to load).
    await expect(page.getByTestId("attention-rules")).toBeVisible({ timeout: 10_000 })

    // 4. The shopify row + toggle render once the manifest registry has
    //    the app's attention block. May take a tick after install →
    //    manifest registry refresh propagates.
    await expect(page.getByTestId("attention-rules-row-shopify")).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByTestId("attention-rules-toggle-shopify")).toBeVisible()
  })
})
