// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An open week refreshes by itself: an event written by someone else (here the tool route, as an
// agent or a sync would) appears in the visible week without any navigation, because the write
// announces `calendar/event:changed` and the week refetches.

import { api } from "@liaison/test-helpers"
import { expect, test } from "../fixtures/test"
import { seedCalendar } from "./helpers/seed-calendar"

test.describe("Calendar — live refresh", () => {
  test("an event created through the API appears in the open week", async ({
    authenticatedPage: page,
    env,
    world,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const seeded = await seedCalendar({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      actorId: world.admin.id,
      ownerType: "org",
      identifier: "live-refresh@calendar.test",
    })
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/calendar/week`)
    await page.getByTestId("calendar-view-week").click()
    await expect(page.getByTestId("calendar-week-grid")).toBeVisible({ timeout: 15000 })

    const title = `Live refresh ${Date.now()}`
    const start = new Date()
    start.setHours(10, 0, 0, 0)
    const end = new Date(start.getTime() + 60 * 60 * 1000)
    const res = await api(env.serverUrl, "/api/apps/calendar/tools/create_event", {
      method: "POST",
      token: world.admin.token,
      body: {
        params: {
          calendarId: seeded.calendarId,
          title,
          start: start.toISOString(),
          end: end.toISOString(),
        },
      },
    })
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)

    await expect(page.getByTestId("calendar-timed-event").filter({ hasText: title })).toBeVisible({
      timeout: 10000,
    })
  })
})
