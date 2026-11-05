// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SMOKE — the minimal launch → install → reachability → UI-mount → teardown gate
// the visual + B-NEW-* scenarios build on. Proves the social `.liaisonapp` build
// artifact exists, the from-source install registers the app for the org, a read
// tool resolves (reachability, NOT `/api/apps` membership), and the social UI
// bundle mounts in the real SolidJS shell with no bundle-load error.
//
// (B0 already implicitly contains this path; extracting it as a named smoke makes
// the first green unambiguous and gives the visual suite a known-good mount path.)
import { loginAs } from "../fixtures/test"
import { assertSocialBundle, expect, test } from "./helpers/social-fixtures"
import { installSocialApp, resetSocialMock, socialTool } from "./helpers/social-harness"

test.describe("Social Ground Control smoke", () => {
  test("launch install reachability UI mount", async ({ page, env, world, qa }) => {
    assertSocialBundle()
    const token = qa.admin.token
    const s = env.serverUrl
    const orgId = world.org.id

    // ── Launch + reset the platform mock ──────────────────────────────────────
    await resetSocialMock(s, token)

    // ── Install from source (fails loudly with the build hint if the .liaisonapp
    //    is missing — the real infra dependency this smoke surfaces). ──────────
    const installed = await installSocialApp({ serverUrl: s, token, orgId })
    expect(installed.appName).toBe("social")
    expect(installed.connectedAccountId).toBeTruthy()

    // ── Reachability: a read tool resolves (200 + a findings array), proving the
    //    runtime registered the app's tools for this org. NOT /api/apps. ───────
    const reach = await socialTool({ serverUrl: s, token, tool: "findings_list", params: {} })
    expect(reach.status, JSON.stringify(reach.body)).toBe(200)
    expect(Array.isArray((reach.body as { findings?: unknown[] }).findings)).toBe(true)

    // ── UI mount in the real shell ────────────────────────────────────────────
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    const consoleErrors: string[] = []
    page.on("pageerror", (e) => consoleErrors.push(e.message))
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text())
    })
    await page.goto(`${viteUrl}/social/findings`)
    await page.waitForLoadState("networkidle")

    const mountError = page.locator('[data-testid="plugin-mount-error-social"]')
    if (await mountError.isVisible().catch(() => false)) {
      throw new Error(`social UI bundle failed to mount: ${await mountError.textContent()}`)
    }
    await expect(page.locator('[data-testid="social-findings-list"]')).toBeVisible({
      timeout: 15_000,
    })
    const bundleErrors = consoleErrors.filter((m) =>
      /Failed to fetch dynamically imported module|does not provide an export named|window\.__liaisonHost/.test(
        m,
      ),
    )
    expect(bundleErrors).toEqual([])
    // The smoke leaves no seeded findings — the worker fixture handles teardown.
  })
})
