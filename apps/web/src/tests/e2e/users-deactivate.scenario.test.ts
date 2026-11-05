// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S2 Admin deactivates and reactivates a user from the Users page
// (e2e-plan §S2, spec §1.1 criterion 2, §3.1 immediate mutations).
//
// Browser-driven journey:
//   1. Amina signs in once (baseline)
//   2. Elodie deactivates Amina from the admin users table
//   3. Amina can no longer log in (login POST returns non-2xx, UI stays on /login)
//   4. Elodie reactivates Amina
//   5. Amina can log in again

import { expect, loginAs, test } from "./fixtures/test"

test("deactivate then reactivate a user from the admin users page", async ({
  authenticatedPage,
  env,
  qa,
  browser,
}) => {
  const adminPage = authenticatedPage
  const aminaEmail = "amina@resonantaudiolabs.example"
  const aminaPassword = "QaPass1!"
  const vitePort = env.ports[1]

  // Baseline: Amina can sign in. The default sign-in surface is magic-link
  // first, so go through `loginAs`, which reveals the password step the way
  // every other scenario does.
  const aminaContext = await browser.newContext()
  const aminaPage = await aminaContext.newPage()
  await loginAs(aminaPage, env, aminaEmail, aminaPassword)
  await aminaContext.close()

  // Elodie deactivates Amina.
  await adminPage.goto(`http://localhost:${vitePort}/settings/admin/users`)
  await expect(adminPage.getByTestId("admin-users-table")).toBeVisible({ timeout: 15000 })
  await expect(adminPage.getByTestId(`admin-users-name-${qa.amina.id}`)).toBeVisible()
  await expect(adminPage.getByTestId(`admin-users-status-${qa.amina.id}`)).toHaveText("Active")

  const deactivateResp = adminPage.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/admin/users/${qa.amina.id}/deactivate`) &&
      r.request().method() === "POST",
  )
  await adminPage.getByTestId(`admin-users-deactivate-${qa.amina.id}`).click()
  // Deactivation is confirm-gated — the row button opens a dialog; the POST
  // only fires from the dialog's Deactivate button.
  await adminPage.getByTestId("admin-users-deactivate-confirm").click()
  expect((await deactivateResp).status()).toBeLessThan(400)
  await expect(adminPage.getByTestId(`admin-users-status-${qa.amina.id}`)).toHaveText(
    "Deactivated",
    { timeout: 10000 },
  )

  // Amina can no longer log in.
  const deniedCtx = await browser.newContext()
  const deniedPage = await deniedCtx.newPage()
  // This one drives the form by hand because it must watch the login POST
  // fail, so it opens the password step itself first.
  await deniedPage.goto(`http://localhost:${vitePort}/login`)
  const passwordToggle = deniedPage.getByRole("button", { name: /sign in with a password/i })
  await passwordToggle.waitFor({ state: "visible", timeout: 30000 })
  await passwordToggle.click()
  await deniedPage.getByLabel("Password").waitFor({ state: "visible", timeout: 10000 })
  await deniedPage.getByLabel("Email").fill(aminaEmail)
  await deniedPage.getByLabel("Password").fill(aminaPassword)
  const failedLogin = deniedPage.waitForResponse(
    (r) => r.url().includes("/api/auth/login") && r.request().method() === "POST",
  )
  await deniedPage.getByRole("button", { name: /^sign in$/i }).click()
  const failedResp = await failedLogin
  expect([401, 403, 422]).toContain(failedResp.status())
  // Stay on /login — shell must not mount
  await deniedPage.waitForTimeout(500)
  expect(deniedPage.url()).toContain("/login")
  await deniedCtx.close()

  // Elodie reactivates Amina.
  const reactivateResp = adminPage.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/admin/users/${qa.amina.id}/reactivate`) &&
      r.request().method() === "POST",
  )
  await adminPage.getByTestId(`admin-users-reactivate-${qa.amina.id}`).click()
  // Reactivation is likewise confirm-gated via a dialog.
  await adminPage.getByTestId("admin-users-reactivate-confirm").click()
  expect((await reactivateResp).status()).toBeLessThan(400)
  await expect(adminPage.getByTestId(`admin-users-status-${qa.amina.id}`)).toHaveText("Active", {
    timeout: 10000,
  })

  // Amina can log in again.
  const restoredCtx = await browser.newContext()
  const restoredPage = await restoredCtx.newPage()
  await loginAs(restoredPage, env, aminaEmail, aminaPassword)
  await restoredCtx.close()
})
