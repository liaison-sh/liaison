// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"
import { seedOrgMailAccount } from "./helpers/mail-fixtures"

test("Dimension grants: deep-link from org mail account highlights value", async ({
  page,
  env,
  world,
  qa,
}, testInfo) => {
  const orgEmail = `deep-link-${testInfo.workerIndex}-${Date.now()}@e2e.test`
  const seeded = await seedOrgMailAccount(env, world.org.id, qa.admin.id, orgEmail)

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/settings/mail/accounts`)
  await expect(page.getByTestId("mail-account-settings")).toBeVisible({ timeout: 10000 })

  // "Manage access" opens Settings > Roles & access on the inbox dimension,
  // with this account's value picked.
  const manageLink = page
    .getByTestId("mail-shared-account-manage-access")
    .and(page.locator(`[href*="${seeded.accountId}"]`))
  await expect(manageLink).toBeVisible({ timeout: 10000 })
  await manageLink.click()

  await page.waitForURL(/\/settings\/admin\/roles\?dimension=mail%3Ainbox/, {
    timeout: 10000,
  })
  expect(page.url()).toContain(`value=${seeded.accountId}`)

  await expect(page.getByTestId("dimension-grant-page")).toBeVisible({ timeout: 10000 })
  const target = page.getByTestId("dimension-grant-target-value")
  await expect(target).toBeVisible({ timeout: 10000 })
  await expect(target).toHaveAttribute("aria-current", "true")
  await expect(target).toContainText(orgEmail)
})
