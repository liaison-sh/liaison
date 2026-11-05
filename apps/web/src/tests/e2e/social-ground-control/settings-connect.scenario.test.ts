// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B-NEW-4 — Settings connect CTA + quota-exhausted banner (§1 #1 / §6 / §12 /
// §9 #3). The BYO-connection surface a user clicks in their first 5 minutes.
//
// The page is the app's declarative settings page (/settings/apps/social; the
// old /settings/social redirects there). Its connections block is the kernel's
// (real connection list, none connected here); the quota block is the app's
// own, fed by the host mock. The OAuth round-trip is out of scope (real
// Meta/Google): Connect is NOT clicked, only rendered enabled; the connect
// wiring is covered by the kernel ConnectionsBlock unit tests.
import { forceDarkMode } from "../agent-bootstrap"
import { loginAs } from "../fixtures/test"
import { expect, test } from "./helpers/social-fixtures"
import { installSocialApp, resetSocialMock } from "./helpers/social-harness"
import { installSocialHostMock, youtubeQuota } from "./helpers/social-visual-mocks"

test.describe("Social Ground Control settings connect", () => {
  test.beforeEach(async ({ page }) => {
    await forceDarkMode(page)
  })

  test("connect CTA renders and quota-exhausted banner names deferred count", async ({
    page,
    env,
    world,
    qa,
  }) => {
    const token = qa.admin.token
    const s = env.serverUrl
    const orgId = world.org.id

    await resetSocialMock(s, token)
    await installSocialApp({ serverUrl: s, token, orgId })

    // Arm the host mock (the app's own quota block): a quota-EXHAUSTED shape
    // (deferred > 0).
    await installSocialHostMock(page, {
      "social:quota_status": youtubeQuota(10_000, 10_000, 7),
      "social:counts": { findings_new: 0, awaiting_approval: 0, open_dms: 0 },
    })

    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/settings/social`)
    await page.waitForLoadState("networkidle")
    await expect(page).toHaveURL(/\/settings\/apps\/social/)

    // Gate on the connections section before asserting any inner element.
    const region = page.getByTestId("settings-section-connections")
    await expect(region).toBeVisible({ timeout: 15_000 })

    // Connections block: one card per connection, each with no account yet and
    // an ENABLED Connect button.
    await expect(region).toContainText("Facebook Page")
    await expect(region).toContainText("Instagram account")
    await expect(region).toContainText("Google account (YouTube)")
    for (const name of ["facebook", "instagram", "google"]) {
      const card = region.getByTestId(`connections-conn-${name}`)
      await expect(card).toContainText("No account connected yet.")
      const connect = card.getByTestId(`connections-connect-${name}`)
      await expect(connect).toHaveText("Connect")
      await expect(connect, "connect CTA must be enabled before any OAuth round-trip").toBeEnabled()
    }

    // Quota banner appears ONLY when exhausted and names the deferred count.
    const banner = page.locator('[data-testid="social-quota-banner"]')
    await expect(banner, "quota banner must render when deferred > 0").toBeVisible()
    await expect(banner).toContainText("7")
    // The readout shows consumed of cap.
    await expect(page.locator('[data-testid="social-quota-readout"]')).toContainText(
      "10,000 of 10,000 units today",
    )

    // Explicitly do NOT click Connect (the OAuth sign-in navigates away).
  })
})
