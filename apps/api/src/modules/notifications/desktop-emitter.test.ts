// SPDX-License-Identifier: FSL-1.1-ALv2
// S5 + S6: the server drives desktop notifications. One `notify` frame per item
// and user, sent to the chosen connections only: every live desktop app, else
// the single most recently active browser tab, never a phone. Presence and the
// idempotency claim live in Redis, so the choice and the "only once" hold
// across API instances. Runs against the real Redis of .env.test.
import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { effectiveGrid } from "@liaison/shared"
import Redis from "ioredis"
import { type NotifyClientKind, WebSocketManager } from "~/infra/websocket"
import { replayBufferKey } from "~/infra/websocket-replay-buffer"
import { env } from "~/lib/env"
import { desktopTag, emitDesktopNotify } from "./desktop-emitter"
import { type RecipientContext, type RouterDecision, resolveChannels } from "./router"

const clients: Redis[] = []
function client(): Redis {
  const r = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  clients.push(r)
  return r
}

afterAll(async () => {
  for (const c of clients) c.disconnect()
})

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

function notifies(ws: FakeWs) {
  return ws.frames.filter((f) => f.type === "notify")
}

function ctx(over: Partial<RecipientContext> = {}): RecipientContext {
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
    ...over,
  }
}

async function decisionFor(
  userId: string,
  orgId: string,
  over: Partial<RecipientContext> = {},
): Promise<RouterDecision> {
  return resolveChannels(
    { userId, orgId },
    { kind: "approval_pending", app: "kernel", isUrgent: false },
    { loadContext: async () => ctx(over) },
  )
}

let userId: string
let orgId: string
let seq = 0
function payload(notifyId = `attention:${crypto.randomUUID()}`) {
  return { notifyId, title: "Approval needed", body: "Refund 42", route: "/approvals/1" }
}

/**
 * Opens a connection on `m` and says hello with `kind`, active at
 * `lastActiveAt`. A desktop app reports the OS permission `granted` (A6: only
 * a granted app is a target; the other permissions are pinned in
 * computer-precedence.test.ts).
 */
async function connect(
  m: WebSocketManager,
  kind: NotifyClientKind | undefined,
  lastActiveAt: number,
): Promise<FakeWs> {
  const ws = fakeWs()
  m.addConnection(userId, ws, ["*"], orgId)
  await m.registerNotifyClient(
    ws,
    kind,
    lastActiveAt,
    kind === "desktop_app" ? { notificationPermission: "granted" } : {},
  )
  return ws
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 150))
}

beforeEach(() => {
  seq += 1
  userId = `u-${crypto.randomUUID()}`
  orgId = `o-${crypto.randomUUID()}`
})

describe("emitDesktopNotify target selection (S6)", () => {
  it("two browser tabs: only the most recently active one raises", async () => {
    const m = new WebSocketManager(client(), undefined, { instanceId: `i-${seq}` })
    const older = await connect(m, "browser", 1_000)
    const newer = await connect(m, "browser", 2_000)
    const res = await emitDesktopNotify(await decisionFor(userId, orgId), payload(), { manager: m })
    expect(res.sent).toBe(1)
    expect(notifies(newer)).toHaveLength(1)
    expect(notifies(older)).toHaveLength(0)
    const frame = notifies(newer)[0]
    expect(frame).toMatchObject({
      type: "notify",
      group: "approvals",
      title: "Approval needed",
      body: "Refund 42",
      route: "/approvals/1",
      urgent: false,
    })
    expect(frame.eventId).toBeUndefined()
  })

  it("a heartbeat moves the choice to the tab the user touched last", async () => {
    const m = new WebSocketManager(client(), undefined, { instanceId: `i-${seq}` })
    const a = await connect(m, "browser", 1_000)
    const b = await connect(m, "browser", 2_000)
    await m.touchNotifyPresence(a, 3_000)
    await emitDesktopNotify(await decisionFor(userId, orgId), payload(), { manager: m })
    expect(notifies(a)).toHaveLength(1)
    expect(notifies(b)).toHaveLength(0)
  })

  it("desktop app and a tab: only the app raises; two apps both raise", async () => {
    const m = new WebSocketManager(client(), undefined, { instanceId: `i-${seq}` })
    const tab = await connect(m, "browser", 9_000)
    const app1 = await connect(m, "desktop_app", 1_000)
    const app2 = await connect(m, "desktop_app", 500)
    const res = await emitDesktopNotify(await decisionFor(userId, orgId), payload(), { manager: m })
    expect(res.sent).toBe(2)
    expect(notifies(app1)).toHaveLength(1)
    expect(notifies(app2)).toHaveLength(1)
    expect(notifies(tab)).toHaveLength(0)
  })

  it("a mobile app never raises, even when it is the only connection", async () => {
    const m = new WebSocketManager(client(), undefined, { instanceId: `i-${seq}` })
    const phone = await connect(m, "mobile_app", 9_000)
    const res = await emitDesktopNotify(await decisionFor(userId, orgId), payload(), { manager: m })
    expect(res.sent).toBe(0)
    expect(res.skipped).toBe("no_target")
    expect(notifies(phone)).toHaveLength(0)

    const tab = await connect(m, "browser", 1_000)
    await emitDesktopNotify(await decisionFor(userId, orgId), payload(), { manager: m })
    expect(notifies(tab)).toHaveLength(1)
    expect(notifies(phone)).toHaveLength(0)
  })

  it("a hello without a client kind is never a target", async () => {
    const m = new WebSocketManager(client(), undefined, { instanceId: `i-${seq}` })
    const legacy = await connect(m, undefined, 9_000)
    const res = await emitDesktopNotify(await decisionFor(userId, orgId), payload(), { manager: m })
    expect(res.sent).toBe(0)
    expect(notifies(legacy)).toHaveLength(0)
  })

  it("a closed connection leaves presence at once", async () => {
    const r = client()
    const m = new WebSocketManager(r, undefined, { instanceId: `i-${seq}` })
    const app = await connect(m, "desktop_app", 1_000)
    const tab = await connect(m, "browser", 1_000)
    m.removeConnection(app)
    await settle()
    await emitDesktopNotify(await decisionFor(userId, orgId), payload(), { manager: m })
    expect(notifies(tab)).toHaveLength(1)
  })

  it("presence lives 60 s and is refreshed by the heartbeat", async () => {
    const r = client()
    const m = new WebSocketManager(r, undefined, { instanceId: `i-${seq}` })
    const ws = await connect(m, "browser", 1_000)
    const entries = await m.listNotifyPresence(orgId, userId)
    expect(entries).toHaveLength(1)
    const ttl = await r.ttl(`ws:notify-conn:${entries[0]?.connId}`)
    expect(ttl).toBeGreaterThan(50)
    expect(ttl).toBeLessThanOrEqual(60)
    await r.expire(`ws:notify-conn:${entries[0]?.connId}`, 5)
    await m.touchNotifyPresence(ws, 2_000)
    expect(await r.ttl(`ws:notify-conn:${entries[0]?.connId}`)).toBeGreaterThan(50)
    // An expired entry (the instance died without closing) is not a target.
    await r.del(`ws:notify-conn:${entries[0]?.connId}`)
    expect(await m.listNotifyPresence(orgId, userId)).toHaveLength(0)
  })

  it("the desktop cell off sends nothing and claims nothing", async () => {
    const m = new WebSocketManager(client(), undefined, { instanceId: `i-${seq}` })
    const tab = await connect(m, "browser", 1_000)
    const grid = effectiveGrid({ approvals: { desktop: false } })
    const p = payload()
    const off = await emitDesktopNotify(await decisionFor(userId, orgId, { grid }), p, {
      manager: m,
    })
    expect(off.sent).toBe(0)
    expect(off.skipped).toBe("not_routed")
    const on = await emitDesktopNotify(await decisionFor(userId, orgId), p, { manager: m })
    expect(on.sent).toBe(1)
    expect(notifies(tab)).toHaveLength(1)
  })
})

describe("notify is connection-addressed and never replayed (S5)", () => {
  it("a reconnect replays no notify frame", async () => {
    const r = client()
    const m = new WebSocketManager(r, undefined, { instanceId: `i-${seq}` })
    const tab = await connect(m, "browser", 1_000)
    // One ordinary buffered event so the org has a replay buffer at all.
    await m.bufferAndBroadcast({ app: "kernel", entity: "presence", action: "update", orgId })
    await emitDesktopNotify(await decisionFor(userId, orgId), payload(), { manager: m })
    expect(notifies(tab)).toHaveLength(1)

    const buffered = await r.zrange(replayBufferKey(orgId), "0", "-1")
    expect(buffered.some((e) => e.includes('"notify"'))).toBe(false)

    m.removeConnection(tab)
    const again = fakeWs()
    m.addConnection(userId, again, ["*"], orgId)
    // A cursor from before the notify replays what followed it: the ordinary
    // event emitted since comes back, the notify does not.
    await m.bufferAndBroadcast({ app: "kernel", entity: "presence", action: "update", orgId })
    await m.handleHello(again, userId, 1, ["*"], orgId)
    await m.registerNotifyClient(again, "browser", 5_000)
    expect(again.frames.some((f) => f.type === "event")).toBe(true)
    expect(notifies(again)).toHaveLength(0)
    await r.del(replayBufferKey(orgId), `ws:seq:${orgId}`)
  })
})

describe("across API instances (two Redis clients)", () => {
  it("one notifyId raises once even when two instances emit it", async () => {
    const a = new WebSocketManager(client(), undefined, { instanceId: `a-${seq}` })
    const b = new WebSocketManager(client(), undefined, { instanceId: `b-${seq}` })
    await a.startNotifyDelivery(client())
    await b.startNotifyDelivery(client())
    const tab = await connect(b, "browser", 1_000)
    const p = payload()
    const [ra, rb] = await Promise.all([
      emitDesktopNotify(await decisionFor(userId, orgId), p, { manager: a }),
      emitDesktopNotify(await decisionFor(userId, orgId), p, { manager: b }),
    ])
    await settle()
    expect(notifies(tab)).toHaveLength(1)
    expect([ra.skipped, rb.skipped].filter((s) => s === "duplicate")).toHaveLength(1)
    await a.stopNotifyDelivery()
    await b.stopNotifyDelivery()
  })

  it("selection spans instances: the app on instance B wins over the tab on A", async () => {
    const a = new WebSocketManager(client(), undefined, { instanceId: `a2-${seq}` })
    const b = new WebSocketManager(client(), undefined, { instanceId: `b2-${seq}` })
    await a.startNotifyDelivery(client())
    await b.startNotifyDelivery(client())
    const tabOnA = await connect(a, "browser", 9_000)
    const appOnB = await connect(b, "desktop_app", 1_000)
    const res = await emitDesktopNotify(await decisionFor(userId, orgId), payload(), {
      manager: a,
    })
    await settle()
    expect(res.sent).toBe(1)
    expect(notifies(appOnB)).toHaveLength(1)
    expect(notifies(tabOnA)).toHaveLength(0)
    await a.stopNotifyDelivery()
    await b.stopNotifyDelivery()
  })
})

describe("the notification tag (one notification per conversation)", () => {
  it("is the conversation of the route, the producer's own tag, else the item", () => {
    const base = { notifyId: "message:m1", title: "Ada", body: "hi" }
    expect(desktopTag({ ...base, route: "thread/t1" })).toBe("thread/t1")
    // A reply's notice replaces its conversation's, not a separate stack.
    expect(desktopTag({ ...base, route: "thread/t1?replyRoot=r9" })).toBe("thread/t1")
    expect(desktopTag({ ...base, route: "attention/kernel/approval_request/a1" })).toBe(
      "attention/kernel/approval_request/a1",
    )
    expect(desktopTag({ ...base, route: "", tag: "burst:org" })).toBe("burst:org")
    expect(desktopTag({ ...base, route: "" })).toBe("message:m1")
  })
})
