// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 13 — V-1: visual goldens across i18n / data-export. Cropped
// container locators (never full-window), interleaved with functional sanity
// assertions so a surface that *looks* right but is broken still fails
// (mirrors the mcp-settings-visual interleave discipline). Viewport is locked by
// playwright.config (1440×900, deviceScaleFactor 1) — these tests must NOT
// call setViewportSize. maxDiffPixelRatio 0.02 = repo standard.
//
// The entity preview surface (info card + Open action) is covered functionally
// in entity-actions-routing.scenario.test.ts (mention -> preview -> Open opens
// the entity's tab); it carries no pixel golden of its own because that flow
// already collides with this file's login+thread+mention dance under 2-worker
// parallelism on the shared worker schema.

import { login } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { enableAppForOrg } from "./helpers/org-export"
import { grantTicketsScopes, seedTicket } from "./helpers/seed"

// Visual diff tolerance + animation suppression. Without `animations: "disabled"`
// the app-panel + sidebar enter/exit transitions can land mid-frame in the
// screenshot, producing a 2–3% pixel drift on otherwise-stable runs. Playwright
// disables CSS animations and finalises transform/opacity to their end-state
// when this flag is set.
const DIFF = { maxDiffPixelRatio: 0.02, animations: "disabled" as const }

async function switchLanguage(page: Page, language: "en" | "fr"): Promise<void> {
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().endsWith("/api/user/preferences/language"),
  )
  await page.getByTestId("settings-language-select").selectOption(language)
  expect((await saved).ok()).toBe(true)
  await expect(page.locator("html")).toHaveAttribute("lang", language)
}
test("visual: Settings language EN vs FR (visual i18n end-to-end)", async ({ page, env }) => {
  await loginAs(page, env, "admin@test.com", "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/settings`)
  await page.waitForURL(/\/settings/)
  const langSelect = page.getByTestId("settings-language-select")
  await expect(langSelect).toBeVisible({ timeout: 15000 })

  // English baseline. Functional: heading is the English kernel string.
  await expect(page.getByTestId("settings-content").locator("h1").first()).toHaveText("Profile")
  await expect(page.getByTestId("settings-content")).toHaveScreenshot(
    "phase13-settings-language-en.png",
    DIFF,
  )

  // Switch to French — reactive, no remount. Functional: strings flipped. The
  // switch is done when it is saved and the document says French (the
  // provider's effect sets <html lang>), not after some time.
  await switchLanguage(page, "fr")
  await expect(page.getByTestId("settings-content").locator("h1").first()).toHaveText("Profil", {
    timeout: 10000,
  })
  await expect(page.getByTestId("settings-content")).toContainText("Langue")
  await expect(page.getByTestId("settings-content")).toHaveScreenshot(
    "phase13-settings-language-fr.png",
    DIFF,
  )

  // Reset persisted language so sibling tests in this worker aren't poisoned.
  await switchLanguage(page, "en")
  await expect(page.getByTestId("settings-content").locator("h1").first()).toHaveText("Profile", {
    timeout: 10000,
  })
})

test("visual: Admin Data Export empty vs done vs partial-skip (calm)", async ({
  authenticatedPage,
  env,
  qa,
  world,
}) => {
  const page = authenticatedPage
  await seedTicket(env, world.org.id, { subject: "Visual export ticket" })
  await grantTicketsScopes(env, world.org.id, qa.admin.id)
  const { accessToken: adminToken } = await login(env.serverUrl, "admin@test.com", "12345678")
  await enableAppForOrg(env, world.org.id, "tickets")

  await page.goto(`http://localhost:${env.ports[1]}/settings/admin/data-export`)
  await expect(page.getByTestId("admin-data-export")).toBeVisible({
    timeout: 15000,
  })
  await expect(page.getByTestId("data-export-app-tickets")).toBeVisible({
    timeout: 15000,
  })

  // Empty: no app selected ⇒ submit disabled.
  await expect(page.getByTestId("data-export-submit")).toBeDisabled()
  await expect(page.getByTestId("admin-data-export")).toHaveScreenshot(
    "phase13-data-export-empty.png",
    DIFF,
  )

  // Done: select tickets + csv, export, capture the done affordance.
  await page.getByTestId("data-export-app-tickets").click()
  await page.getByTestId("data-export-format-csv").click()
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("data-export-submit").click(),
  ])
  await expect(page.getByTestId("data-export-done")).toBeVisible({
    timeout: 15000,
  })
  expect(await dl.path()).toBeTruthy()
  await expect(page.getByTestId("admin-data-export")).toHaveScreenshot(
    "phase13-data-export-done.png",
    DIFF,
  )

  // Partial-skip: drive a real skip by mirroring the server skip contract
  // into the UI. Every shipped app supports json+csv (no UI skip can fire),
  // so seed the skipped-state panel by feeding the component the
  // X-Export-Skipped contract via a direct request, then asserting the UI
  // panel renders the same reason calmly. We use page.route to inject a
  // skip header into the next /api/export response so the real component
  // renders its real data-export-skipped branch.
  await page.route("**/api/export", async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    const resp = await route.fetch()
    const body = await resp.body()
    const headers = { ...resp.headers() }
    headers["x-export-skipped"] = JSON.stringify([
      { app: "google-drive", reason: "No export handler for this app" },
    ])
    return route.fulfill({
      status: resp.status(),
      headers,
      body,
    })
  })
  // tickets + CSV are still selected from the done export above — do NOT
  // re-click (toggleApp would DESELECT and disable submit). Just re-submit
  // with the skip-injecting route active.
  await expect(page.getByTestId("data-export-submit")).toBeEnabled()
  const [dl2] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("data-export-submit").click(),
  ])
  expect(await dl2.path()).toBeTruthy()
  const skippedPanel = page.getByTestId("data-export-skipped")
  await expect(skippedPanel).toBeVisible({ timeout: 15000 })
  // Functional: the panel reflects the skip reason from the contract.
  await expect(skippedPanel).toContainText("google-drive")
  await expect(skippedPanel).toContainText(/no export handler/i)
  // Calm UI: no alarm/error color classes — plain bordered panel.
  const cls = (await skippedPanel.getAttribute("class")) ?? ""
  expect(cls).not.toMatch(/bg-error|bg-red|border-error|text-error/)
  await expect(skippedPanel).toHaveScreenshot("phase13-data-export-partial.png", DIFF)
  await page.unroute("**/api/export")
  // adminToken kept for parity with sibling export tests' auth pattern.
  void adminToken
})
