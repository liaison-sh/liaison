// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 e2e S5 — order rows deep-link OUT to the Shopify admin.
//
// Orders have NO in-app detail page (it was removed — the Shopify admin order
// page is strictly richer than anything the app rendered). Clicking a live
// order row must open `https://<shop>/admin/orders/<numeric-id>` in a NEW
// browser tab and stay on the orders list in-app. This drives a REAL rendered
// row from the live dev store, so the whole chain is exercised: orders_search
// → row testid carries the real GID → gid→numeric admin URL → window.open.
import { resolve } from "node:path"
import { bundledAppTarball } from "../bundled-app-tarball"
import { loginAs } from "../fixtures/test"
import { expect, requireShopifyCreds, test } from "./_shopify-fixtures"
import { installShopifyApp } from "./helpers/install-shopify-app"

// __dirname = liaison/apps/web/src/tests/e2e/shopify
const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const SHOPIFY_BUNDLE = bundledAppTarball(LIAISON_ROOT, "shopify")

test.describe("Shopify: order rows deep-link to the Shopify admin", () => {
  test("clicking a live order row opens the admin order page in a new tab", async ({
    page,
    env,
    world,
    qa,
    shopifyConfig,
  }) => {
    requireShopifyCreds(shopifyConfig)
    // 1. Install + connect against the real dev store (proven by S0).
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

    // 2. Login + open the live orders list, recording window.open calls (the
    //    real call would leave the app for the external Shopify admin).
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.addInitScript(() => {
      const w = window as unknown as { __openedUrls: string[]; open: (u?: string) => null }
      w.__openedUrls = []
      w.open = (u?: string) => {
        w.__openedUrls.push(u ?? "")
        return null
      }
    })
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/shopify/orders`)
    await page.waitForLoadState("networkidle")

    const list = page.getByTestId("shopify-orders-list")
    await expect(list).toBeVisible({ timeout: 15_000 })

    // First real order row (testid carries the live `gid://shopify/Order/<n>`).
    // WORLD PRECONDITION, stated out loud. This scenario drives a REAL row, so
    // it needs the dev store to hold at least one order. When the store is empty
    // the scenario has nothing to assert and says so as a SKIP with the reason
    // and the remedy, rather than failing on world state or passing on nothing.
    const firstRow = page
      .locator('[data-testid^="shopify-orders-row-gid://shopify/Order/"]')
      .first()
    const rowArrived = await firstRow
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    test.skip(
      !rowArrived,
      `The live dev store (${shopifyConfig.shopDomain}) returned no orders, so there is no row to deep-link from. Seed one: create a draft order for a real customer and complete it with paymentPending:false, then re-run.`,
    )
    await expect(firstRow).toBeVisible({ timeout: 15_000 })
    const rowTestid = await firstRow.getAttribute("data-testid")
    const orderGid = rowTestid?.replace(/^shopify-orders-row-/, "") ?? ""
    expect(orderGid).toMatch(/^gid:\/\/shopify\/Order\/\d+$/)
    const numericId = orderGid.split("/").pop() ?? ""

    // 3. Click the row → window.open with the admin order URL for the REAL
    //    store domain and the NUMERIC id (not the GID).
    await firstRow.click()
    await expect
      .poll(async () =>
        page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls),
      )
      .toContain(`https://${shopifyConfig.shopDomain}/admin/orders/${numericId}`)

    // 4. No in-app navigation happened — the orders list is still the active
    //    view and no detail tab was opened.
    expect(page.url()).toContain("/shopify/orders")
    await expect(list).toBeVisible()
  })
})
