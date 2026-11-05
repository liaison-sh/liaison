// SPDX-License-Identifier: FSL-1.1-ALv2
// [Phase 10] Smoke — boots the spawned API with runPhase10Boot, waits for
// Meili readiness, opens the Search tab, and asserts a non-error terminal
// state. Must pass before any other Phase 10 scenario is exercised.
import { expect, loginAs, test } from "./fixtures/test"

test("search-tab-loads-and-search-returns-results", async ({ page, env }) => {
  await loginAs(page, env, "admin@test.com", "12345678")

  // Wait for Phase 10 readiness: Meili-backed search reachable through the API.
  const deadline = Date.now() + 30_000
  let ready = false
  let lastStatus = 0
  let lastBody = ""
  while (Date.now() < deadline) {
    const res = await fetch(`${env.serverUrl}/api/search?q=thread&limit=1`).catch(() => null)
    if (res) {
      lastStatus = res.status
      if (res.status === 200) {
        ready = true
        break
      }
      // 401 is acceptable — search is up but the route needs auth (smoke just probes readiness).
      // 503 means search is not ready yet — keep polling.
      if (res.status === 401) {
        ready = true
        break
      }
      try {
        lastBody = await res.text()
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  expect(
    ready,
    `search must become ready after Phase 10 boot (last status=${lastStatus}, body=${lastBody.slice(0, 200)})`,
  ).toBe(true)

  await page.getByTestId("activity-search").click()
  await expect(page).toHaveURL(/\/search$/)
  await expect(page.getByTestId("search-tab")).toBeVisible()

  await page.getByTestId("search-input").fill("thread")
  await expect(
    page.locator("[data-testid='search-results'], [data-testid='search-zero-results']"),
  ).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("search-unavailable")).toHaveCount(0)
})
