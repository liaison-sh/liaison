// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 8 smoke — validates fixture boot, pre-login scope grant, shell mount,
// manifest registration, and the Projects landing page is reachable.
import { expect, loginAs, test } from "./fixtures/test"
import { grantProjectScopes } from "./helpers/projects-seed"

test("smoke: projects activity bar opens projects-home", async ({ page, env, qa, world }) => {
  await grantProjectScopes(env, world.org.id, qa.admin.id)
  await loginAs(page, env, "admin@test.com", "12345678")
  // Manifest fetch happens onMount in Shell; allow time for app registration.
  await page.getByTestId("activity-projects").waitFor({ state: "visible", timeout: 30_000 })
  await page.getByTestId("activity-projects").click()
  await expect(page.getByTestId("projects-home.new-project")).toBeVisible({ timeout: 10_000 })
})
