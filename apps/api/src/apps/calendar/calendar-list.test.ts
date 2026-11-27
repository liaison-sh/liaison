// SPDX-License-Identifier: FSL-1.1-ALv2
// The calendar list against the stateful fake Google Calendar: it is refreshed daily (new
// calendars appear, removed ones go with their events and channel), only the calendars the
// account can write to start selected, an unselected calendar is not synced, and a full resync
// after an expired sync token keeps the local event ids.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { FakeGoogleCalendar } from "~/apps/calendar/__fixtures__/google/fake-google-calendar"
import { createCalendarSyncHarness } from "~/apps/calendar/__fixtures__/google/sync-harness"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

const OWNER = "owner@example.test"
const TEAM = "team0001@group.calendar.google.com"
const HOLIDAYS = "en.french#holiday@group.v.calendar.google.com"
const NEW_CAL = "new0001@group.calendar.google.com"

let orgId: string
let userId: string

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-list-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  orgId = await seedOrgRow({ name: "Calendar List Org", slug })
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
  const accountId = await h.connect(email)
  await h.drain()
  return { google, h, accountId }
}

describe("G7: default selection", () => {
  it("the primary and writable calendars start selected; a reader calendar does not, and is not synced", async () => {
    const { google, h } = await connected()
    expect((await h.calendar(OWNER))?.selected).toBe(true)
    expect((await h.calendar(TEAM))?.selected).toBe(true)
    const holidays = await h.calendar(HOLIDAYS)
    expect(holidays?.selected).toBe(false)
    expect(holidays?.sync_token).toBeNull()
    expect(await h.events(HOLIDAYS)).toEqual([])
    expect(google.requestsFor("events.list").some((r) => r.calendarId === HOLIDAYS)).toBe(false)
    expect(google.activeChannels(HOLIDAYS)).toEqual([])
  })

  it("an initial sync queued for a calendar deselected since then lists nothing", async () => {
    const { google, h } = await connected()
    const holidays = await h.calendar(HOLIDAYS)
    await h.runJob("calendar-initial-sync", { calendarId: holidays?.id })
    expect(google.requestsFor("events.list").some((r) => r.calendarId === HOLIDAYS)).toBe(false)
  })

  it("lists events 2500 per page", async () => {
    const { google } = await connected()
    expect(google.requestsFor("events.list").every((r) => r.query.maxResults === "2500")).toBe(true)
  })
})

describe("G6: the calendar list stays current", () => {
  it("the daily refresh adds a calendar created in Google, renames one, and removes one that left", async () => {
    const { google, h } = await connected()
    const team = await h.calendar(TEAM)
    const teamChannel = google.channels.get(team?.watch_channel_id as string)
    expect(teamChannel?.stopped).toBe(false)
    const teamListsBefore = google.requestsFor("events.list").filter((r) => r.calendarId === TEAM)

    google.addCalendar({ id: NEW_CAL, summary: "Launch", accessRole: "owner" })
    google.createEvent(NEW_CAL, {
      summary: "Launch review",
      start: { dateTime: "2026-10-28T10:00:00Z" },
      end: { dateTime: "2026-10-28T11:00:00Z" },
    })
    google.updateCalendar(OWNER, { summary: "Me", backgroundColor: "#000000" })
    google.removeCalendar(TEAM)

    await h.runJob("calendar-list-refresh")
    await h.drain()

    const added = await h.calendar(NEW_CAL)
    expect(added?.selected).toBe(true)
    expect((await h.events(NEW_CAL)).map((e) => e.title)).toEqual(["Launch review"])
    expect((await h.calendar(OWNER))?.name).toBe("Me")
    expect((await h.calendar(OWNER))?.color).toBe("#000000")
    expect(await h.calendar(TEAM)).toBeNull()
    expect(await h.events(TEAM)).toEqual([])
    expect(teamChannel?.stopped).toBe(true)
    // A calendar already synced is not listed again whole.
    const teamListsAfter = google.requestsFor("events.list").filter((r) => r.calendarId === TEAM)
    expect(teamListsAfter).toHaveLength(teamListsBefore.length)
    expect(
      google.requestsFor("events.list").filter((r) => r.calendarId === OWNER && !r.query.syncToken),
    ).toHaveLength(1)
  })

  it("a calendar the user selected stays selected through a refresh", async () => {
    const { h } = await connected()
    const holidays = await h.calendar(HOLIDAYS)
    await h.tool("set_selected", { calendarId: holidays?.id, selected: true })
    await h.drain()
    await h.runJob("calendar-list-refresh")
    await h.drain()
    expect((await h.calendar(HOLIDAYS))?.selected).toBe(true)
    expect((await h.events(HOLIDAYS)).map((e) => e.title)).toEqual(["Armistice"])
  })
})

describe("G11: a full resync keeps event ids", () => {
  it("after a 410 the rows keep their ids, changes apply, and events gone from Google are swept", async () => {
    const { google, h } = await connected()
    const before = new Map((await h.events(TEAM)).map((e) => [e.google_event_id, e.id]))
    const lunchId = before.get("teamlunch01")
    expect(lunchId).toBeTruthy()

    google.createEvent(TEAM, {
      id: "standup0001",
      summary: "Standup",
      start: { dateTime: "2026-10-22T08:00:00Z" },
      end: { dateTime: "2026-10-22T08:15:00Z" },
    })
    await h.notify(TEAM)
    await h.drain()
    const standupId = (await h.event(TEAM, "standup0001"))?.id
    expect(standupId).toBeTruthy()

    google.invalidateSyncTokens(TEAM)
    google.updateEvent(TEAM, "teamlunch01", { summary: "Team lunch (Friday)" })
    google.deleteEvent(TEAM, "standup0001")
    await h.notify(TEAM)
    await h.drain()

    const lunch = await h.event(TEAM, "teamlunch01")
    expect(lunch?.id).toBe(lunchId)
    expect(lunch?.title).toBe("Team lunch (Friday)")
    expect(await h.event(TEAM, "standup0001")).toBeNull()
    expect((await h.calendar(TEAM))?.full_sync_run).toBeNull()
    expect((await h.calendar(TEAM))?.sync_token).toBeTruthy()
  })

  it("a local event not yet on Google survives the resync's sweep", async () => {
    const { google, h } = await connected()
    const team = await h.calendar(TEAM)
    google.failNext("events.insert", "serviceUnavailable", 10)
    const { eventId } = (await h.tool("create_event", {
      calendarId: team?.id,
      title: "Not pushed yet",
      start: "2026-10-23T09:00:00.000Z",
      end: "2026-10-23T10:00:00.000Z",
    })) as { eventId: string }
    await h.drain({ skipDelayed: true, only: (j) => j.name === "calendar-push" })
    google.invalidateSyncTokens(TEAM)
    await h.notify(TEAM)
    await h.drain({ only: (j) => j.name !== "calendar-push" })
    expect((await h.events(TEAM)).some((e) => e.id === eventId)).toBe(true)
  })
})
