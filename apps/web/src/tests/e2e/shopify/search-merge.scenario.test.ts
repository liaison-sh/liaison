// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 e2e S3 — command-palette external-search section (M1).
//
// Validates that after installing Shopify + seeding a mock GraphQL
// `CustomersSearch` response, the unified command palette renders a
// per-app "From Shopify" section sourced from `fanoutExternal`.
import { resolve } from "node:path"
import { bundledAppTarball } from "../bundled-app-tarball"
import { loginAs } from "../fixtures/test"
import { expect, requireShopifyCreds, test } from "./_shopify-fixtures"
import { installShopifyApp } from "./helpers/install-shopify-app"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const SHOPIFY_BUNDLE = bundledAppTarball(LIAISON_ROOT, "shopify")

test.describe("Shopify: search merge", () => {
  test("command palette renders From Shopify section when external results are available", async ({
    page,
    env,
    world,
    qa,
    shopifyConfig,
  }) => {
    requireShopifyCreds(shopifyConfig)
    // 1. Install + connect against real dev store. The store is seeded
    //    via `bundled-apps/shopify/scripts/dev-store-seed.ts` with
    //    deterministic customers including `marie@example.com`.
    await installShopifyApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      shopDomain: shopifyConfig.shopDomain,
      realOfflineToken: shopifyConfig.offlineToken,
      realWebhookSecret: shopifyConfig.webhookSecret,
      bundlePath: SHOPIFY_BUNDLE,
    })

    // 2. The query targets a real seeded customer — no GraphQL mock needed.
    const QUERY_EMAIL = "marie@example.com"

    // 3. Login + open command palette via Cmd+K (the canonical shortcut).
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/`)
    await page.waitForLoadState("networkidle")

    // Trigger the palette via `mod+p` (kernel keybinding — see Shell.tsx).
    await page.keyboard.press("Meta+P")
    const palette = page.getByTestId("command-palette-input")
    if (!(await palette.isVisible().catch(() => false))) {
      await page.keyboard.press("Control+P")
    }
    await expect(palette).toBeVisible({ timeout: 5_000 })

    // 4. Type an email query — the Shopify search handler matches the
    //    EMAIL_RE branch and runs customers_search.
    await palette.fill(QUERY_EMAIL)

    // 5. The "From Shopify" section MUST render with the seeded customer.
    //    Criterion #7 is the merge actually firing — accepting "palette still
    //    visible" as a fallback (the prior soft assertion) proved nothing: it
    //    passed whether or not the external search ran. This now fails loud if
    //    `fanoutExternal` → the Shopify search handler → `customers_search`
    //    doesn't surface the deterministic seed customer (`marie@example.com`,
    //    seeded as "Marie Dupont").
    //    The palette renders merged results as a flat list of buttons; an
    //    external (`source:"external"`) Shopify customer hit renders with
    //    `label` = the customer display name and `secondary` = "shopify:customer"
    //    (see CommandPalette.tsx external-result mapping). We assert the result
    //    row for Marie Dupont, marked as a Shopify-sourced entity, is present.
    const dialog = page.getByRole("dialog")
    const shopifyResult = dialog
      .locator("button", { hasText: /Marie Dupont/i })
      .filter({ hasText: /shopify/i })
    await expect(shopifyResult.first()).toBeVisible({ timeout: 15_000 })
  })
})
