// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Recurring events in the event tab: a weekly series made in the tab, then one occurrence opened
// from a later week and changed for "This and following events": the weeks before keep the old
// title, that week and the ones after show the new one. Deleting "This event" then takes one
// occurrence out and leaves the others, and dragging an occurrence asks which occurrences move.

import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures/test"
import { seedCalendar } from "./helpers/seed-calendar"

async function openWeek(page: Page, viteUrl: string) {
  await page.goto(`${viteUrl}/calendar/week`)
  await page.getByTestId("calendar-view-week").click()
  await expect(page.getByTestId("calendar-week-grid")).toBeVisible({ timeout: 15000 })
}

test.describe("Calendar — recurring events", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
  })

  test("this and following splits the series; this event removes one occurrence", async ({
    authenticatedPage: page,
    env,
    world,
  }) => {
    await seedCalendar({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      actorId: world.admin.id,
      ownerType: "org",
      identifier: "recurring@calendar.test",
      populate: false,
    })
    const viteUrl = `http://localhost:${env.ports[1]}`
    await openWeek(page, viteUrl)

    // A weekly series from the tab, starting today.
    const oldTitle = `Weekly ${Date.now()}`
    const newTitle = `${oldTitle} (new)`
    await page.locator(`[data-testid="calendar-new-event"]:visible`).click()
    const tab = page.getByTestId("calendar-event-tab")
    await expect(tab).toBeVisible({ timeout: 15000 })
    await tab.getByTestId("event-title-input").fill(oldTitle)
    await tab.getByTestId("event-recurrence-select").selectOption("weekly")
    await expect(tab.getByTestId("event-repeat-editor")).toBeVisible()
    await tab.getByTestId("event-save").click()
    await expect(tab).not.toBeVisible({ timeout: 15000 })
    const events = page.getByTestId("calendar-timed-event")
    await expect(events.filter({ hasText: oldTitle })).toHaveCount(1, { timeout: 15000 })

    // Two weeks on: change that occurrence and the following ones.
    await page.getByTestId("calendar-nav-next").click()
    await page.getByTestId("calendar-nav-next").click()
    await events.filter({ hasText: oldTitle }).click()
    await expect(tab).toBeVisible({ timeout: 15000 })
    await tab.getByTestId("event-title-input").fill(newTitle)
    await tab.getByTestId("event-save").click()
    await expect(page.getByTestId("event-scope-dialog")).toBeVisible()
    await page.getByTestId("event-scope-following").click()
    await expect(tab).not.toBeVisible({ timeout: 15000 })
    await expect(events.filter({ hasText: newTitle })).toHaveCount(1, { timeout: 15000 })

    // The week before still has the old series; the week after has the new one.
    await page.getByTestId("calendar-nav-prev").click()
    await expect(events.filter({ hasText: oldTitle })).toHaveCount(1, { timeout: 15000 })
    await expect(events.filter({ hasText: newTitle })).toHaveCount(0)
    await page.getByTestId("calendar-nav-next").click()
    await page.getByTestId("calendar-nav-next").click()
    await expect(events.filter({ hasText: newTitle })).toHaveCount(1, { timeout: 15000 })

    // "This event" deletes one occurrence of the new series and keeps the next one.
    await events.filter({ hasText: newTitle }).click()
    await tab.getByTestId("event-delete").click()
    await page.getByTestId("event-scope-occurrence").click()
    await expect(events.filter({ hasText: newTitle })).toHaveCount(0, { timeout: 15000 })
    await page.getByTestId("calendar-nav-next").click()
    await expect(events.filter({ hasText: newTitle })).toHaveCount(1, { timeout: 15000 })

    // Dragging an occurrence of a series asks which occurrences move; "All events" moves the
    // whole series by an hour.
    const block = events.filter({ hasText: newTitle })
    await block.scrollIntoViewIfNeeded()
    const box = (await block.boundingBox())!
    // An hour later, or earlier late in the day (48 px per hour).
    const shift = new Date().getHours() >= 12 ? -48 : 48
    await page.mouse.move(box.x + box.width / 2, box.y + 4)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + 4 + shift / 2, { steps: 4 })
    await page.mouse.move(box.x + box.width / 2, box.y + 4 + shift, { steps: 4 })
    await page.mouse.up()
    await expect(page.getByTestId("move-scope-dialog")).toBeVisible()
    await page.getByTestId("move-scope-series").click()
    await expect
      .poll(async () => Math.round((await block.boundingBox())!.y - box.y), { timeout: 15000 })
      .toBe(shift)
  })
})
