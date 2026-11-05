// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 13 — S-3: language switch is reactive (no remount), keep-alive-safe,
// persists to kernel.user_preferences, and is re-applied on a fresh login.
//
// Spec I1 (kernel + in-process app strings render in French) + I4 (preference
// persists and is applied next login across sessions). Uses `page` + loginAs
// so the next-login leg is a genuine fresh login.

import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"

test("i18n: locale switch is reactive, keep-alive-safe, and persists across re-login", async ({
  page,
  env,
  qa,
}) => {
  await loginAs(page, env, "admin@test.com", "12345678")

  // 1. Profile settings: kernel strings render in English first.
  await page.goto(`http://localhost:${env.ports[1]}/settings`)
  await page.waitForURL(/\/settings/)
  const langSelect = page.getByTestId("settings-language-select")
  await expect(langSelect).toBeVisible({ timeout: 15000 })
  const heading = page.getByTestId("settings-content").locator("h1").first()
  await expect(heading).toHaveText("Profile")
  // The language field label is a kernel string too.
  await expect(page.getByTestId("settings-content")).toContainText("Language")

  // 2. Switch to French.
  await langSelect.selectOption("fr")

  // 3. Live reactive re-render with NO navigation/remount: the SAME mounted
  // Profile view's heading flips to "Profil" and the label to "Langue".
  await expect(heading).toHaveText("Profil", { timeout: 10000 })
  await expect(page.getByTestId("settings-content")).toContainText("Langue")

  // 3b. At least one APP-namespace string (not kernel) must localize too — a
  // kernel-only net would miss a mis-keyed app namespace (I1 = ALL in-process
  // app strings). Open the Contacts list; its filter tablist aria-label is
  // `contacts.contactFilter` = "Filtre de contacts" in fr.
  await page.getByTestId("activity-contacts").click()
  const contactsList = page.getByTestId("contacts-list")
  await expect(contactsList).toBeVisible({ timeout: 15000 })
  await expect(contactsList.getByRole("tablist", { name: "Filtre de contacts" })).toBeVisible({
    timeout: 10000,
  })

  // 4. Keep-alive reactivity (remount-proof). Tag the Contacts tab container so
  // a remount (which replaces the node) is detectable, switch language while a
  // DIFFERENT tab is active, switch back, and assert the SAME node now shows
  // French — proving reactive re-render without remount.
  // (a) Switch back to English first so the transition under test is en→fr on
  //     a kept-alive inactive tab.
  await page.goto(`http://localhost:${env.ports[1]}/settings`)
  await page.waitForURL(/\/settings/)
  await expect(page.getByTestId("settings-language-select")).toBeVisible({
    timeout: 15000,
  })
  await page.getByTestId("settings-language-select").selectOption("en")
  await expect(page.getByTestId("settings-content").locator("h1").first()).toHaveText("Profile", {
    timeout: 10000,
  })

  // (b) Open Contacts (tab A) and assert English; tag a stable identity.
  await page.getByTestId("activity-contacts").click()
  await expect(page.getByTestId("contacts-list")).toBeVisible({ timeout: 15000 })
  await expect(
    page.getByTestId("contacts-list").getByRole("tablist", {
      name: "Contact filter",
    }),
  ).toBeVisible({ timeout: 10000 })
  const probe = `ka-${Date.now()}`
  await page.getByTestId("contacts-list").evaluate((el, p) => {
    ;(el as HTMLElement).dataset.kaProbe = p
  }, probe)

  // (c) Switch to a second tab (Settings) via the activity bar — an
  // SPA-INTERNAL tab switch, NOT a `page.goto` (a full document navigation
  // reloads the SPA and tears down every mounted tab, which would defeat the
  // keep-alive contract under test). Clicking `activity-settings` keeps the
  // Contacts tab mounted-but-hidden per the keep-alive contract.
  await page.getByTestId("activity-settings").click()
  await page.waitForURL(/\/settings/)
  await expect(page.getByTestId("settings-language-select")).toBeVisible({
    timeout: 15000,
  })
  // Contacts tab A must still be in the DOM (hidden), not detached.
  expect(
    await page.locator(`[data-testid="contacts-list"][data-ka-probe="${probe}"]`).count(),
  ).toBe(1)

  // (d) With Settings active, switch language to fr.
  await page.getByTestId("settings-language-select").selectOption("fr")
  await expect(page.getByTestId("settings-content").locator("h1").first()).toHaveText("Profil", {
    timeout: 10000,
  })

  // (e) Switch back to Contacts WITHOUT reload/navigation reset. Same node
  // identity (kaProbe unchanged) AND its app-namespace string is now French.
  await page.getByTestId("activity-contacts").click()
  const keptAlive = page.locator(`[data-testid="contacts-list"][data-ka-probe="${probe}"]`)
  await expect(keptAlive).toBeVisible({ timeout: 15000 })
  expect(await keptAlive.count()).toBe(1) // no remount — same tagged node
  await expect(keptAlive.getByRole("tablist", { name: "Filtre de contacts" })).toBeVisible({
    timeout: 10000,
  })

  // 5. Server-side persistence: kernel.user_preferences.language === "fr".
  const prefsRes = await api(env.serverUrl, "/api/user/preferences", {
    token: qa.admin.token,
  })
  expect(prefsRes.status, JSON.stringify(prefsRes.body)).toBe(200)
  expect((prefsRes.body as { data?: { language?: string } }).data?.language).toBe("fr")

  // 6. Full re-login on a fresh page: the persisted fr preference is applied
  // from kernel.user_preferences on first paint (I4 across sessions).
  const ctx = page.context()
  const page2 = await ctx.newPage()
  await loginAs(page2, env, "admin@test.com", "12345678")
  await page2.goto(`http://localhost:${env.ports[1]}/settings`)
  await page2.waitForURL(/\/settings/)
  await expect(page2.getByTestId("settings-content").locator("h1").first()).toHaveText("Profil", {
    timeout: 15000,
  })
  await page2.close()

  // Reset the shared worker user's persisted language so sibling tests in the
  // same worker schema aren't poisoned (the page fixture refreshes tokens, not
  // preferences).
  await api(env.serverUrl, "/api/user/preferences/language", {
    method: "PUT",
    token: qa.admin.token,
    body: { language: "en" },
  })
})
