// SPDX-License-Identifier: FSL-1.1-ALv2
// The sync harness proves itself: the real handlers, bridge and database round-trip against the
// stateful fake Google Calendar (connect -> import -> initial sync -> watch -> Google-side edit ->
// push notification -> incremental sync; Liaison create -> push -> echo suppressed).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
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
  await withSystemDb("calendar-harness-fixture", async (tx) => {
    const o: unknown = await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Calendar Harness Org', ${slug}) RETURNING id`)
    orgId = firstId(o)
    const u: unknown = await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`owner-${slug}@x.test`}, 'Owner', 'active', 'h', 1, 1)
      RETURNING id`)
    userId = firstId(u)
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

function firstId(res: unknown): string {
  const rows = Array.isArray(res) ? res : (res as { rows?: Array<{ id: string }> }).rows
  const id = (rows?.[0] as { id?: string } | undefined)?.id
  if (!id) throw new Error("fixture insert returned no id")
  return id
}

describe("calendar sync harness against the fake Google Calendar", () => {
  it("connect imports the calendars, syncs their events and watches them", async () => {
    const google = FakeGoogleCalendar.fromFixtures({ accountEmail: OWNER })
    const h = createCalendarSyncHarness({ orgId, userId, google })
    await h.connect(OWNER)
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
    const google = FakeGoogleCalendar.fromFixtures({ accountEmail: OWNER })
    const h = createCalendarSyncHarness({ orgId, userId, google })
    await h.connect(OWNER)
    await h.drain()

    google.updateEvent(TEAM, "teamlunch01", { summary: "Team lunch (moved upstairs)" })
    expect(await h.notify(TEAM)).toBe(1)
    const ran = await h.drain()
    expect(ran.map((j) => j.name)).toEqual(["calendar-incremental-sync"])
    expect((await h.event(TEAM, "teamlunch01"))?.title).toBe("Team lunch (moved upstairs)")
  })

  it("a Liaison create is pushed to Google, and its echo does not change the row", async () => {
    const google = FakeGoogleCalendar.fromFixtures({ accountEmail: OWNER })
    const h = createCalendarSyncHarness({ orgId, userId, google })
    await h.connect(OWNER)
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
