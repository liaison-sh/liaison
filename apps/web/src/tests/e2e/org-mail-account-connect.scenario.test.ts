// SPDX-License-Identifier: FSL-1.1-ALv2
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { queryConnectedAccounts, queryMailAccounts } from "./helpers/db-reads"

test("Email Accounts: admin connects shared IMAP account; non-admin cannot", async ({
  browser,
  page,
  env,
  qa,
}, testInfo) => {
  const sharedEmail = `shared-${testInfo.workerIndex}-${Date.now()}@imap.e2e.test`

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/settings/mail/accounts`)
  await expect(page.getByTestId("mail-account-settings")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("mail-connect-shared-gmail")).toBeVisible()
  await page.getByTestId("mail-connect-shared-imap").click()

  await expect(page.getByTestId("mail-imap-form")).toBeVisible()
  await page.getByTestId("mail-imap-email").fill(sharedEmail)
  await page.getByTestId("mail-imap-host").fill("imap.example.test")
  await page.getByTestId("mail-imap-port").fill("993")
  await page.getByTestId("mail-smtp-host").fill("smtp.example.test")
  await page.getByTestId("mail-smtp-port").fill("465")
  await page.getByTestId("mail-imap-username").fill(sharedEmail)
  await page.getByTestId("mail-imap-password").fill("hunter-two-org")

  const submitPromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/connections/mail/imap/credentials") &&
      response.request().method() === "POST",
  )
  await page.getByTestId("mail-imap-submit").click()
  const submitResponse = await submitPromise
  const submitBody = submitResponse.request().postDataJSON() as Record<string, unknown>
  expect(submitBody.mode).toBe("org")
  expect(submitBody).not.toHaveProperty("ownerType")
  expect(submitResponse.status(), await submitResponse.text()).toBe(201)

  const connected = await queryConnectedAccounts(env, `identifier = '${sharedEmail}'`)
  expect(connected.length).toBe(1)
  expect(connected[0].owner_type).toBe("org")
  expect(connected[0].owner_id).toBeNull()

  // app_mail.accounts is materialized lazily by the IMAP sync worker; we assert the source-of-truth
  // connected_accounts row above. If the worker has already produced an app_mail row, also check it.
  const accounts = await queryMailAccounts(env, `email_address = '${sharedEmail}'`)
  if (accounts.length > 0) {
    expect(accounts[0].owner_type).toBe("org")
    expect(accounts[0].owner_id).toBeNull()
  }

  // Non-admin Amina
  const aminaContext = await browser.newContext()
  const aminaPage = await aminaContext.newPage()
  try {
    await loginAs(aminaPage, env, qa.amina.email, "QaPass1!")
    await aminaPage.goto(`http://localhost:${env.ports[1]}/settings/mail/accounts`)
    // Wait for the page to settle; Amina may land on the settings layout but only see
    // the user-scoped surfaces. We assert non-admin controls are absent regardless of
    // whether the mail-account-settings testid renders for non-admins in this layout.
    await aminaPage.waitForLoadState("networkidle")
    await expect(aminaPage.getByTestId("mail-connect-shared-imap")).toHaveCount(0)
    await expect(aminaPage.getByTestId("mail-connect-shared-gmail")).toHaveCount(0)
  } finally {
    await aminaContext.close()
  }

  // Non-admin direct API call must be rejected.
  const aminaRes = await api(env.serverUrl, "/api/connections/mail/imap/credentials", {
    token: qa.amina.token,
    body: {
      email: `amina-attempt-${testInfo.workerIndex}-${Date.now()}@imap.e2e.test`,
      imapHost: "imap.example.test",
      imapPort: "993",
      smtpHost: "smtp.example.test",
      smtpPort: "465",
      username: "amina@e2e.test",
      password: "hunter2",
      mode: "org",
    },
  })
  expect(aminaRes.status, JSON.stringify(aminaRes.body)).toBe(403)
})
