// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M3 fix round, item 1: the Boxtal shipments list at 390 px.
//
// Boxtal's shipments screen is a master/detail pair, and the master pane
// carried a hard `w-[440px]`. Inside the shell's phone surface that is 50 px
// wider than the viewport, so the CardTable cards rendered correctly and then
// had their money column and status pills sliced off the right edge. The
// document never grew, so the old `scrollWidth` oracle called it green: this
// scenario uses the geometry oracle in `phone-helpers.ts` instead.
import { assertBoxtalBundle, BOXTAL_BUNDLE, expect, test } from "./boxtal/_boxtal-fixtures"
import { installBoxtalApp } from "./boxtal/helpers/install-boxtal-app"
import { loginAs } from "./fixtures/test"
import { SHOT_DIR } from "./helpers/shot-dir"
import { expectNoHorizontalClipping } from "./phone-helpers"

const SHIPMENT_ROWS = {
  results: [
    {
      id: "ord_globex_1",
      entity: "shipment",
      title: "Globex US",
      attributes: {
        order_status: "CONFIRMED",
        tracking_status: "IN_TRANSIT",
        carrier: "CHRP-Chrono13",
        declared_value: 1250.4,
        currency: "EUR",
        tracking_number: "CR260530000000000KZN1FR",
        tracking_events: [],
      },
    },
    {
      id: "ord_initech_2",
      entity: "shipment",
      title: "Initech Paris",
      attributes: {
        order_status: "PENDING",
        tracking_status: null,
        carrier: "MONR-CpourToi",
        declared_value: 89,
        currency: "EUR",
        tracking_number: null,
        tracking_events: [],
      },
    },
  ],
}

const MOCKS: Record<string, unknown> = {
  "boxtal:search": SHIPMENT_ROWS,
  "boxtal:get_documents": { documents: [] },
  "boxtal:queue_counts": { to_prepare: 0, prep: 0, ready: 0, returns: 0, stuck: 0 },
}

async function installHostMockInterceptor(page: import("@playwright/test").Page) {
  await page.addInitScript((m: Record<string, unknown>) => {
    const norm = (k: string) => k.replace(/\./g, "_")
    const lookup = (key: string): { hit: boolean; value: unknown } => {
      if (Object.hasOwn(m, key)) return { hit: true, value: m[key] }
      const n = norm(key)
      for (const mk of Object.keys(m)) {
        if (norm(mk) === n) return { hit: true, value: m[mk] }
      }
      return { hit: false, value: undefined }
    }
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
            const { hit, value } = lookup(`${appName}:${toolName}`)
            if (hit) return value
            const orig = original.invokeTool as
              | ((a: string, t: string, args: Record<string, unknown>) => Promise<unknown>)
              | undefined
            if (orig) return orig.call(original, appName, toolName, args)
            throw new Error(`unmocked tool: ${appName}:${toolName}`)
          },
        }
      },
    })
  }, MOCKS)
}

test.describe("Boxtal shipments at phone width", () => {
  test.setTimeout(120_000)

  test.beforeAll(async ({ env, world, qa }) => {
    assertBoxtalBundle()
    await installBoxtalApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
    })
  })

  test("the shipments master pane fits the viewport and renders cards", async ({
    page,
    env,
    qa,
  }) => {
    await installHostMockInterceptor(page)
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/boxtal/shipments`)
    await page.waitForLoadState("networkidle")

    const list = page.getByTestId("boxtal-shipments-list")
    await expect(list).toBeVisible({ timeout: 20_000 })

    // (a) The kit rendered its card variant, one card per shipment.
    const cards = page.getByTestId("card-table-card")
    await expect(cards.first()).toBeVisible({ timeout: 20_000 })
    expect(await cards.count()).toBe(2)
    expect(await page.locator("table").count()).toBe(0)

    // (b) The master pane itself is no wider than the phone.
    const pane = await list.boundingBox()
    expect(pane).not.toBeNull()
    expect((pane?.x ?? 0) + (pane?.width ?? 0)).toBeLessThanOrEqual(390 + 1)

    // (c) And nothing inside it is sliced off: the money and the status pills
    //     are the cells the fixed width used to eat.
    await expect(cards.first()).toContainText("Globex US")
    await expectNoHorizontalClipping(page)

    await page.screenshot({ path: `${SHOT_DIR}/m3fx-boxtal-shipments.png`, fullPage: true })
  })
})
