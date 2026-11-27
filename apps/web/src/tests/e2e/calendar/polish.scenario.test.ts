// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Calendar polish (slice 11): keyboard shortcuts with their ? sheet, a second time zone rail
// chosen in the sidebar, and an event tab that still shows its event after a full page reload
// (it used to say "not found" until the calendar had loaded that week).

import { expect, test } from "../fixtures/test"
import { seedCalendar } from "./helpers/seed-calendar"

test.describe("Calendar — shortcuts, zones and reload", () => {
  test("shortcuts switch views, ? lists them, a second zone adds a rail, a reopened tab loads", async ({
    authenticatedPage: page,
    env,
    world,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await seedCalendar({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      actorId: world.admin.id,
      ownerType: "org",
      identifier: "polish@calendar.test",
      populate: false,
    })
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/calendar/week`)
    await page.getByTestId("calendar-view-week").click()
    await expect(page.getByTestId("calendar-week-grid")).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId("calendar-zone-label")).toBeVisible()

    // Shortcuts: m, d, w switch views; ? opens the list, Esc closes it.
    await page.locator("body").click({ position: { x: 5, y: 5 } })
    await page.keyboard.press("m")
    await expect(page.getByTestId("calendar-month-grid")).toBeVisible()
    await page.keyboard.press("d")
    await expect(page.getByTestId("calendar-day-grid")).toBeVisible()
    await page.keyboard.press("w")
    await expect(page.getByTestId("calendar-week-grid")).toBeVisible()
    await page.keyboard.press("?")
    await expect(page.getByTestId("calendar-shortcuts")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("calendar-shortcuts")).toHaveCount(0)

    // A second zone: picked in the sidebar, drawn as a second hour rail.
    await page.getByTestId("calendar-secondary-zone-select").selectOption("Asia/Tokyo")
    await expect(page.getByTestId("calendar-secondary-rail")).toBeVisible()
    await page.getByTestId("calendar-secondary-zone-select").selectOption("")
    await expect(page.getByTestId("calendar-secondary-rail")).toHaveCount(0)

    // c opens a new event tab; save it, open it, reload: the tab shows the event.
    await page.keyboard.press("c")
    const tab = page.getByTestId("calendar-event-tab")
    await expect(tab).toBeVisible({ timeout: 15000 })
    const title = `Reload ${Date.now()}`
    await tab.getByTestId("event-title-input").fill(title)
    await tab.getByTestId("event-save").click()
    await expect(tab).not.toBeVisible({ timeout: 15000 })
    const block = page.getByTestId("calendar-timed-event").filter({ hasText: title })
    await expect(block).toBeVisible({ timeout: 15000 })
    await block.click()
    await expect(tab.getByTestId("event-title-input")).toHaveValue(title)
    await page.reload()
    await expect(page.getByTestId("calendar-event-tab")).toBeVisible({ timeout: 20000 })
    await expect(
      page.getByTestId("calendar-event-tab").getByTestId("event-title-input"),
    ).toHaveValue(title, { timeout: 15000 })
    await expect(page.getByTestId("event-not-found")).toHaveCount(0)
  })
})
