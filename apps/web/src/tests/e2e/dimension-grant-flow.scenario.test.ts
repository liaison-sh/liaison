// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"
import { seedMailBaseline, seedOrgMailAccount } from "./helpers/mail-fixtures"
import { grantUserDimension, revokeUserDimension } from "./helpers/seed"

function ks(schemaPrefix: string) {
  return schemaPrefix ? `"${schemaPrefix}kernel"` : "kernel"
}

test("Dimension grants: admin grants mail:inbox, teammate sees inbox account", async ({
  browser,
  page,
  env,
  world,
  qa,
}, testInfo) => {
  const orgEmail = `grant-flow-${testInfo.workerIndex}-${Date.now()}@e2e.test`
  const seeded = await seedOrgMailAccount(env, world.org.id, qa.admin.id, orgEmail)
  // Give Amina a personal account so the mail sidebar surfaces the per-account list when
  // a shared account is granted. Sidebar only renders sub-items when the user has > 1 account.
  await seedMailBaseline(
    env,
    qa.amina.id,
    world.org.id,
    orgEmail.replace("grant-flow", "grant-flow-personal"),
  )
  // Ensure Amina starts with no mail:inbox grant for this account
  await revokeUserDimension(env, world.org.id, qa.amina.id, "mail:inbox")

  // Capture Amina's pre-test permission_version. The grant/revoke mutations below go
  // through the API, which bumps Amina's permission_version. qa.amina.token was issued
  // at fixture-setup time and would 401 once the version drifts; restore at end.
  const preAminaVersionRows = (await env.db.sql.unsafe(
    `SELECT permission_version FROM ${ks(env.schemaPrefix)}.users WHERE id = $1`,
    [qa.amina.id],
  )) as Array<{ permission_version: number }>
  const preAminaVersion = preAminaVersionRows[0]?.permission_version ?? 1

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/settings/admin/dimension-grants`)
  await expect(page.getByTestId("dimension-grant-page")).toBeVisible({ timeout: 10000 })

  const fetchGrantsPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/admin/roles/users/${qa.amina.id}/dimensions`) &&
      response.request().method() === "GET",
  )
  await page.getByRole("button", { name: qa.amina.name }).click()
  await fetchGrantsPromise

  const checkbox = page
    .locator(`label`)
    .filter({ hasText: orgEmail })
    .locator('input[type="checkbox"]')
  await expect(checkbox).toBeVisible({ timeout: 10000 })
  expect(await checkbox.isChecked()).toBe(false)

  const grantPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/admin/roles/users/${qa.amina.id}/dimensions`) &&
      response.request().method() === "POST",
  )
  await checkbox.check()
  const grantResponse = await grantPromise
  expect(grantResponse.request().postDataJSON()).toEqual({
    dimension: "mail:inbox",
    values: [seeded.accountId],
  })
  expect([200, 201]).toContain(grantResponse.status())

  await expect
    .poll(async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT dimension_values FROM ${ks(env.schemaPrefix)}.user_dimension_grants
         WHERE user_id = $1 AND org_id = $2 AND dimension_key = 'mail:inbox'`,
        [qa.amina.id, world.org.id],
      )) as Array<{ dimension_values: string[] }>
      return rows[0]?.dimension_values ?? []
    })
    .toContain(seeded.accountId)

  // Verify the grant change propagates via the admin's view.
  await expect
    .poll(async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT dimension_values FROM ${ks(env.schemaPrefix)}.user_dimension_grants
         WHERE user_id = $1 AND org_id = $2 AND dimension_key = 'mail:inbox'`,
        [qa.amina.id, world.org.id],
      )) as Array<{ dimension_values: any }>
      const value = rows[0]?.dimension_values
      return Array.isArray(value) ? value : []
    })
    .toContain(seeded.accountId)

  // Amina context: log in (fresh token includes the grant) and verify the org account
  // appears in her sidebar.
  const aminaContext = await browser.newContext()
  const aminaPage = await aminaContext.newPage()
  try {
    await loginAs(aminaPage, env, qa.amina.email, "QaPass1!")
    // Navigate directly to mail to avoid relying on activity-bar click timing under
    // parallel worker load.
    await aminaPage.goto(`http://localhost:${env.ports[1]}/mail`)
    await expect(aminaPage.getByTestId("mail-inbox")).toBeVisible({ timeout: 15000 })
    const sidebar = aminaPage.getByTestId("mail-sidebar")
    // Poll for the granted org account to appear in Amina's sidebar. The shared-account
    // unread-count subquery in listAccounts does a small amount of work, so we allow
    // generous time under parallel-worker load.
    await expect
      .poll(
        async () => {
          await aminaPage.reload()
          await aminaPage.waitForLoadState("networkidle")
          return await sidebar.getByText(orgEmail).count()
        },
        { timeout: 30000, intervals: [2000, 4000, 6000] },
      )
      .toBeGreaterThan(0)

    // Revoke and confirm Amina's sidebar drops the entry after a reload.
    await revokeUserDimension(env, world.org.id, qa.amina.id, "mail:inbox")
    // Re-login Amina to rotate her token (revocations invalidate any in-flight token cache).
    await aminaPage.context().clearCookies()
    await loginAs(aminaPage, env, qa.amina.email, "QaPass1!")
    await aminaPage.goto(`http://localhost:${env.ports[1]}/mail`)
    await expect(aminaPage.getByTestId("mail-inbox")).toBeVisible({ timeout: 15000 })
    await expect(aminaPage.getByTestId("mail-sidebar").getByText(orgEmail)).toHaveCount(0)
  } finally {
    await aminaContext.close()
  }

  // Restore baseline state for any later tests in the worker.
  await grantUserDimension(env, world.org.id, qa.amina.id, "mail:inbox", ["*"])

  // Restore Amina's permission_version so qa.amina.token (issued by the worker fixture)
  // keeps validating for downstream tests in the same worker.
  await env.db.sql.unsafe(
    `UPDATE ${ks(env.schemaPrefix)}.users SET permission_version = $1 WHERE id = $2`,
    [preAminaVersion, qa.amina.id],
  )
})

test("Dimension grants: page populated structure assertions", async ({
  browser,
  env,
  world,
  qa,
}) => {
  // Worker schemas are isolated, so a fixed email is unique within each worker DB.
  const orgEmail = `f6-visual@e2e.test`
  const seeded = await seedOrgMailAccount(env, world.org.id, qa.admin.id, orgEmail)

  // Use a fresh browser context so the dimension-grant store does not retain cached
  // values from prior tests in the same worker. The store guards `loadValues` against
  // re-loading when its cache is non-empty, which would otherwise hide newly-seeded
  // accounts.
  const context = await browser.newContext()
  const page = await context.newPage()
  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(
    `http://localhost:${env.ports[1]}/settings/admin/dimension-grants?dimension=mail%3Ainbox&value=${seeded.accountId}`,
  )
  const grantPage = page.getByTestId("dimension-grant-page")
  await expect(grantPage).toBeVisible({ timeout: 10000 })

  // F6: structural assertions in lieu of a pixel snapshot.
  // The page height varies per worker because it lists every org-owned mail account
  // seeded by sibling tests in the same worker, so the page-level pixel diff is
  // unstable. The structural checks below (team-member picker, mail:inbox section,
  // deep-link highlight) cover the semantic fallback for this surface; if you need a
  // visual gate, capture the specific deep-linked label row only.
  // Semantic fallback: team-member picker and mail inbox dimension checklist are
  // visible; the deep-linked value is highlighted.
  // The grants live in Settings > Roles & access, under its "Data access" section.
  await expect(page.getByTestId("roles-access-section-data")).toContainText("Data access")
  await expect(
    page.getByTestId("roles-access-section-data").getByTestId("dimension-grant-page"),
  ).toBeVisible()
  await expect(grantPage.getByText("Inbox access")).toBeVisible()
  const target = grantPage.getByTestId("dimension-grant-target-value")
  await expect(target).toBeVisible({ timeout: 10000 })
  await expect(target).toContainText(orgEmail)
  await expect(target).toHaveAttribute("aria-current", "true")
  await context.close()
})
