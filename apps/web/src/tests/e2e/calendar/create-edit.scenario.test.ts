// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Creating and editing events: a click on the week grid opens the quick-create card (a title,
// Enter, done); "More options" carries it into the event tab; an all-day event keeps its day
// when edited (it used to jump to today); a delete asks first and Undo brings the event back.

import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures/test"
import { seedCalendar } from "./helpers/seed-calendar"

async function openWeek(page: Page, viteUrl: string) {
  await page.goto(`${viteUrl}/calendar/week`)
  await page.getByTestId("calendar-view-week").click()
  await expect(page.getByTestId("calendar-week-grid")).toBeVisible({ timeout: 15000 })
}

/** Click the empty grid at `hour` on today's column (the week opens on the current week). */
async function clickSlot(page: Page, hour: number) {
  const column = page.getByTestId(`calendar-day-column-${new Date().toDateString()}`)
  await column.scrollIntoViewIfNeeded()
  const box = await column.boundingBox()
  expect(box).not.toBeNull()
  // 48 px per hour; +6 px lands inside the slot.
  await column.click({ position: { x: box!.width / 2, y: hour * 48 + 6 } })
}

test.describe("Calendar — create and edit", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
  })

  test("quick create, more options, all-day edit, delete with undo", async ({
    authenticatedPage: page,
    env,
    world,
  }) => {
    await seedCalendar({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      actorId: world.admin.id,
      ownerType: "org",
      identifier: "create-edit@calendar.test",
      populate: false,
    })
    const viteUrl = `http://localhost:${env.ports[1]}`
    await openWeek(page, viteUrl)

    // Quick create: click a slot, type, Enter.
    const quickTitle = `Quick ${Date.now()}`
    await clickSlot(page, 20)
    const card = page.getByTestId("calendar-quick-create")
    await expect(card).toBeVisible()
    await card.getByTestId("quick-create-title").fill(quickTitle)
    await card.getByTestId("quick-create-title").press("Enter")
    await expect(card).not.toBeVisible({ timeout: 15000 })
    await expect(
      page.getByTestId("calendar-timed-event").filter({ hasText: quickTitle }),
    ).toBeVisible({ timeout: 15000 })

    // More options: the typed title moves into the event tab; make it all-day and save.
    const allDayTitle = `All day ${Date.now()}`
    await clickSlot(page, 21)
    await card.getByTestId("quick-create-title").fill(allDayTitle)
    await card.getByTestId("quick-create-more").click()
    const tab = page.getByTestId("calendar-event-tab")
    await expect(tab).toBeVisible({ timeout: 15000 })
    await expect(tab.getByTestId("event-title-input")).toHaveValue(allDayTitle)
    await tab.getByTestId("event-allday-toggle").check()
    const today = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    const todayValue = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
    await expect(tab.getByTestId("event-start-input")).toHaveValue(todayValue)
    // Move it to a fixed day in the shown week's next week so "today" cannot hide the bug.
    const target = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 9)
    const targetValue = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`
    await tab.getByTestId("event-start-input").fill(targetValue)
    await tab.getByTestId("event-end-input").fill(targetValue)
    await tab.getByTestId("event-save").click()
    await expect(tab).not.toBeVisible({ timeout: 15000 })

    // Reopen it from its week: the dates are still the chosen day.
    await page.getByTestId("calendar-nav-next").click()
    await page.getByTestId("calendar-nav-next").click()
    await page.getByTestId("calendar-nav-prev").click()
    const band = page.getByTestId("calendar-span-band").filter({ hasText: allDayTitle })
    await expect(band).toBeVisible({ timeout: 15000 })
    await band.click()
    await expect(tab.getByTestId("event-start-input")).toHaveValue(targetValue)
    await expect(tab.getByTestId("event-end-input")).toHaveValue(targetValue)
    await tab.getByTestId("event-cancel").click()

    // Delete the quick one: it asks, then Undo brings it back.
    await page.getByTestId("calendar-nav-prev").click()
    await page.getByTestId("calendar-timed-event").filter({ hasText: quickTitle }).click()
    await tab.getByTestId("event-delete").click()
    await page.getByTestId("event-delete-confirm").click()
    await expect(
      page.getByTestId("calendar-timed-event").filter({ hasText: quickTitle }),
    ).toHaveCount(0, { timeout: 15000 })
    await page.getByTestId("toast-info").getByTestId("toast-action").click()
    await expect(
      page.getByTestId("calendar-timed-event").filter({ hasText: quickTitle }),
    ).toBeVisible({ timeout: 15000 })
  })
})
