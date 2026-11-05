// SPDX-License-Identifier: FSL-1.1-ALv2
// S8 (API) and S9: GET/PATCH /api/notifications/settings, self only, targeted
// writes. The router reads the same stored row (router-load.test.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { DEFAULT_GRID } from "@liaison/shared"
import { app } from "~/app"
import { sql } from "~/db"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("notification settings routes", () => {
  let me: minimal.Session
  let other: minimal.Session

  const call = (method: string, bearer: string, body?: unknown) =>
    app.request("/api/notifications/settings", {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const read = async (res: Response) => ((await res.json()) as { data: any }).data

  const stored = async (userId: string) =>
    (
      await sql<Array<{ notification_channels: any; digest_cadence: string; work_days: number[] }>>`
        SELECT notification_channels, digest_cadence, work_days
          FROM kernel.user_preferences WHERE user_id = ${userId}`
    )[0]

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    me = await minimal.session(org.id)
    other = await minimal.session(org.id)
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.user_preferences WHERE user_id IN (${me.userId}, ${other.userId})`
    process.env.NOTIFICATIONS_DEFAULT_QUIET_HOURS = "on"
  })

  afterAll(async () => {
    delete process.env.NOTIFICATIONS_DEFAULT_QUIET_HOURS
    if (me && other) {
      await sql`DELETE FROM kernel.user_preferences WHERE user_id IN (${me.userId}, ${other.userId})`
    }
    await releaseTestLock()
  })

  it("rejects unauthenticated requests", async () => {
    const res = await app.request("/api/notifications/settings")
    expect(res.status).toBe(401)
  })

  it("keeps the bare /api/notifications a 404 (no parallel feed API, unified-surface e2e)", async () => {
    const res = await app.request("/api/notifications", {
      headers: { Authorization: `Bearer ${me.bearer}` },
    })
    expect(res.status).toBe(404)
  })

  it("GET returns the contract shape with the defaults for a user with no row", async () => {
    const res = await call("GET", me.bearer)
    expect(res.status).toBe(200)
    const s = await read(res)
    expect(s.channels).toEqual(["in_app", "desktop", "push", "email"])
    expect(s.groups.map((g: { id: string }) => g.id)).toEqual([
      "direct",
      "replies",
      "approvals",
      "decisions",
      "work",
      "mail",
      "agent",
      "session_needs_you",
      "session_done",
      "session_failed",
      "monitoring",
      "system",
    ])
    expect(s.groups[0].label).toBe("Direct messages and mentions")
    expect(s.groups.find((g: { id: string }) => g.id === "monitoring")).toEqual({
      id: "monitoring",
      label: "Monitoring incidents",
      labelKey: "notifications.groups.monitoring",
    })
    expect(s.grid.monitoring).toEqual({ in_app: true, desktop: true, push: true, email: false })
    // Outside any section: it is a plain row.
    for (const section of s.sections) expect(section.groups).not.toContain("monitoring")
    expect(s.grid).toEqual(DEFAULT_GRID)
    expect(s.defaults).toEqual(DEFAULT_GRID)
    expect(s.digestCadence).toBe("daily")
    // Rule 8: the default quiet window shows until the person sets their own.
    expect(s.workHours).toMatchObject({
      start: "08:00",
      end: "20:00",
      days: [1, 2, 3, 4, 5],
      explicit: false,
    })
    expect(typeof s.workHours.timezone).toBe("string")
    expect((await stored(me.userId)).notification_channels).toBeNull()
  })

  it("approval reminders: daily by default, stored only when changed, the grid kept", async () => {
    expect((await read(await call("GET", me.bearer))).approvalReminder).toBe("daily")
    await call("PATCH", me.bearer, { grid: { work: { push: true } } })
    const res = await call("PATCH", me.bearer, { approvalReminder: "weekly" })
    expect(res.status).toBe(200)
    expect((await read(res)).approvalReminder).toBe("weekly")
    expect((await stored(me.userId)).notification_channels).toEqual({
      grid: { work: { push: true } },
      approvalReminder: "weekly",
    })
    // Back to the default: nothing stored for it.
    await call("PATCH", me.bearer, { approvalReminder: "daily" })
    expect((await stored(me.userId)).notification_channels).toEqual({
      grid: { work: { push: true } },
    })
    // A grid change keeps the reminder setting.
    await call("PATCH", me.bearer, { approvalReminder: "off" })
    await call("PATCH", me.bearer, { grid: { work: { push: false } } })
    expect((await stored(me.userId)).notification_channels).toEqual({ approvalReminder: "off" })
    expect((await call("PATCH", me.bearer, { approvalReminder: "hourly" })).status).toBe(400)
  })

  it("PATCH one cell stores only that cell and answers the merged grid", async () => {
    const res = await call("PATCH", me.bearer, { grid: { work: { push: true } } })
    expect(res.status).toBe(200)
    const s = await read(res)
    expect(s.grid.work.push).toBe(true)
    expect(s.grid.direct).toEqual(DEFAULT_GRID.direct)
    expect((await stored(me.userId)).notification_channels).toEqual({
      grid: { work: { push: true } },
    })
    // Setting it back to the default empties the column.
    await call("PATCH", me.bearer, { grid: { work: { push: false } } })
    expect((await stored(me.userId)).notification_channels).toBeNull()
  })

  it("S11: GET lists the Computer sessions section with its three groups", async () => {
    const s = await read(await call("GET", me.bearer))
    expect(s.sections).toEqual([
      {
        id: "sessions",
        label: "Computer sessions",
        labelKey: "notifications.sections.sessions",
        groups: ["session_needs_you", "session_done", "session_failed"],
      },
    ])
    // PATCH answers the same shape.
    const p = await read(await call("PATCH", me.bearer, { grid: { work: { push: false } } }))
    expect(p.sections).toEqual(s.sections)
  })

  it("S11: PATCH accepts a computer session cell (session_done phone off)", async () => {
    const res = await call("PATCH", me.bearer, { grid: { session_done: { push: false } } })
    expect(res.status).toBe(200)
    const s = await read(res)
    expect(s.grid.session_done).toEqual({ in_app: true, desktop: true, push: false, email: false })
    expect((await stored(me.userId)).notification_channels).toEqual({
      grid: { session_done: { push: false } },
    })
    await call("PATCH", me.bearer, { grid: { session_done: { push: true } } })
    expect((await stored(me.userId)).notification_channels).toBeNull()
  })

  it("rejects an unknown group, an unknown channel and in_app off with 400", async () => {
    expect((await call("PATCH", me.bearer, { grid: { nope: { push: true } } })).status).toBe(400)
    expect((await call("PATCH", me.bearer, { grid: { work: { fax: true } } })).status).toBe(400)
    expect((await call("PATCH", me.bearer, { grid: { work: { in_app: false } } })).status).toBe(400)
    expect((await call("PATCH", me.bearer, { grid: { work: { push: "yes" } } })).status).toBe(400)
    expect((await call("PATCH", me.bearer, { bogus: 1 })).status).toBe(400)
    expect((await call("PATCH", me.bearer, { timezone: "Mars/Olympus" })).status).toBe(400)
    expect((await call("PATCH", me.bearer, { workHours: { days: [7] } })).status).toBe(400)
    expect((await call("PATCH", me.bearer, { workHours: { start: "25:00" } })).status).toBe(400)
  })

  it("saving work hours keeps the grid, and saving the grid keeps work hours", async () => {
    await call("PATCH", me.bearer, { grid: { replies: { push: false } } })
    const afterHours = await read(
      await call("PATCH", me.bearer, {
        workHours: { start: "08:00", end: "18:00", days: [0, 1, 6], timezone: "Europe/Paris" },
      }),
    )
    expect(afterHours.grid.replies.push).toBe(false)
    expect(afterHours.workHours).toEqual({
      start: "08:00",
      end: "18:00",
      days: [0, 1, 6],
      timezone: "Europe/Paris",
      explicit: true,
      timezoneSource: "user",
      quiet: true,
    })
    // Storage keeps ISO weekdays (Sunday = 7).
    expect([...(await stored(me.userId)).work_days].sort()).toEqual([1, 6, 7])

    const afterGrid = await read(
      await call("PATCH", me.bearer, { grid: { replies: { push: true } } }),
    )
    expect(afterGrid.workHours).toEqual(afterHours.workHours)
    expect(afterGrid.grid.replies.push).toBe(true)
  })

  it("workHours.explicit false clears quiet time without losing the hours", async () => {
    await call("PATCH", me.bearer, { workHours: { start: "08:00" } })
    const s = await read(await call("PATCH", me.bearer, { workHours: { explicit: false } }))
    expect(s.workHours.explicit).toBe(false)
    expect(s.workHours.start).toBe("08:00")
  })

  it("cadence off reads as every email cell off, and every email cell off stores cadence off", async () => {
    const off = await read(await call("PATCH", me.bearer, { digestCadence: "off" }))
    for (const g of Object.keys(off.grid)) expect(off.grid[g].email).toBe(false)

    await sql`DELETE FROM kernel.user_preferences WHERE user_id = ${me.userId}`
    const allOff = Object.fromEntries(Object.keys(DEFAULT_GRID).map((g) => [g, { email: false }]))
    const s = await read(await call("PATCH", me.bearer, { grid: allOff }))
    expect(s.digestCadence).toBe("off")
    expect((await stored(me.userId)).digest_cadence).toBe("off")
  })

  it("a phone change while cadence is off leaves the digest off", async () => {
    await call("PATCH", me.bearer, { digestCadence: "off" })
    const s = await read(await call("PATCH", me.bearer, { grid: { direct: { push: false } } }))
    expect(s.digestCadence).toBe("off")
    expect(s.grid.direct.push).toBe(false)
    expect((await stored(me.userId)).digest_cadence).toBe("off")
  })

  it("turning one email cell on while cadence is off sets daily and only that cell", async () => {
    await call("PATCH", me.bearer, { digestCadence: "off" })
    const s = await read(await call("PATCH", me.bearer, { grid: { approvals: { email: true } } }))
    expect(s.digestCadence).toBe("daily")
    for (const g of Object.keys(s.grid)) expect(s.grid[g].email).toBe(g === "approvals")
  })

  it("choosing a cadence again after every email cell was off restores the email defaults", async () => {
    await call("PATCH", me.bearer, { digestCadence: "off" })
    const s = await read(await call("PATCH", me.bearer, { digestCadence: "hourly" }))
    expect(s.digestCadence).toBe("hourly")
    for (const g of Object.keys(s.grid)) {
      expect(s.grid[g].email).toBe(DEFAULT_GRID[g as keyof typeof DEFAULT_GRID].email)
    }
  })

  it("a PATCH never touches another user's row", async () => {
    await call("PATCH", me.bearer, { grid: { work: { push: true } } })
    const theirs = await read(await call("GET", other.bearer))
    expect(theirs.grid.work.push).toBe(false)
  })

  it("keeps the language, theme and home layout the other routes wrote", async () => {
    await call("GET", me.bearer)
    await sql`UPDATE kernel.user_preferences
                 SET language = 'fr', theme = 'dark', home_card_layout = '{"order":["x"],"collapsed":[]}'::jsonb
               WHERE user_id = ${me.userId}`
    await call("PATCH", me.bearer, {
      grid: { work: { push: true } },
      workHours: { start: "07:00" },
      digestCadence: "hourly",
    })
    const rows = await sql<Array<{ language: string; theme: string; home_card_layout: unknown }>>`
      SELECT language, theme, home_card_layout FROM kernel.user_preferences WHERE user_id = ${me.userId}`
    expect(rows[0]).toEqual({
      language: "fr",
      theme: "dark",
      home_card_layout: { order: ["x"], collapsed: [] },
    })
  })

  it("rule 8: with no hours set, GET shows the default quiet window in the org's time zone", async () => {
    await sql`UPDATE kernel.organizations SET timezone = 'Europe/Paris' WHERE id = ${me.orgId}`
    try {
      const s = await read(await call("GET", me.bearer))
      expect(s.workHours).toEqual({
        start: "08:00",
        end: "20:00",
        days: [1, 2, 3, 4, 5],
        timezone: "Europe/Paris",
        explicit: false,
        timezoneSource: "org",
        quiet: true,
      })
      // The person's own zone wins once set.
      const own = await read(await call("PATCH", me.bearer, { timezone: "America/New_York" }))
      expect(own.workHours.timezone).toBe("America/New_York")
      expect(own.workHours.timezoneSource).toBe("user")
      expect(own.workHours.explicit).toBe(false)
    } finally {
      await sql`UPDATE kernel.organizations SET timezone = 'UTC' WHERE id = ${me.orgId}`
    }
  })

  it("rule 8: with no known time zone quiet hours wait; the browser's zone fills it in, never over a chosen one", async () => {
    const s = await read(await call("GET", me.bearer))
    expect(s.workHours.timezoneSource).toBe("unknown")
    expect(s.workHours.quiet).toBe(false)
    // The default window still shows, to be applied once the zone is known.
    expect(s.workHours.start).toBe("08:00")
    const detected = await read(
      await call("PATCH", me.bearer, { detectedTimezone: "Europe/Paris" }),
    )
    expect(detected.workHours).toMatchObject({
      timezone: "Europe/Paris",
      timezoneSource: "user",
      quiet: true,
      explicit: false,
    })
    expect((await stored(me.userId)).notification_channels).toEqual({ timezoneSet: true })
    // A later report from another device does not move a known zone.
    const again = await read(await call("PATCH", me.bearer, { detectedTimezone: "Asia/Tokyo" }))
    expect(again.workHours.timezone).toBe("Europe/Paris")
    expect((await call("PATCH", me.bearer, { detectedTimezone: "Not/AZone" })).status).toBe(400)
  })

  it("rule 8: a time-zone-only work-hours patch keeps the default window (not explicit)", async () => {
    const s = await read(
      await call("PATCH", me.bearer, { workHours: { timezone: "America/New_York" } }),
    )
    expect(s.workHours).toMatchObject({
      start: "08:00",
      end: "20:00",
      timezone: "America/New_York",
      explicit: false,
      timezoneSource: "user",
      quiet: true,
    })
    // Hours make them the person's own.
    const own = await read(await call("PATCH", me.bearer, { workHours: { start: "07:00" } }))
    expect(own.workHours.explicit).toBe(true)
  })

  it("rule 7/10: a kind is set to interrupt, inbox only or off; off is stored as a muted group", async () => {
    const before = await read(await call("GET", me.bearer))
    expect(before.mutedGroups).toEqual([])
    expect(before.kindModes.direct).toBe("interrupt")
    expect(before.kindModes.work).toBe("inbox")
    const res = await call("PATCH", me.bearer, { mutedGroups: { agent: true, work: true } })
    expect(res.status).toBe(200)
    const s = await read(res)
    expect(s.mutedGroups).toEqual(["work", "agent"])
    expect(s.kindModes.agent).toBe("off")
    expect((await stored(me.userId)).notification_channels).toEqual({
      mutedGroups: ["work", "agent"],
    })
    const back = await read(await call("PATCH", me.bearer, { mutedGroups: { agent: false } }))
    expect(back.mutedGroups).toEqual(["work"])
    expect(back.kindModes.agent).toBe("interrupt")
    expect((await call("PATCH", me.bearer, { mutedGroups: { nope: true } })).status).toBe(400)
  })

  it("rule 10: GET /conversations lists muted conversations and channels set to every post", async () => {
    const muted = await minimal.thread(me.orgId, me.userId, { title: "Muted room" })
    const loud = await minimal.thread(me.orgId, me.userId, { title: "Loud room" })
    const state = (threadId: string, body: unknown) =>
      app.request(`/api/threads/${threadId}/state`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${me.bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    expect((await state(muted, { isMuted: true })).status).toBe(200)
    expect((await state(loud, { notifyAllPosts: true })).status).toBe(200)
    const res = await app.request("/api/notifications/conversations", {
      headers: { Authorization: `Bearer ${me.bearer}` },
    })
    expect(res.status).toBe(200)
    const data = await read(res)
    expect(data.muted.map((t: { threadId: string }) => t.threadId)).toEqual([muted])
    expect(data.muted[0].title).toBe("Muted room")
    expect(data.allPosts.map((t: { threadId: string }) => t.threadId)).toEqual([loud])
    // Another person sees none of mine.
    const theirs = await read(
      await app.request("/api/notifications/conversations", {
        headers: { Authorization: `Bearer ${other.bearer}` },
      }),
    )
    expect(theirs).toEqual({ muted: [], allPosts: [] })
  })

  it("rule 9: on call defaults to the admins; only an admin sets the list; empty restores the admins", async () => {
    const admin = await minimal.adminSession(me.orgId)
    const onCall = (bearer: string, method = "GET", body?: unknown) =>
      app.request("/api/notifications/on-call", {
        method,
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    try {
      const def = await read(await onCall(me.bearer))
      expect(def.source).toBe("admins")
      expect(def.onCall.map((u: { id: string }) => u.id)).toContain(admin.userId)
      expect(def.canEdit).toBe(false)
      expect(def.members).toEqual([])
      expect((await onCall(me.bearer, "PUT", { userIds: [me.userId] })).status).toBe(403)
      const set = await onCall(admin.bearer, "PUT", { userIds: [me.userId] })
      expect(set.status).toBe(200)
      const after = await read(set)
      expect(after.source).toBe("list")
      expect(after.onCall.map((u: { id: string }) => u.id)).toEqual([me.userId])
      expect(after.members.length).toBeGreaterThan(1)
      // A stranger's id is refused.
      const stranger = "00000000-0000-4000-8000-000000000001"
      expect((await onCall(admin.bearer, "PUT", { userIds: [stranger] })).status).toBe(400)
      const reset = await read(await onCall(admin.bearer, "PUT", { userIds: [] }))
      expect(reset.source).toBe("admins")
    } finally {
      await sql`UPDATE kernel.organizations SET settings = settings - 'notificationsOnCall'
                 WHERE id = ${me.orgId}`
    }
  })
})
