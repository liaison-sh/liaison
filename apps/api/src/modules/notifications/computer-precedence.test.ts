// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S4/S5 server side, A5, A6: the computer channel. Order: a live desktop app
// whose reported OS permission is `granted`, else the live browser tab, else
// Web Push. A desktop delivery with no desktop receipt within 10 s falls
// through to the next rule; a desktop that reconnects gets the unreceipted,
// unsuppressed items of the last 15 minutes, once. Real Redis presence and
// real rows; the Web Push wire and the delayed-job queue are doubles.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { effectiveGrid } from "@liaison/shared"
import Redis from "ioredis"
import { sql } from "~/db"
import { type NotifyClientKind, WebSocketManager } from "~/infra/websocket"
import { env } from "~/lib/env"
import { type WebPushSend, webPushUserTag } from "~/modules/push/web-push"
import {
  type DesktopFallbackJob,
  emitDesktopNotify,
  replayMissedDesktopNotifications,
  runDesktopFallback,
} from "./desktop-emitter"
import { notificationIdFor, type RecipientContext, resolveChannels } from "./router"

const ORG = "00000000-0000-0000-0000-00000000c0d0"
const USER = "00000000-0000-0000-0000-00000000c0d1"

const redisClients: Redis[] = []
function redis(): Redis {
  const r = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  redisClients.push(r)
  return r
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

const notifies = (ws: FakeWs) => ws.frames.filter((f) => f.type === "notify")

let m: WebSocketManager

async function connect(
  kind: NotifyClientKind,
  deviceId: string,
  notificationPermission?: string,
  lastActiveAt = Date.now(),
): Promise<FakeWs> {
  const ws = fakeWs()
  m.addConnection(USER, ws, ["*"], ORG)
  await m.registerNotifyClient(ws, kind, lastActiveAt, { deviceId, notificationPermission })
  return ws
}

function routerCtx(): RecipientContext {
  return {
    grid: effectiveGrid(null),
    digestCadence: "daily",
    workHours: {
      workHoursStart: "09:00",
      workHoursEnd: "17:00",
      workDays: [1, 2, 3, 4, 5],
      timezone: "UTC",
    },
    workHoursExplicit: false,
    appRules: [],
    threadMuted: false,
    hasPushDevice: false,
  }
}

const decision = () =>
  resolveChannels(
    { userId: USER, orgId: ORG },
    { kind: "approval_pending", app: "kernel", isUrgent: false },
    { loadContext: async () => routerCtx() },
  )

function item(title = "Approval") {
  return {
    notifyId: `attention:${crypto.randomUUID()}`,
    title,
    body: "Refund 42",
    route: "thread/t",
  }
}

function webPushSpy(status = 201) {
  const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = []
  const send: WebPushSend = async (sub, body) => {
    calls.push({ endpoint: sub.endpoint, body: JSON.parse(body) })
    return { status }
  }
  return { calls, send }
}

function fallbackSpy() {
  const jobs: Array<{ job: DesktopFallbackJob; delayMs: number }> = []
  return {
    jobs,
    schedule: async (job: DesktopFallbackJob, delayMs: number) => {
      jobs.push({ job, delayMs })
    },
  }
}

async function subscribe(deviceId: string): Promise<void> {
  await sql`INSERT INTO kernel.browser_push_subscriptions
    (org_id, user_id, device_id, endpoint, p256dh, auth)
    VALUES (${ORG}, ${USER}, ${deviceId}, ${`https://push.example/${deviceId}`},
            'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
            'tBHItJI5svbpez7KI4CCXg')`
}

const rows = async (nid: string) => [
  ...(await sql<
    Array<{
      surface: string | null
      device_id: string | null
      result: string
      reason: string | null
    }>
  >`
    SELECT surface, device_id, result, reason FROM kernel.notification_deliveries
     WHERE notification_id = ${nid} ORDER BY attempted_at`),
]

describe("computer channel precedence (A6), fallback and replay (A5)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'PrecedenceOrg', 'precedence-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER}, ${ORG}, 'precedence@t.com', 'Pat', 'x') ON CONFLICT (id) DO NOTHING`
  })

  beforeEach(async () => {
    m = new WebSocketManager(redis(), undefined, { instanceId: `prec-${crypto.randomUUID()}` })
    await redis().del(`ws:notify-presence:${ORG}:${USER}`)
    await sql`DELETE FROM kernel.notification_receipts WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.notification_deliveries WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.browser_push_subscriptions WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    for (const r of redisClients) r.disconnect()
    await sql`DELETE FROM kernel.notification_receipts WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.notification_deliveries WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.browser_push_subscriptions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("desktop granted + tab + subscription: desktop only, and a 10 s fallback check is armed", async () => {
    const desk = await connect("desktop_app", "desk-1", "granted")
    const tab = await connect("browser", "web-1")
    await subscribe("web-1")
    const wp = webPushSpy()
    const fb = fallbackSpy()
    const it1 = item()
    await emitDesktopNotify(await decision(), it1, {
      manager: m,
      webPush: wp.send,
      scheduleFallback: fb.schedule,
    })
    expect(notifies(desk)).toHaveLength(1)
    expect(notifies(tab)).toHaveLength(0)
    expect(wp.calls).toHaveLength(0)
    expect(fb.jobs).toHaveLength(1)
    expect(fb.jobs[0].delayMs).toBe(10_000)
    expect(fb.jobs[0].job.notificationId).toBe(notificationIdFor(USER, it1.notifyId))
  })

  it("desktop denied or not_determined: the tab gets it", async () => {
    for (const permission of ["denied", "not_determined", undefined]) {
      await redis().del(`ws:notify-presence:${ORG}:${USER}`)
      m = new WebSocketManager(redis(), undefined, { instanceId: `prec-${crypto.randomUUID()}` })
      const desk = await connect("desktop_app", "desk-1", permission)
      const tab = await connect("browser", "web-1")
      await subscribe(`web-${crypto.randomUUID()}`)
      const wp = webPushSpy()
      const fb = fallbackSpy()
      await emitDesktopNotify(await decision(), item(), {
        manager: m,
        webPush: wp.send,
        scheduleFallback: fb.schedule,
      })
      expect(notifies(desk)).toHaveLength(0)
      expect(notifies(tab)).toHaveLength(1)
      expect(wp.calls).toHaveLength(0)
      expect(fb.jobs).toHaveLength(0)
    }
  })

  it("a permission change reported on the heartbeat moves the choice", async () => {
    const desk = await connect("desktop_app", "desk-1", "denied")
    const tab = await connect("browser", "web-1")
    await m.touchNotifyPresence(desk, Date.now(), { notificationPermission: "granted" })
    await emitDesktopNotify(await decision(), item(), {
      manager: m,
      webPush: webPushSpy().send,
      scheduleFallback: fallbackSpy().schedule,
    })
    expect(notifies(desk)).toHaveLength(1)
    expect(notifies(tab)).toHaveLength(0)
  })

  it("no desktop, no tab: Web Push to the subscription, carrying the notificationId", async () => {
    await subscribe("web-9")
    const wp = webPushSpy()
    const it1 = item("Hello")
    await emitDesktopNotify(await decision(), it1, {
      manager: m,
      webPush: wp.send,
      scheduleFallback: fallbackSpy().schedule,
    })
    const nid = notificationIdFor(USER, it1.notifyId)
    expect(wp.calls).toHaveLength(1)
    expect(wp.calls[0].endpoint).toBe("https://push.example/web-9")
    expect(wp.calls[0].body).toMatchObject({
      notificationId: nid,
      title: "Hello",
      route: "thread/t",
    })
    // fix2-F1: a user-scoped marker the service worker checks, never the raw id.
    expect(wp.calls[0].body.userTag).toBe(webPushUserTag(USER))
    expect(JSON.stringify(wp.calls[0].body)).not.toContain(USER)
    expect(await rows(nid)).toEqual([
      { surface: "browser_push", device_id: "web-9", result: "accepted", reason: null },
    ])
  })

  it("desktop with no receipt after 10 s: the fallback goes to Web Push; a desktop receipt stops it", async () => {
    await connect("desktop_app", "desk-1", "granted")
    await subscribe("web-2")
    const fb = fallbackSpy()
    const unreceipted = item("first")
    const receipted = item("second")
    for (const i of [unreceipted, receipted]) {
      await emitDesktopNotify(await decision(), i, {
        manager: m,
        webPush: webPushSpy().send,
        scheduleFallback: fb.schedule,
      })
    }
    expect(fb.jobs).toHaveLength(2)
    const receiptedId = notificationIdFor(USER, receipted.notifyId)
    await sql`INSERT INTO kernel.notification_receipts
      (org_id, user_id, notification_id, device_id, surface, outcome)
      VALUES (${ORG}, ${USER}, ${receiptedId}, 'desk-1', 'desktop', 'shown')`
    // The killed app is still in presence (its TTL has not run out).
    const wp = webPushSpy()
    for (const { job } of fb.jobs) {
      await runDesktopFallback(job, { manager: m, webPush: wp.send })
    }
    expect(wp.calls.map((c) => c.body.notificationId)).toEqual([
      notificationIdFor(USER, unreceipted.notifyId),
    ])
    // Run again (a job retry): nothing is sent twice.
    await runDesktopFallback(fb.jobs[0].job, { manager: m, webPush: wp.send })
    expect(wp.calls).toHaveLength(1)
  })

  it("the fallback prefers a live tab over Web Push", async () => {
    await connect("desktop_app", "desk-1", "granted")
    const fb = fallbackSpy()
    await emitDesktopNotify(await decision(), item(), {
      manager: m,
      webPush: webPushSpy().send,
      scheduleFallback: fb.schedule,
    })
    const tab = await connect("browser", "web-3")
    await subscribe("web-3")
    const wp = webPushSpy()
    await runDesktopFallback(fb.jobs[0].job, { manager: m, webPush: wp.send })
    expect(notifies(tab)).toHaveLength(1)
    expect(wp.calls).toHaveLength(0)
  })

  it("a 410 from the push service deletes the subscription and logs rejected/expired", async () => {
    await subscribe("web-gone")
    const it1 = item()
    await emitDesktopNotify(await decision(), it1, {
      manager: m,
      webPush: webPushSpy(410).send,
      scheduleFallback: fallbackSpy().schedule,
    })
    const left = await sql<Array<{ endpoint: string | null }>>`
      SELECT endpoint FROM kernel.browser_push_subscriptions WHERE org_id = ${ORG} AND device_id = 'web-gone'`
    expect(left.map((r) => r.endpoint)).toEqual([null])
    expect(await rows(notificationIdFor(USER, it1.notifyId))).toEqual([
      { surface: "browser_push", device_id: "web-gone", result: "rejected", reason: "expired" },
    ])
  })

  it("reconnect replays exactly the unreceipted, unsuppressed computer items of 15 min, once", async () => {
    const frame = (n: string) => ({
      type: "notify",
      notifyId: `attention:${n}`,
      notificationId: n,
      group: "approvals",
      title: `item ${n}`,
      body: "b",
      route: "thread/t",
      urgent: false,
    })
    const missed = crypto.randomUUID() // nothing was live: no_target
    const missedPushed = crypto.randomUUID() // Web Push accepted, never receipted
    const seen = crypto.randomUUID() // the tab receipted it
    const suppressed = crypto.randomUUID() // router-suppressed
    const old = crypto.randomUUID() // 20 min ago
    const phoneOnly = crypto.randomUUID() // push channel only
    const heldOnPhone = crypto.randomUUID() // missed on the computer, held back on push only
    const insert = (
      n: string,
      channel: string,
      result: string,
      surface: string | null,
      deviceId: string | null,
      ago = "1 minute",
    ) => sql`INSERT INTO kernel.notification_deliveries
      (org_id, user_id, notification_id, device_id, surface, channel, result, payload, attempted_at)
      VALUES (${ORG}, ${USER}, ${n}, ${deviceId}, ${surface}, ${channel}, ${result},
              ${JSON.stringify(frame(n))}::jsonb, now() - ${ago}::interval)`
    await insert(missed, "desktop", "no_target", null, null)
    await insert(missedPushed, "desktop", "accepted", "browser_push", "web-1")
    await insert(seen, "desktop", "accepted", "browser_tab", "web-1")
    await sql`INSERT INTO kernel.notification_receipts
      (org_id, user_id, notification_id, device_id, surface, outcome)
      VALUES (${ORG}, ${USER}, ${seen}, 'web-1', 'browser_tab', 'shown')`
    await insert(suppressed, "desktop", "suppressed", null, null)
    await insert(old, "desktop", "no_target", null, null, "20 minutes")
    await insert(phoneOnly, "push", "accepted", "ios", "tok-1")
    // A push-channel suppression (here the phone side held back) must not stop
    // the computer-channel replay of the same item.
    await insert(heldOnPhone, "desktop", "no_target", null, null)
    await insert(heldOnPhone, "push", "suppressed", null, null)

    const desk = await connect("desktop_app", "desk-r", "granted")
    const entry = (await m.listNotifyPresence(ORG, USER)).find((e) => e.deviceId === "desk-r")
    if (!entry) throw new Error("no presence entry")
    await replayMissedDesktopNotifications(m, entry, ORG, USER)
    await replayMissedDesktopNotifications(m, entry, ORG, USER)
    const got = notifies(desk).map((f) => f.notificationId)
    expect([...got].sort()).toEqual([missed, missedPushed, heldOnPhone].sort())
  })

  it("reconnect replays nothing that was read on another device meanwhile (rule 5)", async () => {
    const [thread] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, created_by)
      VALUES (${ORG}, ${`prec-read-${crypto.randomUUID()}`}, ${USER}) RETURNING id`
    const [msg] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
      VALUES (${thread!.id}, ${ORG}, ${USER}, 'hello', '{}'::text[]) RETURNING id`
    const [later] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, created_at)
      VALUES (${thread!.id}, ${ORG}, ${USER}, 'unread', '{}'::text[], now() + interval '1 second')
      RETURNING id`
    // The thread is read up to the first message, on the phone.
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id, last_read_message_id)
      VALUES (${USER}, ${thread!.id}, ${ORG}, ${msg!.id})`
    const [readRow] = await sql<{ id: string }[]>`
      INSERT INTO kernel.attention_events
        (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_type,
         occurred_at, read_at, digest_eligible_at)
      VALUES (${ORG}, ${USER}, 'kernel', 'approval_request', 'x', 'approval_decision', 50, 's',
        'user', now(), now(), now()) RETURNING id`
    const insert = (notifyId: string) => {
      const n = crypto.randomUUID()
      const frame = {
        type: "notify",
        notifyId,
        notificationId: n,
        group: "direct",
        title: "t",
        body: "b",
        route: "thread/t",
        urgent: false,
      }
      return sql`INSERT INTO kernel.notification_deliveries
        (org_id, user_id, notification_id, channel, result, payload, attempted_at)
        VALUES (${ORG}, ${USER}, ${n}, 'desktop', 'no_target', ${JSON.stringify(frame)}::jsonb,
                now() - interval '1 minute')`.then(() => n)
    }
    const readMessage = await insert(`message:${msg!.id}`)
    const unreadMessage = await insert(`message:${later!.id}`)
    const readItem = await insert(`attention:${readRow!.id}`)
    try {
      const desk = await connect("desktop_app", "desk-read", "granted")
      const entry = (await m.listNotifyPresence(ORG, USER)).find((e) => e.deviceId === "desk-read")
      if (!entry) throw new Error("no presence entry")
      await replayMissedDesktopNotifications(m, entry, ORG, USER)
      const got = notifies(desk).map((f) => f.notificationId)
      expect(got).toEqual([unreadMessage])
      expect(got).not.toContain(readMessage)
      expect(got).not.toContain(readItem)
    } finally {
      await sql`DELETE FROM kernel.attention_events WHERE id = ${readRow!.id}`
      await sql`DELETE FROM kernel.user_thread_state WHERE thread_id = ${thread!.id}`
      await sql`DELETE FROM kernel.messages WHERE thread_id = ${thread!.id}`
      await sql`DELETE FROM kernel.threads WHERE id = ${thread!.id}`
    }
  })
})
