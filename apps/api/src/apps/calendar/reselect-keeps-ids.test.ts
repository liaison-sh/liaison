// SPDX-License-Identifier: FSL-1.1-ALv2
// G11: deselecting and selecting a calendar again keeps its event ids. A deselected calendar's
// events leave list_events and search_events at once but stay stored; selecting it again lists
// Google into those rows and sweeps the events Google deleted meanwhile. After 30 days the kept
// rows are purged by the daily list refresh.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { FakeGoogleCalendar } from "./__fixtures__/google/fake-google-calendar"
import { createCalendarSyncHarness } from "./__fixtures__/google/sync-harness"

const OWNER = "owner@example.test"
let orgId: string
let userId: string

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-reselect-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  orgId = await seedOrgRow({ name: "Calendar Reselect Org", slug })
  userId = await seedUserRow({
    orgId,
    email: `owner-${slug}@x.test`,
    name: "Owner",
    status: "active",
    passwordHash: "h",
  })
  const { calendarAppManifest } = await import("~/apps/calendar/manifest-descriptor")
  const { resetAppRegistries, setDeclaredEmits } = await import("~/modules/apps/app-registries")
  const { registerApps } = await import("~/modules/apps/runtime")
  resetAppRegistries()
  setDeclaredEmits(
    "*",
    "kernel",
    new Set(["connected_account:create", "connected_account:disconnect"]),
  )
  await registerApps([calendarAppManifest], orgId)
}, 120_000)

afterAll(async () => {
  await releaseAppSchemaJsLock("app_calendar")
})

describe("deselect then select again", () => {
  it("keeps the event ids, hides them meanwhile, and sweeps what Google deleted", async () => {
    const google = FakeGoogleCalendar.fromFixtures({ accountEmail: OWNER })
    const h = createCalendarSyncHarness({ orgId, userId, google })
    await h.connect(OWNER)
    await h.drain()
    const cal = await h.calendar(OWNER)
    const before = await h.event(OWNER, "timed0001")
    expect(before?.id).toBeTruthy()

    await h.tool("set_selected", { calendarId: cal?.id, selected: false })
    await h.drain()
    const listed = (await h.tool("list_events", {
      timeMin: "2026-10-01T00:00:00Z",
      timeMax: "2026-12-01T00:00:00Z",
    })) as Array<{ calendarId: string }>
    expect(listed.some((e) => e.calendarId === cal?.id)).toBe(false)
    const found = (await h.tool("search_events", { query: "Design review" })) as unknown[]
    expect(found).toHaveLength(0)
    expect((await h.event(OWNER, "timed0001"))?.id).toBe(before?.id)

    // Meanwhile in Google: one event deleted, one renamed.
    google.deleteEvent(OWNER, "allday0001")
    google.updateEvent(OWNER, "timed0001", { summary: "Design review (v2)" })

    await h.tool("set_selected", { calendarId: cal?.id, selected: true })
    await h.drain()
    const after = await h.event(OWNER, "timed0001")
    expect(after?.id).toBe(before?.id)
    expect(after?.title).toBe("Design review (v2)")
    expect(await h.event(OWNER, "allday0001")).toBeFalsy()
    expect((await h.calendar(OWNER))?.full_sync_run ?? null).toBeNull()
  })

  it("purges a calendar's kept events 30 days after it was deselected", async () => {
    const google = FakeGoogleCalendar.fromFixtures({ accountEmail: OWNER })
    const h = createCalendarSyncHarness({ orgId, userId, google })
    await h.connect(OWNER)
    await h.drain()
    const cal = await h.calendar(OWNER)
    await h.tool("set_selected", { calendarId: cal?.id, selected: false })
    await h.drain()
    expect(await h.event(OWNER, "timed0001")).toBeTruthy()

    await h.sql(drizzleSql`UPDATE app_calendar.calendars SET deselected_at = now() - interval '31 days'
                           WHERE org_id = ${orgId}::uuid AND id = ${cal?.id}::uuid`)
    await h.runJob("calendar-list-refresh")
    expect(await h.event(OWNER, "timed0001")).toBeFalsy()
  })
})
