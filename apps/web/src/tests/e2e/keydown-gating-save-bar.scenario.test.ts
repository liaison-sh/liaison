// SPDX-License-Identifier: FSL-1.1-ALv2
// keydown.save-bar-survives-inactive-tab-escape — a dirty ContextualSaveBar in
// an inactive (keep-alive, hidden) tab must NOT discard on Escape (C2: the
// keydown handler bails unless useTabIsActive()). Opens Org Settings, dirties
// a field, switches to another tab via in-app SPA navigation (keep-alive, no
// reload), presses Escape while Settings is hidden, switches back, and
// asserts the edit is intact and the save bar is still showing dirty state.
import { expect, test } from "./fixtures/test"

test("keydown.save-bar-survives-inactive-tab-escape", async ({ authenticatedPage: page, env }) => {
  // SPA-internal navigation: history.pushState + popstate stays within the
  // same page load so both tabs stay mounted (display:none keep-alive).
  // Using page.goto() would force a full reload and reset all component state
  // (see workspace-tabs-preserve-state.scenario.test.ts for the same pattern).
  const spaNavigate = async (url: string) => {
    await page.evaluate((u) => {
      window.history.pushState({}, "", u)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }, url)
  }

  // Open Org Settings and dirty the timezone field.
  await page.getByTestId("activity-settings").click()
  await page.waitForURL(/\/settings/, { timeout: 10000 })
  await page.getByRole("link", { name: "Organization" }).click()
  await page.waitForURL(/\/settings\/admin\/org$/, { timeout: 10000 })
  await expect(page.getByTestId("admin-org-timezone-manual")).toBeVisible({ timeout: 10000 })

  // Must be one of the app's curated KNOWN_TIMEZONES (lib/timezones.ts — a
  // fixed shortlist, not the full IANA registry) and different from the
  // seeded org's current timezone (UTC) so `dirty()` is true.
  const dirtyValue = "Europe/Paris"
  await page.getByTestId("admin-org-timezone-manual").fill(dirtyValue)
  await expect(page.getByTestId("save-bar")).toBeVisible({ timeout: 5000 })

  // Switch to Home via in-app navigation without closing the Settings tab —
  // keep-alive keeps the dirty Settings tab mounted, just hidden.
  await spaNavigate("/")
  await expect(page.getByTestId("home")).toBeVisible({ timeout: 10000 })

  // Press Escape while Settings (with the dirty save bar) is the INACTIVE
  // tab. Pre-C2 this discarded the edit from a hidden tab; post-C2 the
  // ContextualSaveBar's keydown handler bails because useTabIsActive() is
  // false for the Settings tab right now.
  await page.keyboard.press("Escape")

  // Switch back to Settings — the edit must have survived.
  await spaNavigate("/settings/admin/org")
  await expect(page.getByTestId("admin-org-timezone-manual")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("admin-org-timezone-manual")).toHaveValue(dirtyValue)
  await expect(page.getByTestId("save-bar")).toBeVisible()

  // Sanity: Escape DOES discard when Settings is the active tab (existing
  // behavior preserved, not just "nothing happens ever").
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("save-bar")).toHaveCount(0, { timeout: 5000 })
})
