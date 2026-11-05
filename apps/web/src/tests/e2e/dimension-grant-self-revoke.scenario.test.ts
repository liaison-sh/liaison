// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"
import { seedOrgMailAccount } from "./helpers/mail-fixtures"
import { grantUserDimension } from "./helpers/seed"

function ks(schemaPrefix: string) {
  return schemaPrefix ? `"${schemaPrefix}kernel"` : "kernel"
}

test("Dimension grants: admin self-revokes own mail:inbox via confirm dialog", async ({
  page,
  env,
  world,
  qa,
}, testInfo) => {
  const orgEmail = `self-revoke-${testInfo.workerIndex}-${Date.now()}@e2e.test`
  const seeded = await seedOrgMailAccount(env, world.org.id, qa.admin.id, orgEmail)
  await grantUserDimension(env, world.org.id, qa.admin.id, "mail:inbox", [seeded.accountId])

  // Capture Elodie's pre-test permission_version so we can restore it after the API
  // mutations bump it. Other tests in this worker still rely on qa.admin.token, which
  // encodes the original version — leaving the version bumped would invalidate that token.
  const preVersionRows = (await env.db.sql.unsafe(
    `SELECT permission_version FROM ${ks(env.schemaPrefix)}.users WHERE id = $1`,
    [qa.admin.id],
  )) as Array<{ permission_version: number }>
  const preVersion = preVersionRows[0]?.permission_version ?? 1

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/settings/admin/dimension-grants`)
  await expect(page.getByTestId("dimension-grant-page")).toBeVisible({ timeout: 10000 })

  const fetchPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/admin/roles/users/${qa.admin.id}/dimensions`) &&
      response.request().method() === "GET",
  )
  await page.getByRole("button", { name: qa.admin.name }).click()
  await fetchPromise

  const checkbox = page
    .locator(`label`)
    .filter({ hasText: orgEmail })
    .locator('input[type="checkbox"]')
  await expect(checkbox).toBeVisible({ timeout: 10000 })
  expect(await checkbox.isChecked()).toBe(true)

  await checkbox.click()

  const dialog = page.getByText("Revoke inbox access?")
  await expect(dialog).toBeVisible({ timeout: 5000 })

  // Confirm revocation through the dialog.
  const revokePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/admin/roles/users/${qa.admin.id}/dimensions/mail%3Ainbox`) &&
      response.request().method() === "DELETE",
  )
  await page.getByRole("button", { name: "Revoke access" }).click()
  const revokeResponse = await revokePromise
  expect(revokeResponse.status()).toBe(200)

  await expect
    .poll(async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT dimension_values FROM ${ks(env.schemaPrefix)}.user_dimension_grants
         WHERE user_id = $1 AND org_id = $2 AND dimension_key = 'mail:inbox'`,
        [qa.admin.id, world.org.id],
      )) as Array<{ dimension_values: string[] }>
      return rows[0]?.dimension_values ?? []
    })
    .not.toContain(seeded.accountId)

  // Restore wildcard grant so other tests in this worker that assume Elodie has
  // shared-inbox access continue to pass.
  await grantUserDimension(env, world.org.id, qa.admin.id, "mail:inbox", ["*"])

  // Restore Elodie's permission_version so qa.admin.token (issued at fixture-setup
  // time with the original version) keeps validating. The API mutations above bumped
  // it; reset to the pre-test value via direct UPDATE since the token never re-rolls.
  await env.db.sql.unsafe(
    `UPDATE ${ks(env.schemaPrefix)}.users SET permission_version = $1 WHERE id = $2`,
    [preVersion, qa.admin.id],
  )
})
