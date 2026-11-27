// SPDX-License-Identifier: FSL-1.1-ALv2
// Inbound sync against the stateful fake Google Calendar: a cancelled occurrence stays hidden,
// Google errors are retried or flagged (never only logged), a notification that lands during a
// sync is not lost, and a calendar is never left without a watch channel for good.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { FakeGoogleCalendar } from "~/apps/calendar/__fixtures__/google/fake-google-calendar"
import { createCalendarSyncHarness } from "~/apps/calendar/__fixtures__/google/sync-harness"
import { expandRecurringEvent, type RawEventRow } from "~/apps/calendar/tools"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

const OWNER = "owner@example.test"
const TEAM = "team0001@group.calendar.google.com"

let orgId: string
let userId: string

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-inbound-res-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  orgId = await seedOrgRow({ name: "Calendar Inbound Resilience Org", slug })
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

/** A fresh Google account with the recorded calendars, connected and fully synced. Each test
 * uses its own account address, so tests never see each other's rows. */
async function connected() {
  const email = `owner-${crypto.randomUUID().slice(0, 8)}@example.test`
  const google = FakeGoogleCalendar.fromFixtures({ accountEmail: email })
  const h = createCalendarSyncHarness({ orgId, userId, google })
  await h.connect(email)
  await h.drain()
  return { google, h }
}

/** The occurrences the weekly series shows in [from, to), as the agent and the web expand them. */
async function weeklyOccurrences(
  h: Awaited<ReturnType<typeof connected>>["h"],
  from: string,
  to: string,
): Promise<string[]> {
  const rows = await h.events<RawEventRow>(OWNER)
  const master = rows.find((r) => r.google_event_id === "weekly0001")
  if (!master) throw new Error("no weekly master row")
  const exceptions = rows.filter((r) => r.recurring_event_id === "weekly0001")
  return expandRecurringEvent(master, exceptions, new Date(from), new Date(to)).map((o) =>
    new Date((o.start as { dateTime: string }).dateTime).toISOString(),
  )
}

describe("G1: cancelled occurrences in incremental sync", () => {
  it("an occurrence deleted in Google stays hidden after the incremental sync", async () => {
    const { google, h } = await connected()
    const week = ["2026-10-26T00:00:00Z", "2026-11-02T00:00:00Z"] as const
    expect(await weeklyOccurrences(h, ...week)).toEqual(["2026-10-26T08:00:00.000Z"])

    const id = google.cancelOccurrence(OWNER, "weekly0001", { dateTime: "2026-10-26T08:00:00Z" })
    await h.notify(OWNER)
    await h.drain()

    const row = await h.event(OWNER, id)
    expect(row?.status).toBe("cancelled")
    expect(row?.recurring_event_id).toBe("weekly0001")
    expect(await weeklyOccurrences(h, ...week)).toEqual([])
  })

  it("a moved occurrence then cancelled in Google shows neither at its new nor its old slot", async () => {
    const { google, h } = await connected()
    const week = ["2026-11-02T00:00:00Z", "2026-11-09T00:00:00Z"] as const
    // The recorded moved occurrence: 09:00 -> 11:00 local on 2 November.
    expect(await weeklyOccurrences(h, ...week)).toEqual(["2026-11-02T10:00:00.000Z"])

    google.deleteEvent(OWNER, "weekly0001_20261102T080000Z")
    await h.notify(OWNER)
    await h.drain()

    expect((await h.event(OWNER, "weekly0001_20261102T080000Z"))?.status).toBe("cancelled")
    expect(await weeklyOccurrences(h, ...week)).toEqual([])
  })

  it("a series deleted in Google removes its master and its exceptions", async () => {
    const { google, h } = await connected()
    google.deleteEvent(OWNER, "weekly0001")
    await h.notify(OWNER)
    await h.drain()
    const rows = await h.events(OWNER)
    expect(rows.filter((r) => r.google_event_id === "weekly0001")).toEqual([])
    expect(rows.filter((r) => r.recurring_event_id === "weekly0001")).toEqual([])
  })

  it("a plain event deleted in Google is deleted locally", async () => {
    const { google, h } = await connected()
    google.deleteEvent(OWNER, "timed0001")
    await h.notify(OWNER)
    await h.drain()
    expect(await h.event(OWNER, "timed0001")).toBeNull()
  })
})

describe("G9: Google errors on the inbound path", () => {
  async function syncLog(h: Awaited<ReturnType<typeof connected>>["h"], googleCalendarId: string) {
    const cal = await h.calendar(googleCalendarId)
    return h.sql<{ operation: string; error_kind: string; detail: string }>(
      drizzleSql`SELECT operation, error_kind, detail FROM app_calendar.sync_log
                 WHERE org_id = ${orgId}::uuid AND calendar_id = ${cal?.id as string}::uuid
                 ORDER BY created_at`,
    )
  }

  it("a 429, then a 403 rate limit, are retried with backoff and the change lands", async () => {
    const { google, h } = await connected()
    google.updateEvent(TEAM, "teamlunch01", { summary: "Lunch at noon" })
    google.failNext("events.list", "tooManyRequests")
    google.failNext("events.list", "rateLimitExceeded")
    await h.notify(TEAM)
    const ran = await h.drain()

    expect(ran.map((j) => j.delay ?? 0)).toEqual([0, 60_000, 120_000])
    expect((await h.event(TEAM, "teamlunch01"))?.title).toBe("Lunch at noon")
    const log = await syncLog(h, TEAM)
    expect(log.map((l) => [l.operation, l.error_kind])).toEqual([
      ["incremental-sync", "RateLimited"],
      ["incremental-sync", "RateLimited"],
    ])
    expect(log[1]?.detail).toContain("rateLimitExceeded")
  })

  it("a 5xx that never ends stops re-queueing after the 8-minute retry, the poll takes over", async () => {
    const { google, h } = await connected()
    google.failNext("events.list", "backendError", 10)
    await h.notify(TEAM)
    const ran = await h.drain()
    expect(ran.map((j) => j.delay ?? 0)).toEqual([0, 60_000, 120_000, 240_000, 480_000])
    expect((await syncLog(h, TEAM)).map((l) => l.error_kind)).toEqual(Array(5).fill("Unknown"))
  })

  it("a 401 is retried once, then the account is flagged reauth-required", async () => {
    const { google, h } = await connected()
    google.revokeAccess()
    await h.notify(TEAM)
    await h.drain()
    expect((await syncLog(h, TEAM)).map((l) => l.error_kind)).toEqual([
      "Unauthorized",
      "AuthRevoked",
    ])
    const cal = await h.calendar(TEAM)
    const [account] = await h.sql<{ sync_status: string }>(
      drizzleSql`SELECT sync_status FROM app_calendar.accounts WHERE id = ${cal?.account_id as string}::uuid`,
    )
    expect(account?.sync_status).toBe("reauth-required")
  })

  it("a failed initial sync is retried instead of leaving the calendar unsynced", async () => {
    const email = `owner-${crypto.randomUUID().slice(0, 8)}@example.test`
    const google = FakeGoogleCalendar.fromFixtures({ accountEmail: email })
    const h = createCalendarSyncHarness({ orgId, userId, google })
    google.failNext((r) => r.op === "events.list" && r.calendarId === TEAM, "serviceUnavailable")
    await h.connect(email)
    await h.drain()
    expect((await h.calendar(TEAM))?.sync_token).toBeTruthy()
    expect((await h.event(TEAM, "teamlunch01"))?.title).toBe("Team lunch")
    expect((await syncLog(h, TEAM)).map((l) => [l.operation, l.error_kind])).toEqual([
      ["initial-sync", "Unknown"],
    ])
  })
})

describe("G10: a notification during a running sync", () => {
  it("is not lost: the running sync lists again and picks the change up", async () => {
    const { google, h } = await connected()
    google.updateEvent(TEAM, "teamlunch01", { summary: "First change" })
    // Right after Google answered the running sync's list, it commits a second change and
    // notifies: the queue drops that enqueue (same job id, job running).
    let fired = false
    h.afterFetch(async (url) => {
      if (fired || !url.includes(encodeURIComponent(TEAM)) || !url.includes("syncToken=")) return
      fired = true
      google.updateEvent(TEAM, "teamlunch01", { summary: "Second change" })
      await h.notify(TEAM)
    })
    const dedupedBefore = h.deduped.length
    await h.notify(TEAM)
    const ran = await h.drain()
    h.afterFetch(null)

    expect(ran.map((j) => j.name)).toEqual(["calendar-incremental-sync"])
    expect(h.deduped.slice(dedupedBefore).map((j) => j.name)).toEqual(["calendar-incremental-sync"])
    const lists = google
      .requestsFor("events.list")
      .filter((r) => r.calendarId === TEAM && r.query.syncToken)
    expect(lists).toHaveLength(2)
    expect((await h.event(TEAM, "teamlunch01"))?.title).toBe("Second change")
  })

  it("the poll and a notification share one job id per calendar", async () => {
    const { h } = await connected()
    const cal = await h.calendar(TEAM)
    await h.sql(
      drizzleSql`UPDATE app_calendar.calendars SET last_polled_at = NULL WHERE id = ${cal?.id as string}::uuid`,
    )
    await h.runJob("calendar-poll-fallback")
    await h.notify(TEAM)
    const queued = h.queue.filter((j) => j.name === "calendar-incremental-sync")
    expect(queued.map((j) => j.jobId)).toContain(`calendar-incremental:${cal?.id}`)
    expect(h.deduped.some((j) => j.jobId === `calendar-incremental:${cal?.id}`)).toBe(true)
  })

  it("the channel's sync handshake queues nothing", async () => {
    const { google, h } = await connected()
    for (const headers of google.notificationsFor(TEAM, "sync")) await h.webhook(headers)
    expect(h.queue).toEqual([])
  })
})

describe("G4: watch channels", () => {
  async function expireChannel(h: Awaited<ReturnType<typeof connected>>["h"], id: string) {
    await h.sql(
      drizzleSql`UPDATE app_calendar.calendars SET watch_expiration = now() + interval '1 hour'
                 WHERE id = ${id}::uuid`,
    )
  }

  it("a failed renewal keeps the old channel; the next renewal replaces and stops it", async () => {
    const { google, h } = await connected()
    const before = await h.calendar(TEAM)
    const oldChannel = before?.watch_channel_id as string
    await expireChannel(h, before?.id as string)

    google.failNext((r) => r.op === "events.watch" && r.calendarId === TEAM, "backendError")
    await h.runJob("calendar-watch-renewal")
    expect((await h.calendar(TEAM))?.watch_channel_id).toBe(oldChannel)
    expect(google.channels.get(oldChannel)?.stopped).toBe(false)

    await h.runJob("calendar-watch-renewal")
    const after = await h.calendar(TEAM)
    expect(after?.watch_channel_id).not.toBe(oldChannel)
    expect(google.channels.get(after?.watch_channel_id as string)?.stopped).toBe(false)
    expect(google.channels.get(oldChannel)?.stopped).toBe(true)
    // Notifications from the new channel reach the calendar.
    google.updateEvent(TEAM, "teamlunch01", { summary: "After renewal" })
    await h.notify(TEAM)
    await h.drain()
    expect((await h.event(TEAM, "teamlunch01"))?.title).toBe("After renewal")
  })

  it("a calendar whose first registration failed gets a channel at the next renewal", async () => {
    const email = `owner-${crypto.randomUUID().slice(0, 8)}@example.test`
    const google = FakeGoogleCalendar.fromFixtures({ accountEmail: email })
    const h = createCalendarSyncHarness({ orgId, userId, google })
    google.failNext((r) => r.op === "events.watch" && r.calendarId === TEAM, "backendError")
    await h.connect(email)
    await h.drain()
    expect((await h.calendar(TEAM))?.watch_channel_id).toBeNull()
    const log = await h.sql<{ operation: string; error_kind: string }>(
      drizzleSql`SELECT operation, error_kind FROM app_calendar.sync_log
                 WHERE calendar_id = ${(await h.calendar(TEAM))?.id as string}::uuid`,
    )
    expect(log).toEqual([{ operation: "watch", error_kind: "WatchFailed" }])

    await h.runJob("calendar-watch-renewal")
    const channel = (await h.calendar(TEAM))?.watch_channel_id as string
    expect(channel).toBeTruthy()
    expect(google.channels.get(channel)?.stopped).toBe(false)
  })
})
