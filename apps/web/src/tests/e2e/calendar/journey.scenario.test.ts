// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 9 — Calendar UI/Playwright journey + visual screenshots (spec-plan §9.1).
//
// Drives the browser against a REAL running server: open Calendar tab → empty
// state → seed a synced org calendar via the test-only calendar seed route
// (drives the real sync engine — connect → import → initial sync, same
// functions `calendar-e2e.test.ts` exercises; Google is mocked only at the
// fixture-pages boundary) → month view shows events → toggle a calendar off/on
// → open an event → edit it → dialog reflects the change → week view. Also
// screenshots the settings page with its reauth banner.
//
// Calendar is IN-TREE and auto-registered for every org at boot (see
// `apps/api/src/modules/apps/init.ts`), so — unlike Shopify — there is no
// install-tarball step: the QA-seeded `world.org` already has the calendar
// app's schema + routes live. The seed route only needs to connect an account
// and push fixture events through the real sync path.

import type { Page } from "@playwright/test"
import { forceDarkMode } from "../agent-bootstrap"
import { expect, test } from "../fixtures/test"
import { forceCalendarReauth, seedCalendar } from "./helpers/seed-calendar"

const SHOT = { maxDiffPixelRatio: 0.02 } as const
/** The floating Chats dock overlays the tab content area, and its unread count
 *  is live worker state (how many conversations a sibling test left unread), so
 *  every crop that spans the main panel masks it or re-flakes on the count. */
const maskDock = (page: Page) => [page.locator("[data-chat-dock]")]
// Pixel baselines are darwin-only (font hinting/subpixel rendering differ on
// CI's linux runners) — mirrors the convention in the shopify suite's visual
// suite. Functional assertions (testids visible, content present) always run.
const PIXEL_BASELINES = process.platform === "darwin"

test.describe("Calendar — UI journey + visual baselines", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await forceDarkMode(page)
  })

  test("empty state — no connected calendars", async ({ authenticatedPage: page, env }) => {
    // A fresh worker's QA org has calendar registered but no connected
    // account yet (no seed call made in this test) — the month tab must
    // render the empty state, not crash on an empty calendars list.
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/calendar`)
    await page.waitForLoadState("networkidle")
    const tab = page.getByTestId("calendar-month-tab")
    await expect(tab).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId("calendar-empty-state")).toBeVisible({ timeout: 15000 })
    await page.waitForTimeout(250)
    if (PIXEL_BASELINES)
      await expect(tab).toHaveScreenshot("empty-state.png", { ...SHOT, mask: maskDock(page) })
  })

  test("month view populated → toggle calendar → open/edit event → week view", async ({
    authenticatedPage: page,
    env,
    world,
    qa,
  }) => {
    const viteUrl = `http://localhost:${env.ports[1]}`

    // Seed an org-wide connected calendar with fixture events through the
    // real sync engine (connect → import → initial sync).
    const seeded = await seedCalendar({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      actorId: world.admin.id,
      ownerType: "org",
      identifier: "journey-org@calendar.test",
    })

    await page.goto(`${viteUrl}/calendar`)
    await page.waitForLoadState("networkidle")
    const monthTab = page.getByTestId("calendar-month-tab")
    await expect(monthTab).toBeVisible({ timeout: 15000 })

    // Month view shows the seeded events.
    await expect(page.getByTestId("calendar-month-grid")).toBeVisible({ timeout: 15000 })
    const eventChips = page.getByTestId("calendar-event-chip")
    await expect(eventChips.first()).toBeVisible({ timeout: 15000 })
    await expect(eventChips).toHaveCount(await eventChips.count())
    const chipCountBefore = await eventChips.count()
    expect(chipCountBefore).toBeGreaterThan(0)
    await page.waitForTimeout(250)
    if (PIXEL_BASELINES)
      await expect(monthTab).toHaveScreenshot("month-populated.png", {
        ...SHOT,
        mask: maskDock(page),
      })

    // Toggle the seeded calendar off in the sidebar, then back on. The sidebar
    // is rendered outside the tab content area (registry `sidebar` slot), so
    // locate it independently.
    const sidebar = page.getByTestId("calendar-sidebar")
    await expect(sidebar).toBeVisible({ timeout: 15000 })
    const toggle = sidebar.locator(`[data-testid="calendar-toggle-${seeded.calendarId}"]`)
    await expect(toggle).toBeVisible({ timeout: 15000 })
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await toggle.click()
    await expect(toggle).toBeChecked()

    // Open the first event, edit its title, save, and confirm the dialog/grid
    // reflect the change.
    await eventChips.first().click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 15000 })
    await expect(dialog.getByRole("heading", { name: "Edit event" })).toBeVisible()
    await page.waitForTimeout(250)
    if (PIXEL_BASELINES) await expect(dialog).toHaveScreenshot("event-dialog.png", SHOT)

    const titleInput = dialog.getByTestId("event-title-input")
    const originalTitle = await titleInput.inputValue()
    const newTitle = `${originalTitle} (edited)`
    await titleInput.fill(newTitle)
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(dialog).not.toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId("calendar-event-chip").filter({ hasText: newTitle })).toBeVisible(
      { timeout: 15000 },
    )

    // Re-open the same event — dialog reflects the persisted edit.
    await page.getByTestId("calendar-event-chip").filter({ hasText: newTitle }).first().click()
    const dialog2 = page.getByRole("dialog")
    await expect(dialog2).toBeVisible({ timeout: 15000 })
    await expect(dialog2.getByTestId("event-title-input")).toHaveValue(newTitle)
    await dialog2.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog2).not.toBeVisible({ timeout: 15000 })

    // Week view — same seeded data, different layout.
    await page.goto(`${viteUrl}/calendar/week`)
    await page.waitForLoadState("networkidle")
    const weekTab = page.getByTestId("calendar-week-tab")
    await expect(weekTab).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId("calendar-week-grid")).toBeVisible({ timeout: 15000 })
    await page.waitForTimeout(250)
    if (PIXEL_BASELINES)
      await expect(weekTab).toHaveScreenshot("week-populated.png", {
        ...SHOT,
        mask: maskDock(page),
      })
  })

  test("settings — connections list and reauth banner", async ({
    authenticatedPage: page,
    env,
    world,
  }) => {
    const viteUrl = `http://localhost:${env.ports[1]}`

    const seeded = await seedCalendar({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      actorId: world.admin.id,
      ownerType: "org",
      identifier: "journey-settings-org@calendar.test",
      populate: false,
    })

    // The former URL lands on the Calendar settings page; its accounts section
    // lists the connections (kernel block) and the calendar choices.
    await page.goto(`${viteUrl}/settings/calendar/connections`)
    await page.waitForLoadState("networkidle")
    await expect(page).toHaveURL(/\/settings\/apps\/calendar/, { timeout: 15000 })
    const panel = page.getByTestId("settings-section-accounts")
    await expect(panel).toBeVisible({ timeout: 15000 })
    await expect(panel.getByText("journey-settings-org@calendar.test").first()).toBeVisible({
      timeout: 15000,
    })

    // Force the seeded account into reauth-required and confirm the banner
    // renders after a refetch (re-navigate to force createResource to refire).
    await forceCalendarReauth(env.serverUrl, world.org.id, seeded.accountId)
    await page.reload()
    await page.waitForLoadState("networkidle")
    await expect(panel).toBeVisible({ timeout: 15000 })
    const reauthBanner = page.getByTestId("calendar-reauth-banner")
    await expect(reauthBanner).toBeVisible({ timeout: 15000 })
    await page.waitForTimeout(250)
    // Screenshot only the reauth banner + its row (not the whole panel) — the
    // panel's height varies with the connections list length, which this
    // worker-scoped org accumulates across every test in this file (each
    // seeds its own connection into the same org). The banner element itself
    // is a fixed-size leaf, so it's a stable pixel baseline regardless of
    // how many sibling connection rows exist.
    if (PIXEL_BASELINES) {
      // Cropped to whole pixels: the rows above it put the banner at a
      // fractional offset that differs from run to run, and an element shot
      // then came out 48 or 49 px tall for the same pixels.
      const box = await reauthBanner.boundingBox()
      expect(box).not.toBeNull()
      await expect(page).toHaveScreenshot("settings-reauth.png", {
        clip: {
          x: Math.floor(box!.x),
          y: Math.floor(box!.y),
          width: Math.floor(box!.width),
          height: Math.floor(box!.height),
        },
        // Text-only element: subpixel antialiasing differs across runners (Strobe vs direct).
        maxDiffPixelRatio: 0.08,
      })
    }
  })
})
