// SPDX-License-Identifier: FSL-1.1-ALv2
// Outbound writes against the stateful fake Google Calendar: a local edit keeps the edits made
// in Google meanwhile (field-by-field merge, the newer change wins a true conflict with a
// notice), every timed write names its time zone, an all-day end is exclusive, and a calendar
// the account may only read refuses writes up front.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { FakeGoogleCalendar } from "~/apps/calendar/__fixtures__/google/fake-google-calendar"
import { createCalendarSyncHarness } from "~/apps/calendar/__fixtures__/google/sync-harness"
import { expandRecurringEvent, type RawEventRow } from "~/apps/calendar/tools"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

const OWNER = "owner@example.test"
const TEAM = "team0001@group.calendar.google.com"
const HOLIDAYS = "en.french#holiday@group.v.calendar.google.com"

let orgId: string
let userId: string

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-outbound-merge-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  orgId = await seedOrgRow({ name: "Calendar Outbound Merge Org", slug })
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

async function connected() {
  const email = `owner-${crypto.randomUUID().slice(0, 8)}@example.test`
  const google = FakeGoogleCalendar.fromFixtures({ accountEmail: email })
  const h = createCalendarSyncHarness({ orgId, userId, google })
  await h.connect(email)
  await h.drain()
  return { google, h }
}

async function localId(h: Awaited<ReturnType<typeof connected>>["h"], cal: string, gid: string) {
  const row = await h.event(cal, gid)
  if (!row) throw new Error(`no local row for ${gid}`)
  return row.id as string
}

describe("G2 / D5: a local edit keeps Google's edits", () => {
  it("Google edits the description, Liaison moves the time before the sync: both survive", async () => {
    const { google, h } = await connected()
    const id = await localId(h, OWNER, "timed0001")
    google.updateEvent(OWNER, "timed0001", { description: "Agenda moved to the wiki" })

    await h.tool("update_event", {
      eventId: id,
      start: "2026-10-20T13:00:00.000Z",
      end: "2026-10-20T14:00:00.000Z",
    })
    await h.drain({ only: (j) => j.name === "calendar-push" })

    const remote = google.getEvent(OWNER, "timed0001")!
    expect(remote.description).toBe("Agenda moved to the wiki")
    expect(Date.parse(remote.start!.dateTime!)).toBe(Date.parse("2026-10-20T13:00:00.000Z"))
    expect(remote.location).toBe("Room 2")
    const row = await h.event(OWNER, "timed0001")
    expect(row?.description).toBe("Agenda moved to the wiki")
    expect(row?.pending_push).toBe("none")
    expect(row?.push_notice).toBeNull()
    expect(row?.push_base).toBeNull()
  })

  it("the same field on both sides: Google's newer change wins and the event says so", async () => {
    const { google, h } = await connected()
    const id = await localId(h, OWNER, "timed0001")
    await h.tool("update_event", { eventId: id, title: "Design review (v2)" })
    // Google's change comes after the local one.
    google.setNow(new Date(Date.now() + 60_000).toISOString())
    google.updateEvent(OWNER, "timed0001", { summary: "Design review, moved online" })
    await h.drain({ only: (j) => j.name === "calendar-push" })

    expect(google.getEvent(OWNER, "timed0001")?.summary).toBe("Design review, moved online")
    const row = await h.event(OWNER, "timed0001")
    expect(row?.title).toBe("Design review, moved online")
    expect(row?.push_notice).toContain("kept the change made in Google")
    expect(row?.push_notice).toContain('"Design review (v2)"')
  })

  it("the same field on both sides: the newer local change wins and names Google's value", async () => {
    const { google, h } = await connected()
    const id = await localId(h, OWNER, "timed0001")
    google.setNow(new Date(Date.now() - 60_000).toISOString())
    google.updateEvent(OWNER, "timed0001", { location: "Room 7" })
    await h.tool("update_event", { eventId: id, location: "Room 3" })
    await h.drain({ only: (j) => j.name === "calendar-push" })

    expect(google.getEvent(OWNER, "timed0001")?.location).toBe("Room 3")
    const row = await h.event(OWNER, "timed0001")
    expect(row?.location).toBe("Room 3")
    expect(row?.push_notice).toContain('kept your change; Google had "Room 7"')
  })

  it("a Google change between the read and the write is merged on the retry", async () => {
    const { google, h } = await connected()
    const id = await localId(h, OWNER, "timed0001")
    await h.tool("update_event", { eventId: id, title: "Design review (final)" })
    google.beforeNext("events.update", () => {
      google.updateEvent(OWNER, "timed0001", { description: "Bring the prototypes" })
    })
    await h.drain({ only: (j) => j.name === "calendar-push" })

    const remote = google.getEvent(OWNER, "timed0001")!
    expect(remote.summary).toBe("Design review (final)")
    expect(remote.description).toBe("Bring the prototypes")
    expect(google.requestsFor("events.update")).toHaveLength(2)
  })
})

describe("G3: writes carry the time zone", () => {
  it("a weekly event created in Liaison is accepted and stays at 09:00 local across DST", async () => {
    const { google, h } = await connected()
    const team = await h.calendar(TEAM)
    const { eventId } = (await h.tool("create_event", {
      calendarId: team?.id,
      title: "Weekly planning",
      start: "2026-10-19T07:00:00.000Z",
      end: "2026-10-19T07:30:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
    })) as { eventId: string }
    await h.drain()

    const rows = await h.events<RawEventRow & { pending_push: string; push_error: string | null }>(
      TEAM,
    )
    const row = rows.find((r) => r.id === eventId)!
    expect(row.push_error).toBeNull()
    expect(row.pending_push).toBe("none")
    const remote = google.getEvent(TEAM, row.google_event_id as string)!
    expect(remote.start?.timeZone).toBe("Europe/Paris")
    const starts = expandRecurringEvent(
      row,
      [],
      new Date("2026-10-18T00:00:00Z"),
      new Date("2026-11-03T00:00:00Z"),
    ).map((o) => new Date((o.start as { dateTime: string }).dateTime).toISOString())
    // 09:00 Paris: 07:00Z in summer time, 08:00Z after the change on 25 October.
    expect(starts).toEqual([
      "2026-10-19T07:00:00.000Z",
      "2026-10-26T08:00:00.000Z",
      "2026-11-02T08:00:00.000Z",
    ])
  })

  it("a one-day all-day event given as start = end is sent with Google's exclusive end", async () => {
    const { google, h } = await connected()
    const team = await h.calendar(TEAM)
    const { eventId } = (await h.tool("create_event", {
      calendarId: team?.id,
      title: "Team day",
      start: "2026-10-23",
      end: "2026-10-23",
      allDay: true,
    })) as { eventId: string }
    await h.drain()
    const row = (await h.events(TEAM)).find((r) => r.id === eventId)!
    expect(row.push_error).toBeNull()
    expect(row.end).toEqual({ date: "2026-10-24" })
    const remote = google.getEvent(TEAM, row.google_event_id as string)!
    expect(remote.start).toEqual({ date: "2026-10-23" })
    expect(remote.end).toEqual({ date: "2026-10-24" })
  })
})

describe("G8: read-only calendars", () => {
  it("create_event on a reader calendar is refused before anything is stored", async () => {
    const { google, h } = await connected()
    const holidays = await h.calendar(HOLIDAYS)
    const before = (await h.events(HOLIDAYS)).length
    await expect(
      h.tool("create_event", {
        calendarId: holidays?.id,
        title: "Day off",
        start: "2026-10-23",
        end: "2026-10-24",
        allDay: true,
      }),
    ).rejects.toThrow(/read-only for this account \(access reader\)/)
    expect((await h.events(HOLIDAYS)).length).toBe(before)
    expect(google.requestsFor("events.insert")).toHaveLength(0)
  })

  it("update_event and delete_event on a reader calendar's event are refused", async () => {
    const { h } = await connected()
    const id = await localId(h, HOLIDAYS, "20261111_holiday")
    await expect(h.tool("update_event", { eventId: id, title: "x" })).rejects.toThrow(/read-only/)
    await expect(h.tool("delete_event", { eventId: id })).rejects.toThrow(/read-only/)
    expect((await h.event(HOLIDAYS, "20261111_holiday"))?.title).toBe("Armistice")
  })
})
