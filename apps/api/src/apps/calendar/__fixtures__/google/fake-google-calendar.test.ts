// SPDX-License-Identifier: FSL-1.1-ALv2
// The fake Google Calendar API answers the way Google documents it (no database).
import { describe, expect, it } from "bun:test"
import {
  FakeGoogleCalendar,
  GOOGLE_CALENDAR_API_BASE,
  instanceIdOf,
  parseInstanceId,
} from "./fake-google-calendar"

const OWNER = "owner@example.test"
const TEAM = "team0001@group.calendar.google.com"
const HOLIDAYS = "en.french#holiday@group.v.calendar.google.com"
const AUTH = { Authorization: "Bearer t" }

function call(
  fake: FakeGoogleCalendar,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = fake.handle({
    method,
    url: `${GOOGLE_CALENDAR_API_BASE}/${path}`,
    headers: { ...AUTH, ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return { status: res.status, body: res.body ? JSON.parse(res.body) : null }
}

const events = (cal: string) => `calendars/${encodeURIComponent(cal)}/events`

describe("fake Google Calendar: events.list and sync tokens", () => {
  it("a full list then an incremental list returns only what changed, deletions included", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    const full = call(fake, "GET", `${events(OWNER)}?singleEvents=false&showDeleted=true`)
    expect(full.status).toBe(200)
    expect(full.body.items.map((i: { id: string }) => i.id)).toContain(
      "weekly0001_20261109T080000Z",
    )
    expect(full.body.items.map((i: { id: string }) => i.id)).toContain("oldcancel01")
    const token = full.body.nextSyncToken as string
    expect(token).toBeTruthy()

    const empty = call(fake, "GET", `${events(OWNER)}?syncToken=${token}`)
    expect(empty.body.items).toEqual([])

    fake.updateEvent(OWNER, "timed0001", { description: "New agenda" })
    fake.deleteEvent(OWNER, "allday0001")
    const delta = call(fake, "GET", `${events(OWNER)}?syncToken=${empty.body.nextSyncToken}`)
    const byId = Object.fromEntries(delta.body.items.map((i: { id: string }) => [i.id, i]))
    expect(Object.keys(byId).sort()).toEqual(["allday0001", "timed0001"])
    expect(byId.timed0001.description).toBe("New agenda")
    // A deleted event carries only its identity, as Google lists it.
    expect(byId.allday0001).toEqual({
      kind: "calendar#event",
      etag: expect.any(String),
      id: "allday0001",
      status: "cancelled",
    })
  })

  it("without showDeleted, cancelled one-offs are left out but cancelled occurrences stay", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    const ids = call(fake, "GET", `${events(OWNER)}?singleEvents=false`).body.items.map(
      (i: { id: string }) => i.id,
    )
    expect(ids).not.toContain("oldcancel01")
    expect(ids).toContain("weekly0001_20261109T080000Z")
  })

  it("pages with maxResults (capped at 2500) and gives the sync token on the last page only", () => {
    const fake = new FakeGoogleCalendar()
    fake.addCalendar({ id: OWNER, accessRole: "owner" })
    for (let i = 0; i < 5; i++) {
      fake.createEvent(OWNER, {
        summary: `e${i}`,
        start: { dateTime: "2026-10-20T10:00:00Z" },
        end: { dateTime: "2026-10-20T11:00:00Z" },
      })
    }
    const p1 = call(fake, "GET", `${events(OWNER)}?maxResults=2`)
    expect(p1.body.items).toHaveLength(2)
    expect(p1.body.nextSyncToken).toBeUndefined()
    const p2 = call(fake, "GET", `${events(OWNER)}?maxResults=2&pageToken=${p1.body.nextPageToken}`)
    const p3 = call(fake, "GET", `${events(OWNER)}?maxResults=2&pageToken=${p2.body.nextPageToken}`)
    expect(p3.body.items).toHaveLength(1)
    expect(p3.body.nextSyncToken).toBeTruthy()
    expect(call(fake, "GET", `${events(OWNER)}?maxResults=9999`).body.items).toHaveLength(5)
    expect(fake.requestsFor("events.list").at(-1)?.query.maxResults).toBe("9999")
  })

  it("answers 410 fullSyncRequired once the calendar's tokens are invalidated", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    const token = call(fake, "GET", events(OWNER)).body.nextSyncToken
    fake.invalidateSyncTokens(OWNER)
    const gone = call(fake, "GET", `${events(OWNER)}?syncToken=${token}`)
    expect(gone.status).toBe(410)
    expect(gone.body.error.errors[0].reason).toBe("fullSyncRequired")
  })

  it("refuses a syncToken combined with timeMin", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    const token = call(fake, "GET", events(OWNER)).body.nextSyncToken
    expect(
      call(fake, "GET", `${events(OWNER)}?syncToken=${token}&timeMin=2026-01-01T00:00:00Z`).status,
    ).toBe(400)
  })
})

describe("fake Google Calendar: writes", () => {
  it("If-Match with a stale etag answers 412; the current etag is accepted", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    const got = call(fake, "GET", `${events(OWNER)}/timed0001`).body
    fake.updateEvent(OWNER, "timed0001", { description: "edited in Google" })
    const stale = call(fake, "PUT", `${events(OWNER)}/timed0001`, {
      body: { ...got, summary: "x" },
      headers: { "If-Match": got.etag },
    })
    expect(stale.status).toBe(412)
    const fresh = fake.getEvent(OWNER, "timed0001")!
    const ok = call(fake, "PUT", `${events(OWNER)}/timed0001`, {
      body: { ...fresh, summary: "x" },
      headers: { "If-Match": fresh.etag! },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.summary).toBe("x")
    expect(ok.body.etag).not.toBe(fresh.etag)
  })

  it("PUT replaces the resource: a field left out is dropped", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    const got = fake.getEvent(OWNER, "timed0001")!
    const { description: _d, ...rest } = got
    const put = call(fake, "PUT", `${events(OWNER)}/timed0001`, { body: rest })
    expect(put.body.description).toBeUndefined()
    expect(put.body.organizer).toEqual(got.organizer)
  })

  it("requires a time zone on a recurring event and refuses an empty all-day range", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    const noZone = call(fake, "POST", events(OWNER), {
      body: {
        summary: "Weekly",
        start: { dateTime: "2026-10-20T09:00:00Z" },
        end: { dateTime: "2026-10-20T09:30:00Z" },
        recurrence: ["RRULE:FREQ=WEEKLY"],
      },
    })
    expect(noZone.status).toBe(400)
    expect(noZone.body.error.message).toContain("Missing time zone")
    const withZone = call(fake, "POST", events(OWNER), {
      body: {
        summary: "Weekly",
        start: { dateTime: "2026-10-20T09:00:00+02:00", timeZone: "Europe/Paris" },
        end: { dateTime: "2026-10-20T09:30:00+02:00", timeZone: "Europe/Paris" },
        recurrence: ["RRULE:FREQ=WEEKLY"],
      },
    })
    expect(withZone.status).toBe(200)
    const sameDay = call(fake, "POST", events(OWNER), {
      body: { summary: "Day", start: { date: "2026-10-20" }, end: { date: "2026-10-20" } },
    })
    expect(sameDay.status).toBe(400)
    expect(sameDay.body.error.errors[0].reason).toBe("timeRangeEmpty")
    const oneDay = call(fake, "POST", events(OWNER), {
      body: { summary: "Day", start: { date: "2026-10-20" }, end: { date: "2026-10-21" } },
    })
    expect(oneDay.status).toBe(200)
  })

  it("a client id is taken once (409 after), and must be base32hex", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    const body = {
      id: "abc123def456",
      start: { dateTime: "2026-10-20T09:00:00Z" },
      end: { dateTime: "2026-10-20T09:30:00Z" },
    }
    expect(call(fake, "POST", events(OWNER), { body }).status).toBe(200)
    expect(call(fake, "POST", events(OWNER), { body }).status).toBe(409)
    expect(call(fake, "POST", events(OWNER), { body: { ...body, id: "Not_Valid!" } }).status).toBe(
      400,
    )
  })

  it("a calendar the account only reads refuses writes with 403 requiredAccessLevel", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    const res = call(fake, "POST", events(HOLIDAYS), {
      body: { start: { date: "2026-10-20" }, end: { date: "2026-10-21" } },
    })
    expect(res.status).toBe(403)
    expect(res.body.error.errors[0].reason).toBe("requiredAccessLevel")
    expect(call(fake, "DELETE", `${events(HOLIDAYS)}/20261111_holiday`).status).toBe(403)
  })

  it("creates a Meet link only with conferenceDataVersion=1", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    const body = {
      start: { dateTime: "2026-10-20T09:00:00Z" },
      end: { dateTime: "2026-10-20T09:30:00Z" },
      conferenceData: {
        createRequest: { requestId: "r1", conferenceSolutionKey: { type: "hangoutsMeet" } },
      },
    }
    expect(call(fake, "POST", events(TEAM), { body }).body.hangoutLink).toBeUndefined()
    const meet = call(fake, "POST", `${events(TEAM)}?conferenceDataVersion=1`, { body }).body
    expect(meet.hangoutLink).toStartWith("https://meet.google.com/")
    expect(meet.conferenceData.entryPoints[0].entryPointType).toBe("video")
  })

  it("an occurrence is readable by its instance id; writing it makes an exception", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    const original = { dateTime: "2026-10-26T08:00:00Z" }
    const id = instanceIdOf("weekly0001", original)
    expect(id).toBe("weekly0001_20261026T080000Z")
    expect(parseInstanceId(id)).toEqual({ masterId: "weekly0001", originalStart: original })
    const got = call(fake, "GET", `${events(OWNER)}/${id}`)
    expect(got.status).toBe(200)
    expect(got.body.recurringEventId).toBe("weekly0001")
    expect(got.body.recurrence).toBeUndefined()
    expect(fake.getEvent(OWNER, id)).toBeNull()
    const put = call(fake, "PUT", `${events(OWNER)}/${id}`, {
      body: { ...got.body, summary: "Only this one" },
    })
    expect(put.status).toBe(200)
    expect(fake.getEvent(OWNER, id)?.summary).toBe("Only this one")
    expect(fake.getEvent(OWNER, id)?.originalStartTime?.timeZone).toBe("Europe/Paris")
  })

  it("deleting twice answers 410; deleting an occurrence cancels only it", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    expect(call(fake, "DELETE", `${events(OWNER)}/timed0001`).status).toBe(204)
    expect(call(fake, "DELETE", `${events(OWNER)}/timed0001`).status).toBe(410)
    expect(call(fake, "DELETE", `${events(OWNER)}/weekly0001_20261019T070000Z`).status).toBe(204)
    expect(fake.getEvent(OWNER, "weekly0001_20261019T070000Z")?.status).toBe("cancelled")
    expect(fake.getEvent(OWNER, "weekly0001")?.status).toBe("confirmed")
  })

  it("Google-side occurrence changes show up in the incremental list as exceptions", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    const token = call(fake, "GET", events(OWNER)).body.nextSyncToken
    const cancelled = fake.cancelOccurrence(OWNER, "weekly0001", {
      dateTime: "2026-10-26T08:00:00Z",
    })
    const delta = call(fake, "GET", `${events(OWNER)}?syncToken=${token}`).body.items
    expect(delta).toEqual([
      {
        kind: "calendar#event",
        etag: expect.any(String),
        id: cancelled,
        status: "cancelled",
        recurringEventId: "weekly0001",
        originalStartTime: { dateTime: "2026-10-26T08:00:00Z", timeZone: "Europe/Paris" },
      },
    ])
  })
})

describe("fake Google Calendar: channels, calendar list, faults", () => {
  it("watch, notify and stop a channel", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    expect(
      call(fake, "POST", `${events(OWNER)}/watch`, {
        body: { id: "ch1", type: "web_hook", address: "http://insecure.test" },
      }).status,
    ).toBe(400)
    const watch = call(fake, "POST", `${events(OWNER)}/watch`, {
      body: { id: "ch1", type: "web_hook", address: "https://hook.test", token: "tok" },
    }).body
    expect(Number(watch.expiration)).toBeGreaterThan(fake.now())
    const [note] = fake.notificationsFor(OWNER)
    expect(note?.["x-goog-channel-id"]).toBe("ch1")
    expect(note?.["x-goog-channel-token"]).toBe("tok")
    expect(note?.["x-goog-resource-state"]).toBe("exists")
    expect(note?.["x-goog-message-number"]).toBe("1")
    expect(
      call(fake, "POST", "channels/stop", { body: { id: "ch1", resourceId: "wrong" } }).status,
    ).toBe(404)
    expect(
      call(fake, "POST", "channels/stop", { body: { id: "ch1", resourceId: watch.resourceId } })
        .status,
    ).toBe(204)
    expect(fake.notificationsFor(OWNER)).toEqual([])
  })

  it("an expired channel stops notifying", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    call(fake, "POST", `${events(OWNER)}/watch`, {
      body: { id: "ch2", type: "web_hook", address: "https://hook.test" },
    })
    fake.advance(8 * 24 * 3_600_000)
    expect(fake.activeChannels(OWNER)).toEqual([])
  })

  it("calendarList honours minAccessRole and paging; added and removed calendars show", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    const readers = call(fake, "GET", "users/me/calendarList?minAccessRole=reader").body.items
    expect(readers.map((c: { id: string }) => c.id)).toEqual([OWNER, TEAM, HOLIDAYS])
    fake.addCalendar({
      id: "new0001@group.calendar.google.com",
      summary: "New",
      accessRole: "owner",
    })
    fake.removeCalendar(TEAM)
    const p1 = call(fake, "GET", "users/me/calendarList?minAccessRole=reader&maxResults=2").body
    const p2 = call(
      fake,
      "GET",
      `users/me/calendarList?minAccessRole=reader&maxResults=2&pageToken=${p1.nextPageToken}`,
    ).body
    expect([...p1.items, ...p2.items].map((c: { id: string }) => c.id)).toEqual([
      OWNER,
      HOLIDAYS,
      "new0001@group.calendar.google.com",
    ])
  })

  it("injected failures, a revoked grant and hooks", () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    fake.failNext("events.list", "rateLimitExceeded")
    fake.failNext("events.list", "tooManyRequests")
    fake.failNext((r) => r.op === "events.list", "serviceUnavailable")
    expect(call(fake, "GET", events(OWNER)).status).toBe(403)
    expect(call(fake, "GET", events(OWNER)).status).toBe(429)
    expect(call(fake, "GET", events(OWNER)).status).toBe(503)
    expect(call(fake, "GET", events(OWNER)).status).toBe(200)

    let saw = 0
    fake.beforeNext("events.update", () => {
      saw += 1
      fake.updateEvent(OWNER, "timed0001", { location: "Room 9" })
    })
    const got = fake.getEvent(OWNER, "timed0001")!
    const put = call(fake, "PUT", `${events(OWNER)}/timed0001`, {
      body: got,
      headers: { "If-Match": got.etag! },
    })
    expect(saw).toBe(1)
    expect(put.status).toBe(412)

    fake.revokeAccess()
    expect(call(fake, "GET", events(OWNER)).status).toBe(401)
    fake.restoreAccess()
    expect(
      fake.handle({ method: "GET", url: `${GOOGLE_CALENDAR_API_BASE}/${events(OWNER)}` }).status,
    ).toBe(401)
    expect(call(fake, "GET", "calendars/x/acl").status).toBe(404)
    expect(fake.unhandled).toHaveLength(1)
  })

  it("serves ctx.fetch's JSON envelope", async () => {
    const fake = FakeGoogleCalendar.fromFixtures()
    const raw = await fake.fetch(
      `${GOOGLE_CALENDAR_API_BASE}/${events(OWNER)}/timed0001`,
      JSON.stringify({ method: "GET", headers: AUTH }),
    )
    const res = JSON.parse(raw) as { status: number; body: string }
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).summary).toBe("Design review")
  })
})
