// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Drag on the week grid: drag over empty slots to create (14:00 to 16:00 makes a two-hour
// event), drag an event to another time and day, drag its bottom edge to resize, Esc cancels a
// drag, and Undo puts a moved event back. Pointer driven, like a person with a mouse.

import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures/test"
import { seedCalendar } from "./helpers/seed-calendar"

const HOUR_PX = 48

/** The week's first column and the grid's top edge, in viewport pixels. */
async function geometry(page: Page) {
  const columns = page.locator('[data-testid^="calendar-day-column-"]')
  const first = await columns.nth(0).boundingBox()
  const second = await columns.nth(1).boundingBox()
  expect(first && second).toBeTruthy()
  return { top: first!.y, x0: first!.x, colWidth: second!.x - first!.x }
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up()
}

test.describe("Calendar — drag", () => {
  test("drag to create, move, resize, Esc and undo", async ({
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
      identifier: "drag@calendar.test",
      populate: false,
    })
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/calendar/week`)
    await page.getByTestId("calendar-view-week").click()
    await expect(page.getByTestId("calendar-week-grid")).toBeVisible({ timeout: 15000 })
    // 13:00 to 17:00 in view, whatever the grid's initial scroll.
    await page
      .locator('[data-testid^="calendar-day-column-"]')
      .nth(1)
      .evaluate((el, px) => el.parentElement?.parentElement?.scrollTo({ top: px }), 12 * HOUR_PX)
    const g = await geometry(page)
    const colX = (i: number) => g.x0 + g.colWidth * i + g.colWidth / 2
    const atHour = (h: number) => g.top + h * HOUR_PX

    // Create: 14:00 to 16:00 on the second column.
    await drag(page, { x: colX(1), y: atHour(14) + 4 }, { x: colX(1), y: atHour(15.75) + 4 })
    const card = page.getByTestId("calendar-quick-create")
    await expect(card).toBeVisible()
    await expect(card.getByTestId("quick-create-when")).toContainText(/2:00\s?PM - 4:00\s?PM|14:00 - 16:00/)
    const title = `Dragged ${Date.now()}`
    await card.getByTestId("quick-create-title").fill(title)
    await card.getByTestId("quick-create-title").press("Enter")
    const block = page.getByTestId("calendar-timed-event").filter({ hasText: title })
    await expect(block).toBeVisible({ timeout: 15000 })
    const created = await block.boundingBox()
    expect(Math.round(created!.height)).toBeGreaterThanOrEqual(2 * HOUR_PX - 4)

    // Esc cancels a move: nothing changes.
    await page.mouse.move(colX(1), atHour(14) + 10)
    await page.mouse.down()
    await page.mouse.move(colX(2), atHour(15) + 10, { steps: 4 })
    await expect(page.getByTestId("calendar-drag-ghost")).toBeVisible()
    await page.keyboard.press("Escape")
    await page.mouse.up()
    await expect(page.getByTestId("calendar-drag-ghost")).toHaveCount(0)
    expect((await block.boundingBox())!.x).toBeCloseTo(created!.x, 0)

    // Move one day right and one hour down: painted at once, kept after the save.
    await drag(page, { x: colX(1), y: atHour(14) + 10 }, { x: colX(2), y: atHour(15) + 10 })
    await expect
      .poll(async () => Math.round((await block.boundingBox())!.x - created!.x))
      .toBeGreaterThan(g.colWidth / 2)
    await expect(page.getByTestId("toast-info")).toBeVisible()
    await page.reload()
    await expect(block).toBeVisible({ timeout: 15000 })
    const g2 = await geometry(page)
    const moved = await block.boundingBox()
    expect(Math.round((moved!.y - g2.top) / HOUR_PX)).toBe(15)

    // Resize: the bottom edge down one hour (15:00-17:00 becomes 15:00-18:00).
    const handle = block.getByTestId("calendar-event-resize")
    const h = await handle.boundingBox()
    await drag(page, { x: h!.x + h!.width / 2, y: h!.y + 2 }, { x: h!.x + h!.width / 2, y: h!.y + 2 + HOUR_PX })
    await expect.poll(async () => Math.round((await block.boundingBox())!.height)).toBeGreaterThan(3 * HOUR_PX - 8)

    // Undo the resize: back to two hours.
    await page.getByTestId("toast-info").last().getByTestId("toast-action").click()
    await expect.poll(async () => Math.round((await block.boundingBox())!.height)).toBeLessThan(2 * HOUR_PX + 4)
  })
})
