// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S4 Admin edits role scopes; member permission_version increments.
// (e2e-plan §S4, spec §1.1 criteria 4 and 6, §3.1 role detail/scope catalog.)
//
// Seeds a role with one starting scope and assigns Amina as a member. Drives
// the role detail page in the browser to add a new scope from the catalog
// typeahead, then asserts (a) the scope row appears, (b) the catalog returned
// a manifest scope (tickets:tickets:read), and (c) Amina's permission_version
// strictly increases after each scope mutation.

import { randomUUID } from "node:crypto"
import { expect, test } from "./fixtures/test"
import { getPermissionVersion } from "./helpers/db-reads"
import { assignRoleToUser, seedRoleWithScopes } from "./helpers/seed"

test("add and remove scopes on a role; member permission_version bumps", async ({
  authenticatedPage,
  env,
  qa,
  world,
}) => {
  const page = authenticatedPage
  const vitePort = env.ports[1]
  const baseScope = "kernel:saved_views:share"
  const newScope = "tickets:tickets:read"
  const roleName = `S4Role-${randomUUID().slice(0, 6)}`

  const roleId = await seedRoleWithScopes(env, world.org.id, {
    name: roleName,
    scopes: [baseScope],
  })
  // Amina joins the role; capture her starting permission_version AFTER the
  // join so the baseline already accounts for the assignment bump.
  await assignRoleToUser(env, world.org.id, roleId, qa.amina.id)
  const baselineVersion = await getPermissionVersion(env, qa.amina.id)

  await page.goto(`http://localhost:${vitePort}/settings/admin/roles/${roleId}`)
  await expect(page.getByTestId("admin-role-section-scopes")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId("admin-role-section-members")).toBeVisible()

  // The base scope from the seed renders as a row.
  await expect(page.getByTestId(`admin-role-remove-scope-${baseScope}`)).toBeVisible()

  // Type into the scope search; the typeahead reads /admin/scope-catalog and
  // shows manifest entries like `tickets:tickets:read`.
  await page.getByTestId("admin-role-scope-input").fill("tickets:tickets:read")
  const addBtn = page.getByTestId(`admin-role-add-scope-${newScope}`)
  await expect(addBtn).toBeVisible({ timeout: 10000 })

  // Add the scope and wait for the role detail refetch.
  const addResp = page.waitForResponse(
    (r) => r.url().endsWith(`/api/admin/roles/${roleId}/scopes`) && r.request().method() === "POST",
  )
  await addBtn.click()
  expect((await addResp).status()).toBeLessThan(400)
  await expect(page.getByTestId(`admin-role-remove-scope-${newScope}`)).toBeVisible({
    timeout: 10000,
  })

  // Amina's permission_version must increase after the add.
  const afterAdd = await getPermissionVersion(env, qa.amina.id)
  expect(afterAdd).toBeGreaterThan(baselineVersion)

  // Remove the scope and wait for the DELETE.
  const removeResp = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/admin/roles/${roleId}/scopes/`) &&
      r.url().endsWith(encodeURIComponent(newScope)) &&
      r.request().method() === "DELETE",
  )
  await page.getByTestId(`admin-role-remove-scope-${newScope}`).click()
  expect((await removeResp).status()).toBeLessThan(400)
  await expect(page.getByTestId(`admin-role-remove-scope-${newScope}`)).toHaveCount(0, {
    timeout: 10000,
  })

  // Second bump from the remove.
  const afterRemove = await getPermissionVersion(env, qa.amina.id)
  expect(afterRemove).toBeGreaterThan(afterAdd)
})
