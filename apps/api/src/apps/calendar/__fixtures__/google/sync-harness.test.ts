// SPDX-License-Identifier: FSL-1.1-ALv2
// The sync harness proves itself: the real handlers, bridge and database round-trip against the
// stateful fake Google Calendar (connect -> import -> initial sync -> watch -> Google-side edit ->
// push notification -> incremental sync; Liaison create -> push -> echo suppressed).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { FakeGoogleCalendar } from "./fake-google-calendar"
import { createCalendarSyncHarness } from "./sync-harness"

const OWNER = "owner@example.test"
const TEAM = "team0001@group.calendar.google.com"

let orgId: string
let userId: string

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-harness-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  orgId = await seedOrgRow({ name: "Calendar Harness Org", slug })
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

describe("calendar sync harness against the fake Google Calendar", () => {
  it("connect imports the calendars, syncs their events and watches them", async () => {
    // Each test connects its own Google account (the org is shared by the file's tests).
    const email = `owner-${crypto.randomUUID().slice(0, 8)}@example.test`
    const google = FakeGoogleCalendar.fromFixtures({ accountEmail: email })
    const h = createCalendarSyncHarness({ orgId, userId, google })
    await h.connect(email)
    await h.drain()

    expect(h.ran.map((j) => j.name)).toContain("calendar-import")
    const owner = await h.calendar(OWNER)
    expect(owner?.access_role).toBe("owner")
    expect(owner?.sync_token).toBeTruthy()
    expect(owner?.watch_channel_id).toBeTruthy()
    expect(google.activeChannels(OWNER)).toHaveLength(1)

    const timed = await h.event(OWNER, "timed0001")
    expect(timed?.title).toBe("Design review")
    const exception = await h.event(OWNER, "weekly0001_20261102T080000Z")
    expect(exception?.recurring_event_id).toBe("weekly0001")
    expect(google.unhandled).toEqual([])
  })

  it("a Google-side edit reaches Liaison through the push notification", async () => {
    // Each test connects its own Google account (the org is shared by the file's tests).
    const email = `owner-${crypto.randomUUID().slice(0, 8)}@example.test`
    const google = FakeGoogleCalendar.fromFixtures({ accountEmail: email })
    const h = createCalendarSyncHarness({ orgId, userId, google })
    await h.connect(email)
    await h.drain()

    google.updateEvent(TEAM, "teamlunch01", { summary: "Team lunch (moved upstairs)" })
    expect(await h.notify(TEAM)).toBe(1)
    const ran = await h.drain()
    expect(ran.map((j) => j.name)).toEqual(["calendar-incremental-sync"])
    expect((await h.event(TEAM, "teamlunch01"))?.title).toBe("Team lunch (moved upstairs)")
  })

  it("a Liaison create is pushed to Google, and its echo does not change the row", async () => {
    // Each test connects its own Google account (the org is shared by the file's tests).
    const email = `owner-${crypto.randomUUID().slice(0, 8)}@example.test`
    const google = FakeGoogleCalendar.fromFixtures({ accountEmail: email })
    const h = createCalendarSyncHarness({ orgId, userId, google })
    await h.connect(email)
    await h.drain()
    const team = await h.calendar(TEAM)

    const created = (await h.tool("create_event", {
      calendarId: team?.id,
      title: "Planning",
      start: "2026-10-23T09:00:00.000Z",
      end: "2026-10-23T10:00:00.000Z",
    })) as { eventId: string }
    await h.drain()

    const pushed = google.requestsFor("events.insert")
    expect(pushed).toHaveLength(1)
    const rows = await h.events(TEAM)
    const row = rows.find((r) => r.id === created.eventId)
    expect(row?.pending_push).toBe("none")
    const googleId = row?.google_event_id as string
    expect(google.getEvent(TEAM, googleId)?.summary).toBe("Planning")
    expect(row?.etag).toBe(google.getEvent(TEAM, googleId)?.etag)

    await h.notify(TEAM)
    await h.drain()
    const after = (await h.events(TEAM)).find((r) => r.id === created.eventId)
    expect(after?.liaison_sync_version).toBe(row?.liaison_sync_version)
    expect(after?.title).toBe("Planning")
  })
})
