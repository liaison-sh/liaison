// SPDX-License-Identifier: FSL-1.1-ALv2
// find_free_slots through the real handler, bridge and database against the stateful fake Google
// Calendar: the caller's own synced events block their slots, the guests' busy times come from
// freebusy.query, and a token without the free/busy scope degrades to the caller's calendar alone
// with a consent request (the scope is asked for incrementally, on first use).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { FakeGoogleCalendar } from "./__fixtures__/google/fake-google-calendar"
import { createCalendarSyncHarness } from "./__fixtures__/google/sync-harness"

const OWNER = "owner@example.test"
const AMINA = "amina@example.test"
const LUCAS = "lucas@example.test"
const OUTSIDER = "someone@elsewhere.test"
const PARIS = "Europe/Paris"
// Monday 7 and Tuesday 8 December 2026, Paris time (UTC+1).
const WINDOW = { timeMin: "2026-12-07T00:00:00+01:00", timeMax: "2026-12-09T00:00:00+01:00" }

let orgId: string
let userId: string
let teammate: string

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-free-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  orgId = await seedOrgRow({ name: "Calendar Free Slots Org", slug })
  userId = await seedUserRow({
    orgId,
    email: `owner-${slug}@x.test`,
    name: "Owner",
    status: "active",
    passwordHash: "h",
  })
  teammate = `teammate-${slug}@x.test`
  await seedUserRow({
    orgId,
    email: teammate,
    name: "Teammate",
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

interface SlotsResult {
  timeZone: string
  slots: { start: string; end: string }[]
  attendees: { email: string; status: string; reason?: string }[]
  consent?: { needed: boolean; scope: string }
}

async function connected() {
  const google = FakeGoogleCalendar.fromFixtures({ accountEmail: OWNER })
  // The owner's own Monday: busy 09:00-10:30, a free-marked focus block 10:30-12:00.
  google.createEvent(OWNER, {
    summary: "Standup and planning",
    start: { dateTime: "2026-12-07T09:00:00+01:00", timeZone: PARIS },
    end: { dateTime: "2026-12-07T10:30:00+01:00", timeZone: PARIS },
  })
  google.createEvent(OWNER, {
    summary: "Focus",
    transparency: "transparent",
    start: { dateTime: "2026-12-07T10:30:00+01:00", timeZone: PARIS },
    end: { dateTime: "2026-12-07T12:00:00+01:00", timeZone: PARIS },
  } as Parameters<FakeGoogleCalendar["createEvent"]>[1])
  const h = createCalendarSyncHarness({ orgId, userId, google })
  await h.connect(OWNER)
  await h.drain()
  return { google, h }
}

describe("find_free_slots", () => {
  it("finds 30 minutes with two guests: own events and the guests' free/busy both block", async () => {
    const { google, h } = await connected()
    google.setBusy(AMINA, [{ start: "2026-12-07T09:30:00Z", end: "2026-12-07T11:00:00Z" }]) // 10:30-12:00
    google.setBusy(LUCAS, [{ start: "2026-12-07T11:00:00Z", end: "2026-12-07T12:00:00Z" }]) // 12:00-13:00
    const result = (await h.tool("find_free_slots", {
      durationMinutes: 30,
      attendees: [AMINA, LUCAS],
      timeZone: PARIS,
      ...WINDOW,
      maxPerDay: 2,
    })) as SlotsResult

    expect(result.timeZone).toBe(PARIS)
    expect(result.attendees).toEqual([
      { email: AMINA, status: "checked" },
      { email: LUCAS, status: "checked" },
    ])
    expect(result.consent).toBeUndefined()
    // 09:00-10:30 own meeting, 10:30-12:00 Amina, 12:00-13:00 Lucas; the free focus block does
    // not count.
    expect(result.slots.map((s) => s.start)).toEqual([
      "2026-12-07T13:00:00+01:00",
      "2026-12-07T13:30:00+01:00",
      "2026-12-08T09:00:00+01:00",
      "2026-12-08T09:30:00+01:00",
    ])
    const query = google.requestsFor("freebusy.query")
    expect(query).toHaveLength(1)
    expect(
      (query[0]?.body as { items: { id: string }[] } | undefined)?.items.map((i) => i.id),
    ).toEqual([AMINA, LUCAS])
  })

  it("reports a guest Google cannot see as unknown and still answers", async () => {
    const { google, h } = await connected()
    google.setFreeBusyError(OUTSIDER, "notFound")
    const result = (await h.tool("find_free_slots", {
      attendees: [OUTSIDER],
      timeZone: PARIS,
      ...WINDOW,
      maxResults: 1,
    })) as SlotsResult
    expect(result.attendees).toEqual([{ email: OUTSIDER, status: "unknown", reason: "notFound" }])
    expect(result.slots[0]?.start).toBe("2026-12-07T10:30:00+01:00")
  })

  it("without the free/busy scope it answers from the caller's calendar and asks for consent", async () => {
    const { google, h } = await connected()
    google.grantFreeBusy(false)
    const result = (await h.tool("find_free_slots", {
      attendees: [AMINA],
      timeZone: PARIS,
      ...WINDOW,
      maxResults: 1,
    })) as SlotsResult
    expect(result.attendees).toEqual([{ email: AMINA, status: "needs_consent" }])
    expect(result.consent).toMatchObject({
      needed: true,
      scope: "https://www.googleapis.com/auth/calendar.freebusy",
    })
    expect(result.slots[0]?.start).toBe("2026-12-07T10:30:00+01:00")
  })

  it("counts a teammate's events Liaison already holds, without Google's free/busy", async () => {
    const { google, h } = await connected()
    google.grantFreeBusy(false)
    // Tuesday 09:00-10:00: the teammate attends; the owner declined, so only the teammate is busy.
    const created = (await h.tool("create_event", {
      calendarId: (await h.calendar(OWNER))?.id,
      title: "Teammate review",
      start: "2026-12-08T08:00:00.000Z",
      end: "2026-12-08T09:00:00.000Z",
      attendees: [teammate, OWNER],
    })) as { eventId: string }
    const { sql } = await import("drizzle-orm")
    await h.sql(
      sql`UPDATE app_calendar.events SET attendees = ${JSON.stringify([
        { email: OWNER, self: true, responseStatus: "declined" },
        { email: teammate, responseStatus: "accepted" },
      ])}::jsonb WHERE id = ${created.eventId}::uuid`,
    )
    const result = (await h.tool("find_free_slots", {
      attendees: [teammate],
      timeZone: PARIS,
      timeMin: "2026-12-08T00:00:00+01:00",
      timeMax: "2026-12-09T00:00:00+01:00",
      maxResults: 1,
    })) as SlotsResult
    expect(result.attendees).toEqual([
      { email: teammate, status: "checked", reason: "calendars in Liaison" },
    ])
    expect(result.consent).toBeUndefined()
    expect(result.slots[0]?.start).toBe("2026-12-08T10:00:00+01:00")
  })
})
