// SPDX-License-Identifier: FSL-1.1-ALv2
// Synced knowledge sources — UX flow F1 (add as tab).
//
// F1: per the project's "no popups for cognitive work" convention the add
// flow is a tab, not a modal. The Settings page's "+ Add source" must open
// a tab whose `urlPattern: /knowledge/settings/synced-sources/add` is the
// authoring surface. The integration tests prove the registration; this
// proves the user-visible navigation. (The archived-source banner scenario
// synced a folder through the in-tree Drive adapter, which is gone: Drive
// folders sync through the Google Drive catalog app.)

import { expect, loginAs, test } from "./fixtures/test"
import { seedDriveConnection } from "./helpers/seed"

test("add-source flow opens as a dedicated tab (F1)", async ({ page, env, qa, world }) => {
  // Seed a Drive connection so the Settings page renders cleanly (the form
  // submission would otherwise fail SOURCE_UNAVAILABLE, but here we only test
  // navigation).
  await seedDriveConnection(env, world.org.id, qa.admin.id)

  await loginAs(page, env, "admin@test.com", "12345678")
  const origin = new URL(page.url()).origin
  await page.goto(`${origin}/settings/knowledge/synced-sources`)

  await expect(page.getByTestId("synced-sources-add-button")).toBeVisible({ timeout: 15_000 })
  await page.getByTestId("synced-sources-add-button").click()

  // The tab opens at the dedicated add URL — never as an inline form on the
  // settings page (the F1 regression).
  await expect(page).toHaveURL(/\/knowledge\/settings\/synced-sources\/add$/, { timeout: 10_000 })
  await expect(page.getByTestId("knowledge-synced-source-add-tab")).toBeVisible()
  await expect(page.getByTestId("synced-source-add-form")).toBeVisible()

  // Cancel closes the tab (rather than navigating somewhere).
  await page.getByTestId("synced-source-add-cancel").click()
  await expect(page.getByTestId("knowledge-synced-source-add-tab")).toHaveCount(0)
})
