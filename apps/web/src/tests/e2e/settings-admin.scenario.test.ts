// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S6 Admin settings save/validation (e2e-plan §S6, spec §1.1 #7, §6.2).
//
// Browser-driven coverage for the contextual save-bar on the org settings page:
//   • dirty edit → save-bar appears
//   • invalid timezone → inline error + save disabled
//   • valid edit → save persists across reload
// SLA, email and integration sub-pages remain as follow-ups.

import { expect, test } from "./fixtures/test"

test("admin org settings: save-bar appears, timezone validation, persistence", async ({
  authenticatedPage,
  env,
}) => {
  const page = authenticatedPage

  await page.goto(`http://localhost:${env.ports[1]}/settings/admin/org`)
  // Save bar is hidden initially (no dirty state).
  await expect(page.getByTestId("save-bar")).toHaveCount(0)

  // ── Invalid timezone surfaces inline error and disables save ────────────
  await page.getByTestId("admin-org-timezone-manual").fill("Not/A_Real_Zone")
  await expect(page.getByTestId("admin-org-timezone-error")).toBeVisible()
  await expect(page.getByTestId("admin-org-save")).toBeDisabled()
  await page.getByTestId("admin-org-timezone-manual").fill("")

  // ── Valid timezone change → save-bar appears, save persists ─────────────
  const targetTz = `America/Toronto`
  await page.getByTestId("admin-org-timezone-select").selectOption(targetTz)
  await expect(page.getByTestId("save-bar")).toBeVisible({ timeout: 5000 })

  const saveResp = page.waitForResponse(
    (r) => r.url().endsWith("/api/org") && r.request().method() === "PATCH",
  )
  await page.getByTestId("save-bar-save").click()
  expect((await saveResp).status()).toBeLessThan(400)
  await expect(page.getByTestId("save-bar")).toHaveCount(0, { timeout: 5000 })

  // Reload — timezone persists
  await page.reload()
  await page.waitForSelector("[data-shell]", { timeout: 30000 })
  await page.goto(`http://localhost:${env.ports[1]}/settings/admin/org`)
  await expect(page.getByTestId("admin-org-timezone-select")).toHaveValue(targetTz, {
    timeout: 10000,
  })
})
