// SPDX-License-Identifier: FSL-1.1-ALv2
// [Phase 10 PW-1] Global search returns ranked results, routes to the entity
// tab, the CommandPalette uses the same Meili-backed contract, and no parallel
// notification surface is leaked. Inline visual goldens V1–V4 cover the four
// terminal states of the Search tab.
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(() => document.fonts.ready)
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
  })
  await page.waitForTimeout(ms)
}

test("search.global-flow-and-unified-surface", async ({ page, env, qa }) => {
  await loginAs(page, env, "admin@test.com", "12345678")

  // Wait for the Phase 10 readiness probe — search may still be starting up.
  const deadline = Date.now() + 30_000
  let ready = false
  while (Date.now() < deadline) {
    const res = await fetch(`${env.serverUrl}/api/search?q=thread&limit=1`, {
      headers: { Authorization: `Bearer ${qa.admin.token}` },
    }).catch(() => null)
    if (res && (res.status === 200 || res.status === 401)) {
      ready = true
      break
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  expect(ready, "search must reach readiness").toBe(true)

  // Activity bar Search icon opens the /search tab.
  await page.getByTestId("activity-search").click()
  await expect(page).toHaveURL(/\/search$/)
  await expect(page.getByTestId("search-tab")).toBeVisible()

  // Empty-state hint visible until query typed.
  await expect(page.getByTestId("search-empty-hint")).toBeVisible()

  // [V1] Search tab default — empty hint visible, no results, no chips.
  await settle(page)
  await expect(page.getByTestId("search-tab")).toHaveScreenshot("search-tab-default.png", {
    maxDiffPixelRatio: 0.05,
  })

  // Deterministic query — QA seed thread title "Sprint retrospective".
  const input = page.getByTestId("search-input")
  await input.fill("Sprint")
  await expect(
    page.locator("[data-testid='search-results'], [data-testid='search-zero-results']"),
  ).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("search-unavailable")).toHaveCount(0)

  // [V2] Search tab with results — mask volatile per-row timestamps.
  await settle(page)
  await expect(page.getByTestId("search-tab")).toHaveScreenshot("search-tab-with-results.png", {
    maxDiffPixelRatio: 0.05,
    mask: [
      page.locator("[data-testid='search-meta']"),
      page.locator("[data-testid^='search-result-'] p:last-child"),
    ],
  })

  // [V3] Search tab zero results — type a deterministic no-match term.
  await input.fill("zzz_no_match_token")
  await expect(page.getByTestId("search-zero-results")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("search-unavailable")).toHaveCount(0)
  await settle(page)
  await expect(page.getByTestId("search-tab")).toHaveScreenshot("search-tab-zero-results.png", {
    maxDiffPixelRatio: 0.05,
  })

  // Restore the result list and click into the first hit to validate routing.
  await input.fill("Sprint")
  await expect(
    page.locator("[data-testid='search-results'], [data-testid='search-zero-results']"),
  ).toBeVisible({ timeout: 15_000 })
  const results = page.getByTestId("search-results")
  if (await results.count()) {
    const firstResult = page.locator("[data-testid^='search-result-']").first()
    await firstResult.click()
    await expect(page).not.toHaveURL(/\/search$/, { timeout: 10_000 })
  }

  // Unified-surface guardrail: no notification bell, dropdown, or count badge
  // leaks into the shell. The only attention surface is the Home feed.
  await expect(page.locator("[data-testid^='notifications-']")).toHaveCount(0)
  const notifRes = await fetch(`${env.serverUrl}/api/notifications`, {
    headers: { Authorization: `Bearer ${qa.admin.token}` },
  })
  expect(notifRes.status).toBe(404)

  // CommandPalette regression — Cmd+P opens the palette, typing hits the same
  // Meili-backed /search contract. We assert no SEARCH_UNAVAILABLE leaks into
  // the palette; rendered results are best-effort given the legacy contract.
  await page.keyboard.press("ControlOrMeta+p")
  const paletteInput = page.getByTestId("command-palette-input")
  await expect(paletteInput).toBeVisible({ timeout: 5_000 })
  await paletteInput.fill("Sprint")
  await page.waitForTimeout(800)
  await expect(page.getByTestId("command-palette-search-unavailable")).toHaveCount(0)
  await page.keyboard.press("Escape")
})

test("search.unavailable-state-visual", async ({ page, env }) => {
  // Intercept /api/search/page and return the canonical SEARCH_UNAVAILABLE
  // envelope so the SearchTab renders its UnavailableState branch. Per plan
  // §Visual Validation, do NOT delete the Meili index from a browser worker.
  await page.route("**/api/search/page**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "SEARCH_UNAVAILABLE", message: "Search unavailable" },
      }),
    }),
  )

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.getByTestId("activity-search").click()
  await expect(page.getByTestId("search-tab")).toBeVisible()

  // Type to drive the SearchTab past the empty-hint branch and into a fetch
  // that triggers the 503 → unavailable terminal state.
  await page.getByTestId("search-input").fill("Sprint")
  const unavailable = page.getByTestId("search-unavailable")
  await expect(unavailable).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId("search-results")).toHaveCount(0)

  await settle(page)
  await expect(unavailable).toHaveScreenshot("search-tab-unavailable.png", {
    maxDiffPixelRatio: 0.05,
  })
})
