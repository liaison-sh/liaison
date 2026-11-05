// SPDX-License-Identifier: FSL-1.1-ALv2
// The router's production loader reads the same stored row the settings API
// writes: a cell the user switched off in Settings is the cell the router obeys.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { type RouterItem, resolveChannels } from "./router"

describe("router production loader", () => {
  let me: minimal.Session
  const threadId = crypto.randomUUID()
  // Monday 20:00 UTC: outside the default 09:00-17:00 window.
  const OUTSIDE = new Date("2026-09-28T20:00:00.000Z")

  const patch = (body: unknown) =>
    app.request("/api/notifications/settings", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${me.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  const directMessage: RouterItem = {
    kind: "message",
    app: "kernel",
    threadId,
    isUrgent: false,
    chatMessage: { direct: true },
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    me = await minimal.session(org.id)
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${threadId}, ${me.orgId}, ${`router-load-${threadId.slice(0, 8)}`}, ${me.userId})`
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.user_preferences WHERE user_id = ${me.userId}`
    await sql`DELETE FROM kernel.push_tokens WHERE user_id = ${me.userId}`
    await sql`DELETE FROM kernel.user_thread_state WHERE user_id = ${me.userId}`
    await sql`DELETE FROM kernel.attention_subscriptions WHERE user_id = ${me.userId}`
    await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${me.orgId}, ${me.userId}, 'ios', ${`tok-${crypto.randomUUID()}`})`
  })

  afterAll(async () => {
    if (me) {
      await sql`DELETE FROM kernel.user_preferences WHERE user_id = ${me.userId}`
      await sql`DELETE FROM kernel.push_tokens WHERE user_id = ${me.userId}`
      await sql`DELETE FROM kernel.user_thread_state WHERE user_id = ${me.userId}`
      await sql`DELETE FROM kernel.attention_subscriptions WHERE user_id = ${me.userId}`
      await sql`DELETE FROM kernel.threads WHERE id = ${threadId}`
    }
    await releaseTestLock()
  })

  const decide = (item: RouterItem = directMessage, now = OUTSIDE) =>
    resolveChannels({ userId: me.userId, orgId: me.orgId }, item, { now })

  it("a user with no preferences row gets the defaults and no quiet time on push", async () => {
    const d = await decide()
    expect(d.degraded).toBe(false)
    expect(d.channels.push.deliver).toBe(true)
    expect(d.channels.desktop.deliver).toBe(true)
  })

  it("obeys a grid cell written through the settings API", async () => {
    expect((await patch({ grid: { direct: { push: false } } })).status).toBe(200)
    const d = await decide()
    expect(d.channels.push).toEqual({ deliver: false, reason: "grid_off" })
  })

  it("applies quiet time once work hours are set explicitly", async () => {
    await patch({
      workHours: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5], timezone: "UTC" },
    })
    const d = await decide()
    expect(d.channels.push).toEqual({ deliver: false, reason: "quiet_time" })
  })

  it("reads a muted or archived thread for the replies group", async () => {
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id, is_archived)
      VALUES (${me.userId}, ${threadId}, ${me.orgId}, true)`
    const d = await decide({ ...directMessage, chatMessage: { direct: false } })
    // Rule 7: silenced everywhere, kept quietly in the inbox.
    expect(d.channels.in_app).toEqual({ deliver: true, quiet: true })
    expect(d.channels.push).toEqual({ deliver: false, reason: "thread_muted" })
    // Archived (not muted): a direct message still notifies.
    expect((await decide()).channels.push.deliver).toBe(true)
    // Muted: a direct conversation is silenced too (rule 7).
    await sql`UPDATE kernel.user_thread_state SET is_muted = true WHERE user_id = ${me.userId}`
    expect((await decide()).channels.push).toEqual({ deliver: false, reason: "thread_muted" })
  })

  it("rule 7: reads the kinds set to off through the settings API", async () => {
    expect((await patch({ mutedGroups: { direct: true } })).status).toBe(200)
    const d = await decide(directMessage, new Date("2026-09-28T10:00:00.000Z"))
    expect(d.channels.push).toEqual({ deliver: false, reason: "kind_muted" })
    expect(d.channels.in_app).toEqual({ deliver: true, quiet: true })
  })

  it("rule 8: default quiet hours wait for a known zone: the org's, then the browser-reported one", async () => {
    process.env.NOTIFICATIONS_DEFAULT_QUIET_HOURS = "on"
    try {
      // No known zone (the UTC column defaults): no default quiet hours.
      expect((await decide()).channels.push.deliver).toBe(true)
      // The org's admin chose UTC: now it is a known clock.
      await sql`UPDATE kernel.organizations
                   SET settings = settings || '{"timezoneSet": true}'::jsonb WHERE id = ${me.orgId}`
      expect((await decide()).channels.push).toEqual({ deliver: false, reason: "quiet_time" })
      // 20:00 UTC is 16:00 in New York: inside the default window there.
      await sql`UPDATE kernel.organizations SET timezone = 'America/New_York' WHERE id = ${me.orgId}`
      expect((await decide()).channels.push.deliver).toBe(true)
      // The browser's zone, reported through the settings API, is the person's.
      expect((await patch({ detectedTimezone: "Europe/Paris" })).status).toBe(200)
      expect((await decide()).channels.push).toEqual({ deliver: false, reason: "quiet_time" })
    } finally {
      delete process.env.NOTIFICATIONS_DEFAULT_QUIET_HOURS
      await sql`UPDATE kernel.organizations
                   SET timezone = 'UTC', settings = settings - 'timezoneSet' WHERE id = ${me.orgId}`
    }
  })

  it("rule 9: an incident interrupts the admins by default, else the on-call list", async () => {
    const incident: RouterItem = {
      kind: "monitoring:incident.critical",
      app: "monitoring",
      isUrgent: true,
    }
    const at = new Date("2026-09-28T10:00:00.000Z")
    // A plain member is not an admin: inbox only.
    expect((await decide(incident, at)).channels.push).toEqual({
      deliver: false,
      reason: "not_on_call",
    })
    await sql`UPDATE kernel.organizations
                 SET settings = settings || ${JSON.stringify({ notificationsOnCall: [me.userId] })}::jsonb
               WHERE id = ${me.orgId}`
    try {
      expect((await decide(incident, at)).channels.push.deliver).toBe(true)
      // On call, a critical incident crosses quiet hours.
      await patch({ workHours: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] } })
      expect((await decide(incident)).channels.push.deliver).toBe(true)
    } finally {
      await sql`UPDATE kernel.organizations SET settings = settings - 'notificationsOnCall'
                 WHERE id = ${me.orgId}`
    }
  })

  it("reads the per-app rules of the item's source", async () => {
    await sql`INSERT INTO kernel.attention_subscriptions (user_id, source, kinds, filters, enabled)
      VALUES (${me.userId}, 'tickets', ARRAY['*'], '{}'::jsonb, false)`
    const d = await decide({ kind: "sla_risk", app: "tickets", isUrgent: false })
    expect(d.channels.in_app).toEqual({ deliver: false, reason: "app_rule" })
  })

  it("sees that the user has no push token", async () => {
    await sql`DELETE FROM kernel.push_tokens WHERE user_id = ${me.userId}`
    const d = await decide()
    expect(d.channels.push).toEqual({ deliver: false, reason: "no_device" })
  })

  it("reads an invalid stored timezone as UTC", async () => {
    await patch({ workHours: { start: "09:00", end: "17:00" } })
    await sql`UPDATE kernel.user_preferences SET timezone = 'Not/AZone' WHERE user_id = ${me.userId}`
    const inside = await decide(directMessage, new Date("2026-09-28T10:00:00.000Z"))
    expect(inside.degraded).toBe(false)
    expect(inside.channels.push.deliver).toBe(true)
  })
})
