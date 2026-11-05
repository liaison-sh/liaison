// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S0 Minimal smoke (e2e-plan §S0).
// Single launch, one interaction, one assertion. Sanity-checks that the
// admin pages mount once the harness is up.
import { expect, test } from "./fixtures/test"

test("admin users page mounts", async ({ authenticatedPage, env }) => {
  const page = authenticatedPage
  await page.goto(`http://localhost:${env.ports[1]}/settings/admin/users`)
  await expect(page.getByTestId("admin-users-table")).toBeVisible({ timeout: 15000 })
})
