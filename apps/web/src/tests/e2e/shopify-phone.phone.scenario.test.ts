// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M3-1: the Shopify orders list at 390 px.
//
// A bundled app cannot import the kernel's own UI, so until now every
// first-party app painted a fixed-width `<table>` that a phone can only scroll
// sideways. The lists now render through `CardTable` from `@liaison/app-ui`,
// which reads each column's ROLE: a dense table from 640 px up, a stack of
// cards below it. This scenario proves the card half against the REAL bundle:
// it installs the frozen `.liaisonapp`, serves canned tool responses the way
// `shopify/visual.scenario.test.ts` does (so it needs no dev-store creds), and
// drives the orders list in the `iphone` project.
import { resolve } from "node:path"
import { bundledAppTarball } from "./bundled-app-tarball"
import { loginAs } from "./fixtures/test"
import { SHOT_DIR } from "./helpers/shot-dir"
import { expectNoHorizontalClipping } from "./phone-helpers"
import { expect, test } from "./shopify/_shopify-fixtures"
import { installShopifyApp } from "./shopify/helpers/install-shopify-app"

// __dirname = liaison/apps/web/src/tests/e2e
const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..")
const SHOPIFY_BUNDLE = bundledAppTarball(LIAISON_ROOT, "shopify")

const ORDER_GID = "gid://shopify/Order/12768069779622"

const MOCKS: Record<string, unknown> = {
  "shopify:home_load": {
    connection: { shopDomain: "mock-shop.myshopify.com" },
    attention: { lowInventory: [], unfulfilledOrders: [], pendingReturns: [] },
    recentOrders: { orders: [] },
  },
  "shopify:orders_search": {
    results: [
      {
        id: ORDER_GID,
        entity: "order",
        title: "#1001",
        currency: "EUR",
        attributes: {
          customer: { displayName: "Marie Dupont", email: "marie@example.com" },
          fulfillmentStatus: "fulfilled",
          financialStatus: "paid",
          totalAmount: "189.50",
          shopCurrency: "EUR",
          processedAt: "2026-09-02T10:00:00.000Z",
          createdAt: "2026-09-02T10:00:00.000Z",
          cancelledAt: null,
        },
      },
      {
        id: "gid://shopify/Order/12768069779623",
        entity: "order",
        title: "#1000",
        currency: "EUR",
        attributes: {
          customer: { displayName: "Adrian Lopez", email: "adrian@example.com" },
          fulfillmentStatus: null,
          financialStatus: "paid",
          totalAmount: "139.00",
          shopCurrency: "EUR",
          processedAt: "2026-09-01T10:00:00.000Z",
          createdAt: "2026-09-01T10:00:00.000Z",
          cancelledAt: null,
        },
      },
    ],
    nextCursor: null,
  },
  "shopify:draft_orders_list": { results: [], nextCursor: null },
  "shopify:orders_invoice_links": {
    links: [
      {
        order_id: ORDER_GID,
        invoice_id: "inv-1",
        number: "FA-2026-0001",
        type: "invoice",
        scope: "goods",
        status: "issued",
        payment_status: "paid",
      },
    ],
  },
}

async function installHostMockInterceptor(page: import("@playwright/test").Page) {
  await page.addInitScript((mocks: Record<string, unknown>) => {
    // biome-ignore lint/suspicious/noExplicitAny: window-level shim
    let real: any
    // biome-ignore lint/suspicious/noExplicitAny: window-level shim
    Object.defineProperty(window as any, "__liaisonHost", {
      configurable: true,
      get() {
        return real
      },
      set(h: unknown) {
        const original = h as Record<string, unknown>
        real = {
          ...original,
          invokeTool: async (appName: string, toolName: string, args: Record<string, unknown>) => {
            const key = `${appName}:${toolName}`
            if (Object.hasOwn(mocks, key)) return mocks[key]
            const orig = original.invokeTool as
              | ((a: string, t: string, args: Record<string, unknown>) => Promise<unknown>)
              | undefined
            if (orig) return orig.call(original, appName, toolName, args)
            throw new Error(`unmocked tool: ${key}`)
          },
        }
      },
    })
  }, MOCKS)
}

test.describe("Shopify lists at phone width", () => {
  test.beforeAll(async ({ env, world, qa }) => {
    await installShopifyApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: SHOPIFY_BUNDLE,
    })
  })

  test("the orders list is cards, not a sideways table", async ({ page, env, qa }) => {
    await installHostMockInterceptor(page)
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/shopify/orders`)
    await page.waitForLoadState("networkidle")

    const list = page.getByTestId("shopify-orders-list")
    await expect(list).toBeVisible({ timeout: 15_000 })

    // (a) The kit rendered its card variant, one card per merged row.
    const cards = page.getByTestId("card-table-card")
    await expect(cards.first()).toBeVisible({ timeout: 15_000 })
    expect(await cards.count()).toBe(2)

    // (b) The table variant is NOT in the DOM at all at this width.
    expect(await page.locator("table").count()).toBe(0)

    // (c) The anchor and its number are on the card's headline.
    await expect(cards.first()).toContainText("#1001")
    await expect(cards.first()).toContainText("189.50")
    // The secondary line is the customer the order belongs to.
    await expect(cards.first()).toContainText("Marie Dupont")
    // The headline number is painted once, not once per meta pass.
    expect((await cards.first().innerText()).match(/189\.50/g)).toHaveLength(1)
    // The folded invoice column is NOT painted until the card is tapped.
    await expect(cards.first()).not.toContainText("FA-2026-0001")

    // (d) Nothing spills sideways. Geometry, not `scrollWidth`: a pane that
    // clips its own content inside `overflow-auto` never grows the document.
    await expectNoHorizontalClipping(page)

    await page.screenshot({ path: `${SHOT_DIR}/m3-shopify-orders.png`, fullPage: true })

    // (e) Tapping the chevron reveals the fold grid with the invoice link.
    await cards.first().getByTestId("card-table-expand").tap()
    const fold = cards.first().getByTestId("card-table-fold")
    await expect(fold).toBeVisible()
    await expect(fold).toContainText("Invoice")
    await expect(fold).toContainText("FA-2026-0001")

    // Expanding must not have broken the width budget either.
    await expectNoHorizontalClipping(page)

    await page.screenshot({ path: `${SHOT_DIR}/m3-shopify-expanded.png`, fullPage: true })
  })
})
