// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Shopify orders list's cart summary reads per-product short codes from the kernel's product
// attributes, which the shipping app's daily `sync-product-codes` job fills from its product
// profiles. This drives that chain for real: product profiles with short codes exist (as after the
// migration that moved codes onto products, before any sync), the REAL job runs on the real queue
// in the sandbox (the test stands in for the cron clock), it resolves each Shopify variant's SKU
// through the shopify app, writes the attributes, and the rendered orders list shows "2×L4, 1×CB"
// where it showed the product's name before. Only the Shopify Admin API is mocked (offline mock).
//
// Fixtures are synthetic: products, SKUs, codes and order numbers are invented.

import type { WorkerEnv } from "@liaison/test-helpers"
import { api } from "@liaison/test-helpers"
import { BOXTAL_BUNDLE, expect, test } from "../boxtal/_boxtal-fixtures"
import { installBoxtalApp } from "../boxtal/helpers/install-boxtal-app"
import { resetMock } from "../boxtal/helpers/mock-boxtal"
import { SENDER, seedOpenOrders } from "../boxtal/helpers/seed-shipment"
import { loginAs } from "../fixtures/test"
import { ks } from "../helpers/db-reads"
import { installShopifyApp } from "./helpers/install-shopify-app"

test.setTimeout(240_000)

const LUMEN = { variantId: "gid://shopify/ProductVariant/4100001", sku: "SYN-LUMEN4-BLK" }
const CABLE = { variantId: "gid://shopify/ProductVariant/4100002", sku: "SYN-CABLE-2M" }
const STRAP = { variantId: "gid://shopify/ProductVariant/4100003", sku: "SYN-STRAP" }

/** A profile link's key for a Shopify variant: the numeric id, as the catalog stores it. */
function shopifyVariant(v: { variantId: string }) {
  return { product_source: "shopify", product_id: v.variantId.replace(/^.*\//, "") }
}

function boxtalSchema(env: WorkerEnv): string {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_boxtal"` : "app_boxtal"
}

async function shortCodeAttributes(env: WorkerEnv, orgId: string): Promise<Record<string, string>> {
  const rows = (await env.db.sql.unsafe(
    `SELECT sku, value FROM ${ks(env)}.product_attributes WHERE org_id = $1 AND key = 'short_code'`,
    [orgId],
  )) as Array<{ sku: string; value: string }>
  return Object.fromEntries(rows.map((r) => [r.sku, r.value]))
}

test.describe("Shopify orders: cart summary from product short codes", () => {
  // The list reads the OFFLINE Shopify mock for this file (see prep-grid.scenario.test.ts).
  const LIVE_BEFORE = process.env.SHOPIFY_E2E_LIVE ?? "1"
  let offlineArmed = false
  async function useOfflineShopify(env: {
    restart: (o: Record<string, unknown>) => Promise<void>
  }) {
    if (offlineArmed) return
    await env.restart({ env: { SHOPIFY_E2E_LIVE: "0" }, timeoutMs: 180_000 })
    offlineArmed = true
  }
  test.afterAll(async ({ env }) => {
    if (!offlineArmed) return
    await env.restart({ env: { SHOPIFY_E2E_LIVE: LIVE_BEFORE }, timeoutMs: 180_000 })
  })

  test("the daily short code sync writes the product attributes the cart summary shows", async ({
    page,
    env,
    world,
    qa,
  }) => {
    const s = env.serverUrl
    const token = qa.admin.token
    const orgId = world.org.id
    await useOfflineShopify(env as never)
    await resetMock(s, token)
    await installShopifyApp({ serverUrl: s, token, orgId })
    await installBoxtalApp({
      serverUrl: s,
      token,
      orgId,
      bundlePath: BOXTAL_BUNDLE,
      seedSenderAddress: SENDER,
      // Profiles hold the codes; the kernel's product attributes do not yet.
      seedProductProfiles: [
        { label: "Lumen 4", short_code: "L4", unit_weight: 0.9, ...shopifyVariant(LUMEN) },
        { label: "USB-C cable 2 m", short_code: "CB", unit_weight: 0.1, ...shopifyVariant(CABLE) },
      ],
    })
    // A line nobody profiled reads its product title.
    const [gid] = await seedOpenOrders(s, token, [
      {
        name: "#9201",
        email: "kai-sc@e2e.test",
        shippingAddress: {
          name: "Kai Example",
          address1: "3 rue du Sample",
          city: "Nantes",
          zip: "44000",
          country: "France",
          countryCode: "FR",
        },
        lineItems: [
          { title: "Lumen 4 controller", ...LUMEN, quantity: 2, unitAmount: "499.00" },
          { title: "USB-C cable 2 m", ...CABLE, quantity: 1, unitAmount: "12.00" },
          { title: "Carry strap", ...STRAP, quantity: 1, unitAmount: "19.00" },
        ],
      },
    ])
    expect(await shortCodeAttributes(env, orgId)).toEqual({})

    // Before the sync: the store's SKUs carry no code.
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/shopify/orders`)
    const cart = page.getByTestId(`shopify-orders-cart-${gid}`)
    await expect(cart).toHaveText("2× Lumen 4 controller, 1× USB-C cable 2 m, 1× Carry strap", {
      timeout: 30_000,
    })

    // The daily job, run now.
    const run = await api(s, "/api/_test/apps/run-job", {
      method: "POST",
      token,
      body: { orgId, app: "boxtal", job: "sync-product-codes" },
    })
    expect(run.status, JSON.stringify(run.body)).toBe(200)
    await expect
      .poll(() => shortCodeAttributes(env, orgId), { timeout: 60_000 })
      .toEqual({ [LUMEN.sku]: "L4", [CABLE.sku]: "CB" })
    // Nothing is left marked "not synced yet".
    const markers = (await env.db.sql.unsafe(
      `SELECT sku, state FROM ${boxtalSchema(env)}.short_code_sync WHERE org_id = $1`,
      [orgId],
    )) as Array<{ sku: string; state: string }>
    expect(markers).toEqual([])

    // The list, as a person opens it next: the codes, quantities summed, the unknown line kept.
    await page.reload()
    await expect(cart).toHaveText("2×L4, 1×CB, 1× Carry strap", { timeout: 30_000 })
  })
})
