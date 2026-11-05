// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A4, S6: POST /api/notifications/test reaches EVERY device of the caller
// individually (each iOS token, each desktop app, each Web Push subscription,
// the live tab), whatever the grid and quiet time say, and answers one
// notificationId per device. A11, F8: POST /api/qa/notifications/inject
// exists only with LIAISON_QA_ROUTES=1 and then raises a real item.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import Redis from "ioredis"
import { app } from "~/app"
import { sql } from "~/db"
import { WebSocketManager } from "~/infra/websocket"
import { env } from "~/lib/env"
import { serverT } from "~/modules/i18n/server-i18n"
import { type PushCredentials, sendPush } from "~/modules/push/sender"
import { FakePushTransport } from "~/modules/push/transport-fake"
import type { WebPushSend } from "~/modules/push/web-push"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { TestSendTestAccess } from "./test-send"

const APNS_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgUb0uv3OqGawflNEa
44vN6HM1BtQeigQswWPnFyTwxcOhRANCAARgaihBMqP+jkRZDO9khtNjkb5STk7t
RCt9BYmiMv1q1T/yrylSx0lHCBHES+dGySDgmAV+LhW060oAsKZyvtnX
-----END PRIVATE KEY-----`
const credentials: PushCredentials = {
  apns: { keyId: "ABC1234567", teamId: "TEAM123456", bundleId: "com.liaison.app", key: APNS_P8 },
}

interface FakeWs {
  send(data: string): void
  close(): void
  readyState: number
  frames: Array<Record<string, unknown>>
}

function fakeWs(): FakeWs {
  const ws: FakeWs = {
    frames: [],
    readyState: 1,
    send(data: string) {
      ws.frames.push(JSON.parse(data))
    },
    close() {},
  }
  return ws
}

const redisClients: Redis[] = []
function redis(): Redis {
  const r = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  redisClients.push(r)
  return r
}

describe("test notification route (A4) and QA inject route (A11)", () => {
  let me: minimal.Session
  let admin: minimal.Session
  let other: minimal.Session

  const call = (path: string, method: string, bearer: string | null, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const data = async (res: Response) => ((await res.json()) as { data: any }).data

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    me = await minimal.session(org.id)
    admin = await minimal.session(org.id, { role: "admin" })
    other = await minimal.session(org.id)
  })

  const cleanup = async () => {
    for (const s of [me, admin, other]) {
      if (!s) continue
      await sql`DELETE FROM kernel.notification_receipts WHERE user_id = ${s.userId}`
      await sql`DELETE FROM kernel.notification_deliveries WHERE user_id = ${s.userId}`
      await sql`DELETE FROM kernel.notification_device_credentials WHERE user_id = ${s.userId}`
      await sql`DELETE FROM kernel.desktop_devices WHERE user_id = ${s.userId}`
      await sql`DELETE FROM kernel.browser_push_subscriptions WHERE user_id = ${s.userId}`
      await sql`DELETE FROM kernel.push_tokens WHERE user_id = ${s.userId}`
      await sql`DELETE FROM kernel.user_preferences WHERE user_id = ${s.userId}`
      await sql`DELETE FROM kernel.attention_events WHERE user_id = ${s.userId}`
    }
  }

  beforeEach(cleanup)

  afterEach(() => {
    TestSendTestAccess.reset()
    ;(env as { LIAISON_QA_ROUTES: boolean }).LIAISON_QA_ROUTES = false
  })

  afterAll(async () => {
    for (const r of redisClients) r.disconnect()
    await cleanup()
    await releaseTestLock()
  })

  it("reaches all 3 surfaces individually, ignoring an all-off grid and quiet time", async () => {
    // Every system cell off, explicit work hours that are never now.
    const off = { in_app: true, desktop: false, push: false, email: false }
    await sql`INSERT INTO kernel.user_preferences
      (user_id, work_hours_start, work_hours_end, work_days, notification_channels)
      VALUES (${me.userId}, '03:00', '03:01', '{}'::smallint[],
              ${JSON.stringify({ grid: { system: off }, workHoursExplicit: true })}::jsonb)`

    const tokenRes = await call("/api/push/tokens", "POST", me.bearer, {
      platform: "ios",
      token: "test-route-token",
      environment: "sandbox",
    })
    const iosId = (await data(tokenRes)).id as string
    const deskRes = await call("/api/notifications/desktop-devices", "POST", me.bearer, {
      deviceId: "test-desk",
      notificationPermission: "denied",
    })
    const deskCredential = (await data(deskRes)).receiptCredential as string
    await call("/api/notifications/browser-subscriptions", "POST", me.bearer, {
      deviceId: "test-web",
      subscription: { endpoint: "https://push.example/test-web", keys: { p256dh: "k", auth: "a" } },
    })

    const m = new WebSocketManager(redis(), undefined, { instanceId: `ts-${crypto.randomUUID()}` })
    await redis().del(`ws:notify-presence:${me.orgId}:${me.userId}`)
    const desk = fakeWs()
    m.addConnection(me.userId, desk, ["*"], me.orgId)
    await m.registerNotifyClient(desk, "desktop_app", Date.now(), {
      deviceId: "test-desk",
      notificationPermission: "denied",
    })
    const tab = fakeWs()
    m.addConnection(me.userId, tab, ["*"], me.orgId)
    await m.registerNotifyClient(tab, "browser", Date.now(), { deviceId: "test-web" })

    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    const webPushCalls: string[] = []
    const webPush: WebPushSend = async (_target, body) => {
      webPushCalls.push(JSON.parse(body).notificationId)
      return { status: 201 }
    }
    TestSendTestAccess.setDeps({
      manager: m,
      sendPush: (t, p) => sendPush(t, p, { transport, credentials }),
      webPush,
    })

    const res = await call("/api/notifications/test", "POST", me.bearer, {})
    expect(res.status).toBe(200)
    const out = (await data(res)) as {
      devices: Array<{ deviceId: string; surface: string; notificationId: string; result: string }>
    }
    const bySurface = Object.fromEntries(out.devices.map((d) => [d.surface, d]))
    expect(Object.keys(bySurface).sort()).toEqual(["browser_push", "browser_tab", "desktop", "ios"])
    expect(bySurface.ios).toMatchObject({ deviceId: iosId, result: "accepted" })
    expect(bySurface.desktop).toMatchObject({ deviceId: "test-desk", result: "accepted" })
    expect(bySurface.browser_push).toMatchObject({ deviceId: "test-web", result: "accepted" })
    expect(bySurface.browser_tab).toMatchObject({ deviceId: "test-web", result: "accepted" })
    // One notificationId per device, each on its own wire.
    expect(new Set(out.devices.map((d) => d.notificationId)).size).toBe(4)
    expect(JSON.parse(transport.requests[0].body).notificationId).toBe(bySurface.ios.notificationId)
    expect(desk.frames.filter((f) => f.type === "notify").map((f) => f.notificationId)).toEqual([
      bySurface.desktop.notificationId,
    ])
    expect(tab.frames.filter((f) => f.type === "notify").map((f) => f.notificationId)).toEqual([
      bySurface.browser_tab.notificationId,
    ])
    expect(webPushCalls).toEqual([bySurface.browser_push.notificationId])

    // The device can receipt it: the delivery row exists for (notification, device).
    const receipt = await call("/api/notifications/receipts", "POST", deskCredential, {
      notificationId: bySurface.desktop.notificationId,
      deviceId: "test-desk",
      surface: "desktop",
      outcome: "shown",
    })
    expect(receipt.status).toBe(200)
  })

  // Regression smoke 0759b0f89 (2026-10-08): the iPhone's receipt reached the
  // server while the test was still sending to the other devices, before any
  // delivery row existed (they were written after the last device), got 404 and
  // the phone read "No confirmation within 30 seconds" although it showed it.
  it("each device's delivery row exists as soon as its send returns, before the next device is sent to", async () => {
    await call("/api/push/tokens", "POST", me.bearer, {
      platform: "ios",
      token: "test-route-token-early",
      environment: "sandbox",
    })
    await call("/api/notifications/browser-subscriptions", "POST", me.bearer, {
      deviceId: "test-web-early",
      subscription: { endpoint: "https://push.example/early", keys: { p256dh: "k", auth: "a" } },
    })
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    let iosRowsWhenWebPushSent = -1
    TestSendTestAccess.setDeps({
      manager: null,
      sendPush: (t, p) => sendPush(t, p, { transport, credentials }),
      webPush: async () => {
        const rows = await sql`SELECT id FROM kernel.notification_deliveries
          WHERE user_id = ${me.userId} AND surface = 'ios' AND channel = 'test'`
        iosRowsWhenWebPushSent = rows.length
        return { status: 201 }
      },
    })
    const res = await call("/api/notifications/test", "POST", me.bearer, {})
    expect(res.status).toBe(200)
    expect(iosRowsWhenWebPushSent).toBe(1)
  })

  it("a registered device that is not reachable still gets its own line", async () => {
    await call("/api/notifications/desktop-devices", "POST", me.bearer, { deviceId: "asleep" })
    const m = new WebSocketManager(redis(), undefined, { instanceId: `ts-${crypto.randomUUID()}` })
    await redis().del(`ws:notify-presence:${me.orgId}:${me.userId}`)
    TestSendTestAccess.setDeps({ manager: m })
    const res = await call("/api/notifications/test", "POST", me.bearer, {})
    const out = await data(res)
    expect(out.devices).toEqual([
      expect.objectContaining({ deviceId: "asleep", surface: "desktop", result: "no_connection" }),
    ])
  })

  it("T4: web-push config answers the VAPID public key to a session, null without one", async () => {
    const saved = env.VAPID_PUBLIC_KEY
    try {
      ;(env as { VAPID_PUBLIC_KEY?: string }).VAPID_PUBLIC_KEY = "BPublicKeyForTheBrowser"
      const res = await call("/api/notifications/web-push/config", "GET", me.bearer)
      expect(res.status).toBe(200)
      expect(await data(res)).toEqual({ publicKey: "BPublicKeyForTheBrowser" })
      ;(env as { VAPID_PUBLIC_KEY?: string }).VAPID_PUBLIC_KEY = undefined
      expect(
        await data(await call("/api/notifications/web-push/config", "GET", me.bearer)),
      ).toEqual({ publicKey: null })
      expect((await call("/api/notifications/web-push/config", "GET", null)).status).toBe(401)
    } finally {
      ;(env as { VAPID_PUBLIC_KEY?: string }).VAPID_PUBLIC_KEY = saved
    }
  })

  it("T7w: receipt-status answers the caller's own receipts for the asked ids", async () => {
    const reg = await call("/api/notifications/browser-subscriptions", "POST", me.bearer, {
      deviceId: "status-web",
      subscription: { endpoint: "https://push.example/status", keys: { p256dh: "k", auth: "a" } },
    })
    const credential = (await data(reg)).receiptCredential as string
    TestSendTestAccess.setDeps({ manager: null, webPush: async () => ({ status: 201 }) })
    const sent = await data(await call("/api/notifications/test", "POST", me.bearer, {}))
    const line = (sent.devices as Array<{ surface: string; notificationId: string }>).find(
      (d) => d.surface === "browser_push",
    )!
    const other = crypto.randomUUID()
    const status = (bearer: string) =>
      call(`/api/notifications/receipt-status?ids=${line.notificationId},${other}`, "GET", bearer)

    // Nothing receipted yet.
    expect(await data(await status(me.bearer))).toEqual([])
    const posted = await call("/api/notifications/receipts", "POST", credential, {
      notificationId: line.notificationId,
      outcome: "suppressed",
      reason: "on_screen",
    })
    expect(posted.status).toBe(200)

    const mine = await data(await status(me.bearer))
    expect(mine).toEqual([
      expect.objectContaining({
        notificationId: line.notificationId,
        deviceId: "status-web",
        outcome: "suppressed",
        reason: "on_screen",
      }),
    ])
    // An admin reads the org's rows under RLS, but this route answers the caller's own.
    expect(await data(await status(admin.bearer))).toEqual([])
    expect(
      (await call("/api/notifications/receipt-status?ids=nope", "GET", me.bearer)).status,
    ).toBe(400)
  })

  it("T7w: the test banner copy comes from the shared catalog, in the user's language", async () => {
    await sql`INSERT INTO kernel.user_preferences (user_id, language) VALUES (${me.userId}, 'fr')`
    await call("/api/notifications/browser-subscriptions", "POST", me.bearer, {
      deviceId: "copy-web",
      subscription: { endpoint: "https://push.example/copy", keys: { p256dh: "k", auth: "a" } },
    })
    const bodies: Array<{ title: string; body: string }> = []
    TestSendTestAccess.setDeps({
      manager: null,
      webPush: async (_t, body) => {
        bodies.push(JSON.parse(body))
        return { status: 201 }
      },
    })
    await call("/api/notifications/test", "POST", me.bearer, {})
    expect(serverT("fr", "kernel.notifications.test.body")).toBe(
      "Ceci est une notification de test.",
    )
    expect(serverT("en", "kernel.notifications.test.body")).toBe("This is a test notification.")
    expect(bodies).toEqual([
      expect.objectContaining({
        title: serverT("fr", "kernel.notifications.test.title"),
        body: "Ceci est une notification de test.",
      }),
    ])
  })

  it("the QA inject route is absent without LIAISON_QA_ROUTES", async () => {
    const res = await call("/api/qa/notifications/inject", "POST", admin.bearer, {
      userId: me.userId,
      kind: "new_email",
    })
    expect(res.status).toBe(404)
  })

  it("with LIAISON_QA_ROUTES it raises a real new_email item and a real work item", async () => {
    ;(env as { LIAISON_QA_ROUTES: boolean }).LIAISON_QA_ROUTES = true
    TestSendTestAccess.setDeps({ manager: null })
    const mail = await call("/api/qa/notifications/inject", "POST", admin.bearer, {
      userId: me.userId,
      kind: "new_email",
    })
    expect(mail.status).toBe(200)
    const m1 = await data(mail)
    expect(m1.notificationId).toMatch(/^[0-9a-f-]{36}$/)
    const work = await call("/api/qa/notifications/inject", "POST", admin.bearer, {
      userId: me.userId,
      kind: "sla_risk",
      summary: "QA: SLA at risk",
    })
    expect(work.status).toBe(200)
    const rows = await sql<Array<{ kind: string; app: string }>>`
      SELECT kind, app FROM kernel.attention_events WHERE user_id = ${me.userId} ORDER BY kind`
    expect(rows.map((r) => [r.app, r.kind])).toEqual(
      [
        ["mail", "new_email"],
        ["kernel", "sla_risk"],
      ].sort((a, b) => a[1].localeCompare(b[1])),
    )
    // The item went through the router: its computer row is in the log.
    const logged = await sql<Array<{ channel: string }>>`
      SELECT channel FROM kernel.notification_deliveries
       WHERE notification_id = ${m1.notificationId}`
    expect(logged.length).toBeGreaterThan(0)

    // A chat kind is refused, and so is another org's user for a non-admin.
    const chat = await call("/api/qa/notifications/inject", "POST", admin.bearer, {
      userId: me.userId,
      kind: "mention",
    })
    expect(chat.status).toBe(400)
    const notMine = await call("/api/qa/notifications/inject", "POST", me.bearer, {
      userId: admin.userId,
      kind: "sla_risk",
    })
    expect(notMine.status).toBe(403)
  })

  it("T11: the QA log route is absent without LIAISON_QA_ROUTES", async () => {
    const since = new Date(Date.now() - 60_000).toISOString()
    const res = await call(`/api/qa/notifications/log?since=${since}`, "GET", me.bearer)
    expect(res.status).toBe(404)
  })

  it("T11: the QA log answers the caller's own delivery rows and receipts since a time", async () => {
    ;(env as { LIAISON_QA_ROUTES: boolean }).LIAISON_QA_ROUTES = true
    const reg = await call("/api/notifications/browser-subscriptions", "POST", me.bearer, {
      deviceId: "log-web",
      subscription: { endpoint: "https://push.example/log", keys: { p256dh: "k", auth: "a" } },
    })
    const credential = (await data(reg)).receiptCredential as string
    TestSendTestAccess.setDeps({ manager: null, webPush: async () => ({ status: 201 }) })
    const before = new Date(Date.now() - 1000).toISOString()
    const sent = await data(await call("/api/notifications/test", "POST", me.bearer, {}))
    const line = (sent.devices as Array<{ surface: string; notificationId: string }>).find(
      (d) => d.surface === "browser_push",
    )!
    await call("/api/notifications/receipts", "POST", credential, {
      notificationId: line.notificationId,
      outcome: "shown",
      appState: "background",
    })
    // The admin's own item, which the caller must not see.
    await call("/api/notifications/test", "POST", admin.bearer, {})

    const res = await call(`/api/qa/notifications/log?since=${before}`, "GET", me.bearer)
    expect(res.status).toBe(200)
    const log = await data(res)
    expect(log.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          notificationId: line.notificationId,
          deviceId: "log-web",
          surface: "browser_push",
          result: "accepted",
        }),
      ]),
    )
    expect(log.receipts).toEqual([
      expect.objectContaining({
        notificationId: line.notificationId,
        deviceId: "log-web",
        surface: "browser_push",
        outcome: "shown",
        appState: "background",
      }),
    ])
    // Only the caller's rows: the admin's test notification is not in it.
    const ids = new Set(
      (log.deliveries as Array<{ notificationId: string }>).map((d) => d.notificationId),
    )
    expect(ids).toEqual(new Set([line.notificationId]))

    // Nothing after a later time; a bad time is a 400.
    const later = new Date(Date.now() + 60_000).toISOString()
    const empty = await data(
      await call(`/api/qa/notifications/log?since=${later}`, "GET", me.bearer),
    )
    expect(empty).toEqual({ deliveries: [], receipts: [] })
    expect((await call("/api/qa/notifications/log?since=yesterday", "GET", me.bearer)).status).toBe(
      400,
    )
  })

  it("T11: the QA log hides other users' devices, deliveries and receipts, even from an admin", async () => {
    ;(env as { LIAISON_QA_ROUTES: boolean }).LIAISON_QA_ROUTES = true
    TestSendTestAccess.setDeps({ manager: null, webPush: async () => ({ status: 201 }) })
    const before = new Date(Date.now() - 1000).toISOString()
    // Every user, the caller included, owns a device, a delivery row and a receipt.
    const sendAndReceipt = async (s: minimal.Session, deviceId: string) => {
      const reg = await call("/api/notifications/browser-subscriptions", "POST", s.bearer, {
        deviceId,
        subscription: {
          endpoint: `https://push.example/${deviceId}`,
          keys: { p256dh: "k", auth: "a" },
        },
      })
      const credential = (await data(reg)).receiptCredential as string
      const sent = await data(await call("/api/notifications/test", "POST", s.bearer, {}))
      const line = (sent.devices as Array<{ surface: string; notificationId: string }>).find(
        (d) => d.surface === "browser_push",
      )!
      const posted = await call("/api/notifications/receipts", "POST", credential, {
        notificationId: line.notificationId,
        outcome: "shown",
      })
      expect(posted.status).toBe(200)
      return line.notificationId
    }
    const mine = await sendAndReceipt(me, "iso-me")
    const others = await sendAndReceipt(other, "iso-other")
    const admins = await sendAndReceipt(admin, "iso-admin")
    // The rows exist (an unfiltered read would see all three users).
    const stored = await sql<Array<{ user_id: string }>>`
      SELECT DISTINCT user_id FROM kernel.notification_receipts
       WHERE notification_id IN (${mine}, ${others}, ${admins})`
    expect(stored).toHaveLength(3)

    const logOf = async (s: minimal.Session) => {
      const res = await call(`/api/qa/notifications/log?since=${before}`, "GET", s.bearer)
      expect(res.status).toBe(200)
      const log = (await data(res)) as {
        deliveries: Array<{ notificationId: string; deviceId: string | null }>
        receipts: Array<{ notificationId: string; deviceId: string }>
      }
      return {
        deliveries: new Set(log.deliveries.map((d) => d.notificationId)),
        receipts: log.receipts.map((r) => [r.notificationId, r.deviceId]),
      }
    }
    expect(await logOf(me)).toEqual({ deliveries: new Set([mine]), receipts: [[mine, "iso-me"]] })
    expect(await logOf(other)).toEqual({
      deliveries: new Set([others]),
      receipts: [[others, "iso-other"]],
    })
    // An admin reads the org's rows under RLS; the route still answers only their own.
    expect(await logOf(admin)).toEqual({
      deliveries: new Set([admins]),
      receipts: [[admins, "iso-admin"]],
    })
  })

  it("T11: the QA inject route routes an urgent item; quiet time holds it (rule 8: only on-call incidents cross)", async () => {
    ;(env as { LIAISON_QA_ROUTES: boolean }).LIAISON_QA_ROUTES = true
    TestSendTestAccess.setDeps({ manager: null })
    await sql`INSERT INTO kernel.user_preferences
      (user_id, work_hours_start, work_hours_end, work_days, notification_channels)
      VALUES (${me.userId}, '03:00', '03:01', '{}'::smallint[],
              ${JSON.stringify({
                grid: { system: { in_app: true, desktop: true, push: true, email: false } },
                workHoursExplicit: true,
              })}::jsonb)`
    const quiet = await data(
      await call("/api/qa/notifications/inject", "POST", me.bearer, {
        userId: me.userId,
        kind: "system_alert",
      }),
    )
    const urgent = await data(
      await call("/api/qa/notifications/inject", "POST", me.bearer, {
        userId: me.userId,
        kind: "system_alert",
        urgent: true,
      }),
    )
    const reasons = async (id: string) =>
      (
        await sql<Array<{ channel: string; reason: string | null }>>`
          SELECT channel, reason FROM kernel.notification_deliveries
           WHERE notification_id = ${id} AND device_id IS NULL ORDER BY channel`
      ).map((r) => [r.channel, r.reason])
    expect(await reasons(quiet.notificationId)).toEqual([
      ["desktop", "quiet_time"],
      ["push", "quiet_time"],
    ])
    expect(await reasons(urgent.notificationId)).toContainEqual(["push", "quiet_time"])
    expect(await reasons(urgent.notificationId)).toContainEqual(["desktop", "quiet_time"])
  })
})
