// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S1, A5, A10: every router decision and every delivery attempt leaves a row in
// `kernel.notification_deliveries`, and every notification carries one
// `notificationId` from the router to the wire (APNs custom data, the desktop
// frame). Real rows, real Redis presence; only the APNs socket is a fake.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { effectiveGrid } from "@liaison/shared"
import Redis from "ioredis"
import { sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import { type NotifyClientKind, WebSocketManager } from "~/infra/websocket"
import { env } from "~/lib/env"
import { handlePushFanout, PushFanoutTestAccess } from "~/modules/push/fanout-consumer"
import { type PushCredentials, sendPush } from "~/modules/push/sender"
import { FakePushTransport } from "~/modules/push/transport-fake"
import type { PushPayload, PushTokenRow } from "~/modules/push/types"
import { BurstTestAccess } from "./burst"
import { runNotificationDeliveriesRetention } from "./delivery-log"
import { emitDesktopNotify } from "./desktop-emitter"
import { registerDesktopEmitter } from "./desktop-hook"
import { dispatchAttentionLive } from "./dispatch"
import { notificationIdFor, type RecipientContext, resolveChannels } from "./router"

const ORG = "00000000-0000-0000-0000-00000000a1d0"
const ALICE = "00000000-0000-0000-0000-00000000a1d1"
const BOB = "00000000-0000-0000-0000-00000000a1d2"
const CAROL = "00000000-0000-0000-0000-00000000a1d3"
const SCOPE = "pennylane:payouts:read"

const APNS_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgUb0uv3OqGawflNEa
44vN6HM1BtQeigQswWPnFyTwxcOhRANCAARgaihBMqP+jkRZDO9khtNjkb5STk7t
RCt9BYmiMv1q1T/yrylSx0lHCBHES+dGySDgmAV+LhW060oAsKZyvtnX
-----END PRIVATE KEY-----`

const credentials: PushCredentials = {
  apns: { keyId: "ABC1234567", teamId: "TEAM123456", bundleId: "com.liaison.app", key: APNS_P8 },
}

let dmBobId = ""
let dmCarolId = ""
let bobTokenId = ""

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

async function connect(
  m: WebSocketManager,
  userId: string,
  kind: NotifyClientKind,
  deviceId: string,
): Promise<FakeWs> {
  const ws = fakeWs()
  m.addConnection(userId, ws, ["*"], ORG)
  await m.registerNotifyClient(ws, kind, Date.now(), {
    deviceId,
    ...(kind === "desktop_app" ? { notificationPermission: "granted" } : {}),
  })
  return ws
}

function dmEvent(threadId: string, over: Record<string, unknown> = {}): AppEvent {
  const id = crypto.randomUUID()
  return {
    app: "kernel",
    entity: "message",
    action: "create",
    entityId: id,
    orgId: ORG,
    actorId: ALICE,
    actorType: "user",
    data: {
      id,
      threadId,
      authorId: ALICE,
      authorName: "Alice",
      authorType: "user",
      content: "lunch?",
      mentions: [],
      requiredScopes: [],
      disclosureList: null,
      ...over,
    },
  } as AppEvent
}

function apnsSend(transport: FakePushTransport) {
  return (token: PushTokenRow, payload: PushPayload) =>
    sendPush(token, payload, { transport, credentials, server: "https://liaison.test" })
}

interface DeliveryRow {
  notification_id: string
  user_id: string
  device_id: string | null
  surface: string | null
  channel: string
  result: string
  reason: string | null
  provider_status: number | null
  payload: Record<string, unknown> | null
}

async function rowsFor(userId: string): Promise<DeliveryRow[]> {
  return (await sql`SELECT notification_id, user_id, device_id, surface, channel, result, reason,
                           provider_status, payload
                      FROM kernel.notification_deliveries
                     WHERE org_id = ${ORG} AND user_id = ${userId}
                     ORDER BY attempted_at, channel`) as unknown as DeliveryRow[]
}

function routerCtx(over: Partial<RecipientContext> = {}): RecipientContext {
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
    hasPushDevice: true,
    ...over,
  }
}

describe("notification delivery log (S1, A5, A10)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'DeliveryLogOrg', 'delivery-log-org') ON CONFLICT (id) DO NOTHING`
    for (const [id, name] of [
      [ALICE, "Alice"],
      [BOB, "Bob"],
      [CAROL, "Carol"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG}, ${`dlog-${name}@t.com`}, ${name}, 'x') ON CONFLICT (id) DO NOTHING`
    }
    const [bt] = await sql<{ id: string }[]>`INSERT INTO kernel.push_tokens
      (org_id, user_id, platform, token, environment)
      VALUES (${ORG}, ${BOB}, 'ios', 'dlog-token-bob', 'sandbox') RETURNING id`
    bobTokenId = bt.id
    for (const [peer, set] of [
      [BOB, (id: string) => (dmBobId = id)],
      [CAROL, (id: string) => (dmCarolId = id)],
    ] as const) {
      const [t] = await sql<
        { id: string }[]
      >`INSERT INTO kernel.threads (org_id, handle, created_by)
        VALUES (${ORG}, ${`dlog-dm-${peer}`}, ${ALICE}) RETURNING id`
      set(t.id)
      for (const userId of [ALICE, peer]) {
        await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
          VALUES (${t.id}, ${userId}, ${ORG})`
      }
    }
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${BOB}, ${ORG}, ${SCOPE}) ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    registerDesktopEmitter(null)
    for (const r of redisClients) r.disconnect()
    await sql`DELETE FROM kernel.notification_deliveries WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_preferences WHERE user_id IN (${ALICE}, ${BOB}, ${CAROL})`
    await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  beforeEach(async () => {
    // Not a burst (burst.ts): every case starts from none.
    await BurstTestAccess.resetOrg(ORG)
    PushFanoutTestAccess.resetDedupe()
    // Presence lives in the shared Redis with a 60 s TTL: an earlier run's
    // connections for these fixed users would otherwise still be targets.
    await redis().del(...[ALICE, BOB, CAROL].map((u) => `ws:notify-presence:${ORG}:${u}`))
    await sql`DELETE FROM kernel.notification_deliveries WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_preferences WHERE user_id IN (${ALICE}, ${BOB}, ${CAROL})`
  })

  afterEach(() => {
    registerDesktopEmitter(null)
  })

  it("a DM to a user with a push token writes an accepted row with the APNs status", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    const event = dmEvent(dmBobId)
    await handlePushFanout(
      { eventId: crypto.randomUUID(), event },
      { send: apnsSend(transport), badgeCount: async () => 1 },
    )
    const nid = notificationIdFor(BOB, `message:${(event.data as { id: string }).id}`)
    const push = (await rowsFor(BOB)).filter((r) => r.channel === "push")
    expect(push).toHaveLength(1)
    expect(push[0]).toMatchObject({
      notification_id: nid,
      device_id: bobTokenId,
      surface: "ios",
      result: "accepted",
      provider_status: 200,
    })
    expect(push[0].payload?.notificationId).toBe(nid)
  })

  it("the APNs payload carries the notificationId and mutable-content 1, tagged or not", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 200, body: "" })
    transport.enqueue({ status: 200, body: "" })
    const plain = dmEvent(dmBobId)
    const tagged = dmEvent(dmBobId, { requiredScopes: [SCOPE], content: "payout 9k" })
    for (const event of [plain, tagged]) {
      await handlePushFanout(
        { eventId: crypto.randomUUID(), event },
        { send: apnsSend(transport), badgeCount: async () => 1 },
      )
    }
    expect(transport.requests).toHaveLength(2)
    const bodies = transport.requests.map((r) => JSON.parse(r.body))
    expect(bodies[0].notificationId).toBe(
      notificationIdFor(BOB, `message:${(plain.data as { id: string }).id}`),
    )
    expect(bodies[1].notificationId).toBe(
      notificationIdFor(BOB, `message:${(tagged.data as { id: string }).id}`),
    )
    for (const b of bodies) expect(b.aps["mutable-content"]).toBe(1)
    // The tagged one is text-less: nothing of the message reached the wire.
    expect(JSON.stringify(bodies[1])).not.toContain("payout")
  })

  it("APNs sandbox/production retry writes one row per host tried", async () => {
    const transport = new FakePushTransport()
    transport.enqueue({ status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) })
    transport.enqueue({ status: 200, body: "" })
    await handlePushFanout(
      { eventId: crypto.randomUUID(), event: dmEvent(dmBobId) },
      { send: apnsSend(transport), badgeCount: async () => 1 },
    )
    const push = (await rowsFor(BOB)).filter((r) => r.channel === "push")
    expect(push.map((r) => [r.result, r.provider_status])).toEqual([
      ["rejected", 400],
      ["accepted", 200],
    ])
    // The row learnt its host; restore the fixture for the next cases.
    await sql`UPDATE kernel.push_tokens SET environment = 'sandbox' WHERE id = ${bobTokenId}`
  })

  it("grid_off writes suppressed/grid_off with no device, and nothing reaches APNs", async () => {
    await sql`INSERT INTO kernel.user_preferences (user_id, notification_channels)
      VALUES (${BOB}, ${JSON.stringify({ grid: { direct: { push: false, desktop: false } } })}::jsonb)`
    const transport = new FakePushTransport()
    const event = dmEvent(dmBobId)
    await handlePushFanout(
      { eventId: crypto.randomUUID(), event },
      { send: apnsSend(transport), badgeCount: async () => 1 },
    )
    expect(transport.requests).toHaveLength(0)
    const rows = await rowsFor(BOB)
    const nid = notificationIdFor(BOB, `message:${(event.data as { id: string }).id}`)
    expect(
      rows.map((r) => [r.channel, r.result, r.reason, r.device_id, r.notification_id]),
    ).toEqual([
      ["desktop", "suppressed", "grid_off", null, nid],
      ["push", "suppressed", "grid_off", null, nid],
    ])
  })

  it("a recipient with no push token writes no_device", async () => {
    const event = dmEvent(dmCarolId)
    await handlePushFanout(
      { eventId: crypto.randomUUID(), event },
      { send: apnsSend(new FakePushTransport()), badgeCount: async () => 0 },
    )
    const push = (await rowsFor(CAROL)).filter((r) => r.channel === "push")
    expect(push).toHaveLength(1)
    expect(push[0]).toMatchObject({ result: "no_device", device_id: null })
  })

  it("an attention item whose cells are off writes suppressed rows under its notificationId", async () => {
    const grid = effectiveGrid(null)
    grid.work = { ...grid.work, push: false, desktop: false }
    const decision = await resolveChannels(
      { userId: BOB, orgId: ORG },
      { kind: "sla_risk", app: "tickets", isUrgent: false },
      { loadContext: async () => routerCtx({ grid }) },
    )
    const notifyId = `attention:${crypto.randomUUID()}`
    await dispatchAttentionLive(decision, {
      notifyId,
      summary: "SLA at risk",
      app: "tickets",
      entityType: "ticket",
      entityId: crypto.randomUUID(),
    })
    const rows = await rowsFor(BOB)
    expect(rows.map((r) => [r.channel, r.result, r.reason, r.notification_id])).toEqual([
      ["desktop", "suppressed", "grid_off", notificationIdFor(BOB, notifyId)],
      ["push", "suppressed", "grid_off", notificationIdFor(BOB, notifyId)],
    ])
  })

  it("the desktop frame writes one row per desktop connection, with its device id", async () => {
    const m = new WebSocketManager(redis(), undefined, {
      instanceId: `dlog-${crypto.randomUUID()}`,
    })
    const a = await connect(m, BOB, "desktop_app", "desk-A")
    const b = await connect(m, BOB, "desktop_app", "desk-B")
    const decision = await resolveChannels(
      { userId: BOB, orgId: ORG },
      { kind: "approval_pending", app: "kernel", isUrgent: false },
      { loadContext: async () => routerCtx() },
    )
    const notifyId = `attention:${crypto.randomUUID()}`
    const res = await emitDesktopNotify(
      decision,
      { notifyId, title: "Approval", body: "Refund", route: "thread/x" },
      { manager: m },
    )
    expect(res.sent).toBe(2)
    const nid = notificationIdFor(BOB, notifyId)
    for (const ws of [a, b]) {
      const frames = ws.frames.filter((f) => f.type === "notify")
      expect(frames).toHaveLength(1)
      expect(frames[0].notificationId).toBe(nid)
    }
    const rows = (await rowsFor(BOB)).filter((r) => r.channel === "desktop")
    expect(rows.map((r) => [r.surface, r.device_id, r.result, r.notification_id]).sort()).toEqual([
      ["desktop", "desk-A", "accepted", nid],
      ["desktop", "desk-B", "accepted", nid],
    ])
    expect(rows[0].payload?.title).toBe("Approval")
  })

  it("an in-tab notification writes a browser_tab row; no connection writes no_target", async () => {
    const m = new WebSocketManager(redis(), undefined, {
      instanceId: `dlog-${crypto.randomUUID()}`,
    })
    const decision = await resolveChannels(
      { userId: CAROL, orgId: ORG },
      { kind: "approval_pending", app: "kernel", isUrgent: false },
      { loadContext: async () => routerCtx() },
    )
    const first = `attention:${crypto.randomUUID()}`
    await emitDesktopNotify(
      decision,
      { notifyId: first, title: "t", body: "b", route: "r" },
      {
        manager: m,
      },
    )
    await connect(m, CAROL, "browser", "browser-1")
    const second = `attention:${crypto.randomUUID()}`
    await emitDesktopNotify(
      decision,
      { notifyId: second, title: "t", body: "b", route: "r" },
      {
        manager: m,
      },
    )
    const rows = (await rowsFor(CAROL)).filter((r) => r.channel === "desktop")
    expect(rows.map((r) => [r.notification_id, r.surface, r.device_id, r.result])).toEqual([
      [notificationIdFor(CAROL, first), null, null, "no_target"],
      [notificationIdFor(CAROL, second), "browser_tab", "browser-1", "accepted"],
    ])
  })

  it("a durable-event retry keeps the same notificationId: no duplicate rows, no second frame", async () => {
    const m = new WebSocketManager(redis(), undefined, {
      instanceId: `dlog-${crypto.randomUUID()}`,
    })
    const desk = await connect(m, CAROL, "desktop_app", "carol-desk")
    registerDesktopEmitter(async (d, p) => {
      await emitDesktopNotify(d, p, { manager: m })
    })
    const event = dmEvent(dmCarolId)
    const eventId = crypto.randomUUID()
    const deps = { send: apnsSend(new FakePushTransport()), badgeCount: async () => 0 }
    await handlePushFanout({ eventId, event }, deps)
    const before = await rowsFor(CAROL)
    // A crash between the fanout and the event-level mark: the outbox hands the
    // same event over again to a fresh process.
    PushFanoutTestAccess.resetDedupe()
    await sql`DELETE FROM kernel.durable_consumer_marks WHERE consumer = 'push-fanout' AND event_id = ${eventId}`
    await handlePushFanout({ eventId, event }, deps)
    const after = await rowsFor(CAROL)
    expect(after).toHaveLength(before.length)
    expect(new Set(after.map((r) => r.notification_id))).toEqual(
      new Set([notificationIdFor(CAROL, `message:${(event.data as { id: string }).id}`)]),
    )
    expect(desk.frames.filter((f) => f.type === "notify")).toHaveLength(1)
  })

  it("the 30-day purge removes old rows and keeps recent ones", async () => {
    const old = crypto.randomUUID()
    const recent = crypto.randomUUID()
    await sql`INSERT INTO kernel.notification_deliveries
      (org_id, user_id, notification_id, channel, result, attempted_at)
      VALUES (${ORG}, ${BOB}, ${old}, 'push', 'no_device', now() - interval '31 days'),
             (${ORG}, ${BOB}, ${recent}, 'push', 'no_device', now() - interval '1 day')`
    await runNotificationDeliveriesRetention()
    const ids = (await rowsFor(BOB)).map((r) => r.notification_id)
    expect(ids).toEqual([recent])
  })
})
