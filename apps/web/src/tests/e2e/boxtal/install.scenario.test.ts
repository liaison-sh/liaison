// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 e2e S0 — install + settings panel mounts (infra proof).
//
// Proves the load-bearing infrastructure end-to-end BEFORE any other scenario:
//   1. The re-frozen `boxtal-0.1.0.liaisonapp` exists + declares the
//      `cross_app_calls:[invoicing:documents_get]` block (the dogfood K4 fix).
//   2. The install route drives the full server-side dance: install tarball,
//      reload runtime, seed the 5-key credentials connection, MINT the webhook
//      secret, register the two v3 subscriptions THROUGH THE SANDBOX-FETCH MOCK.
//   3. `/api/apps` lists `boxtal` as `source:"installed"`.
//   4. After login, `/settings/boxtal` lands on the app's settings page, whose
//      connections block shows the seeded Boxtal account connected, and
//      `window.__liaisonHost` carries the four bridge methods, with no
//      bundle-load console errors.
//   5. The mock recorder shows the connect path hit the mocked v3 token +
//      content-category + subscription endpoints (proving the interceptor wired).
import { existsSync, readFileSync, statSync } from "node:fs"
import { api } from "@liaison/test-helpers"
import { loginAs } from "../fixtures/test"
import {
  assertBoxtalBundle,
  BOXTAL_BUNDLE,
  BOXTAL_MANIFEST,
  expect,
  test,
} from "./_boxtal-fixtures"
import { installBoxtalApp } from "./helpers/install-boxtal-app"
import { getRequests, resetMock } from "./helpers/mock-boxtal"

test.describe("Boxtal: install smoke", () => {
  test("install harness completes; settings panel mounts; host bridge OK; subscribe hit the mock", async ({
    page,
    env,
    world,
    qa,
  }) => {
    // 1. Pre-install manifest checks — the bundle exists and declares the
    //    cross-app grant that makes the dogfood K4 read fire.
    assertBoxtalBundle()
    expect(existsSync(BOXTAL_BUNDLE)).toBe(true)
    expect(statSync(BOXTAL_BUNDLE).size).toBeGreaterThan(1024)
    const manifest = JSON.parse(readFileSync(BOXTAL_MANIFEST, "utf8")) as {
      name: string
      version: string
      cross_app_calls?: Array<{ target: string }>
      connections?: { boxtal?: { allowedDomains?: string[]; webhookSecretConfigKey?: string } }
    }
    expect(manifest.name).toBe("boxtal")
    expect(manifest.cross_app_calls?.some((c) => c.target === "invoicing:documents_get")).toBe(true)
    expect(manifest.connections?.boxtal?.webhookSecretConfigKey).toBe("boxtalWebhookSecret")

    const token = qa.admin.token
    await resetMock(env.serverUrl, token)

    // 2. Drive the install (seeds credentials, mints webhook secret, subscribes).
    const installed = await installBoxtalApp({
      serverUrl: env.serverUrl,
      token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
    })
    expect(installed.appName).toBe("boxtal")
    expect(installed.connectionId).toBeTruthy()
    // K-WEBHOOK-SECRET: a 64-hex secret was minted into apps.config.
    expect(installed.webhookSecret).toBeTruthy()
    expect(installed.webhookSecret).toMatch(/^[0-9a-f]{64}$/)
    // onConnectionEstablished registered both subscriptions through the mock.
    expect(installed.webhookStatus).toBe("active")

    // 3. /api/apps lists boxtal as installed.
    const appsResp = await api(env.serverUrl, "/api/apps", { method: "GET", token })
    expect(appsResp.status).toBe(200)
    const apps = (
      Array.isArray(appsResp.body) ? appsResp.body : (appsResp.body as { data?: unknown[] }).data
    ) as Array<{ name: string; source?: string }>
    const boxtalApp = apps.find((a) => a.name === "boxtal")
    expect(boxtalApp).toBeTruthy()
    expect(boxtalApp?.source).toBe("installed")

    // 5. The mock recorder shows the connect path exercised the interceptor:
    //    a v3 token exchange + a content-category validation read + two
    //    subscription POSTs (the onConnectionEstablished path).
    const reqs = await getRequests(env.serverUrl, token)
    const paths = reqs.map((r) => new URL(r.url).pathname)
    expect(paths).toContain("/iam/account-app/token")
    expect(paths).toContain("/shipping/v3.1/content-category")
    const subPosts = reqs.filter(
      (r) => r.method === "POST" && new URL(r.url).pathname === "/shipping/v3.1/subscription",
    )
    expect(subPosts.length).toBe(2)

    // 4. Login + navigate; capture bundle-load errors during mount.
    const consoleErrors: string[] = []
    page.on("pageerror", (e) => consoleErrors.push(e.message))
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text())
    })

    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/settings/boxtal`)
    await page.waitForLoadState("networkidle")

    // The settings page renders, its connections block reading the seeded
    // credentials connection.
    await expect(page).toHaveURL(/\/settings\/apps\/boxtal/)
    await expect(page.getByTestId("connections-conn-boxtal")).toContainText("Connected", {
      timeout: 15_000,
    })
    await expect(page.getByTestId("settings-section-sender")).toBeVisible()

    // window.__liaisonHost has the four bridge methods.
    const hostShape = await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: window-global probe
      const h = (window as any).__liaisonHost
      return {
        hasFetch: typeof h?.fetch === "function",
        hasInvokeTool: typeof h?.invokeTool === "function",
        hasOpenConnect: typeof h?.openConnect === "function",
        hasAccessToken: typeof h?.accessToken === "function",
      }
    })
    expect(hostShape).toEqual({
      hasFetch: true,
      hasInvokeTool: true,
      hasOpenConnect: true,
      hasAccessToken: true,
    })

    const bridgeErrors = consoleErrors.filter((m) =>
      /window\.__liaisonHost|Failed to fetch dynamically imported module|does not provide an export named|ctx\.requestApproval is not a function/.test(
        m,
      ),
    )
    expect(bridgeErrors).toEqual([])
  })
})
