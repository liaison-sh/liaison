// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S3 Admin assigns/unassigns a role; effective scopes update inline.
// (e2e-plan §S3, spec §1.1 criterion 3, §3.1 user detail, §6.2 immediate mutations.)

import { randomUUID } from "node:crypto"
import { expect, test } from "./fixtures/test"
import { seedRoleWithScopes } from "./helpers/seed"

test("assign and unassign a role; effective scopes refetch", async ({
  authenticatedPage,
  env,
  qa,
  world,
}) => {
  const page = authenticatedPage
  // Use a scenario-unique scope so Amina's baseline cannot have it from
  // other tests in the same worker (S1/S8/bulk-tickets stub may grant
  // tickets:tickets:read via their own roles).
  const uniqueScope = `phase9:s3-test:${randomUUID().slice(0, 8)}`
  const roleName = `TicketsReader-${randomUUID().slice(0, 6)}`
  const roleId = await seedRoleWithScopes(env, world.org.id, {
    name: roleName,
    scopes: [uniqueScope],
  })

  await page.goto(`http://localhost:${env.ports[1]}/settings/admin/users/${qa.amina.id}`)
  await expect(page.getByTestId("admin-user-section-identity")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId("admin-user-section-roles")).toBeVisible()
  await expect(page.getByTestId("admin-user-section-effective-scopes")).toBeVisible()

  // Capture baseline scopes
  await page.getByTestId("admin-user-scopes-toggle").click()
  await expect(page.getByTestId("admin-user-scopes-list")).toBeVisible()
  const baselineHasScope = await page
    .getByTestId("admin-user-scopes-list")
    .getByText(uniqueScope, { exact: true })
    .count()
  expect(baselineHasScope).toBe(0)

  // Assign the role by clicking its card.
  const assignResp = page.waitForResponse(
    (r) => r.url().endsWith(`/api/admin/roles/${roleId}/users`) && r.request().method() === "POST",
  )
  await page.getByTestId(`admin-user-role-card-${roleId}`).click()
  expect((await assignResp).status()).toBeLessThan(400)

  // Role chip + new scope appear
  await expect(page.getByTestId(`admin-user-unassign-${roleId}`)).toBeVisible({ timeout: 10000 })
  // Re-open scopes list (refetch may have collapsed it)
  const scopesList = page.getByTestId("admin-user-scopes-list")
  if (!(await scopesList.isVisible().catch(() => false))) {
    await page.getByTestId("admin-user-scopes-toggle").click()
  }
  await expect(
    page.getByTestId("admin-user-scopes-list").getByText(uniqueScope, { exact: true }),
  ).toBeVisible({ timeout: 10000 })

  // Unassign — click the card again (assigned cards toggle off on click).
  const unassignResp = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/admin/roles/${roleId}/users/${qa.amina.id}`) &&
      r.request().method() === "DELETE",
  )
  await page.getByTestId(`admin-user-role-card-${roleId}`).click()
  expect((await unassignResp).status()).toBeLessThan(400)
  await expect(page.getByTestId(`admin-user-unassign-${roleId}`)).toHaveCount(0, { timeout: 10000 })
  // Re-expand if collapsed
  if (!(await scopesList.isVisible().catch(() => false))) {
    await page.getByTestId("admin-user-scopes-toggle").click()
  }
  await expect(
    page.getByTestId("admin-user-scopes-list").getByText(uniqueScope, { exact: true }),
  ).toHaveCount(0, { timeout: 10000 })
})
