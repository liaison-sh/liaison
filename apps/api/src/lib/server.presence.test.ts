// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Presence through the REAL realtime server path (lib/server.ts `open`,
// `close` and the hello's `presence_sync`), over real WebSockets, with the
// cell state in real Redis (S5, A12). A user with two tabs stays online when
// one closes, on one replica or across two, and a Redis that does not answer
// leaves the decision to the closing process's own sockets (P2-3).
//
// The presence frames other sockets receive are the `presence:update`
// ephemeral events the server publishes; the test records those on the event
// bus, which is what the per-replica fan-out turns into socket frames.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { Server } from "bun"
import Redis from "ioredis"
import { onEvent } from "~/infra/events/event-bus"
import { LIVE_INSTANCE_KEY } from "~/infra/instance-registry"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { type LiveRedis, RedisLiveState } from "~/infra/websocket-state/redis"
import { redis } from "~/lib/redis"
import { createServer, type WsData } from "~/lib/server"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type PresenceFrame = { orgId: string; userId: string; status: string }

const frames: PresenceFrame[] = []
let recording = false
onEvent(
  async (event) => {
    if (!recording || event.entity !== "presence" || event.action !== "update") return
    const data = event.data as { userId?: string; status?: string } | undefined
    if (!event.orgId || !data?.userId || !data.status) return
    frames.push({ orgId: event.orgId, userId: data.userId, status: data.status })
  },
  { delivery: "per-replica", name: "server-presence-test-recorder" },
)

const statusesOf = (s: minimal.Session) =>
  frames.filter((f) => f.orgId === s.orgId && f.userId === s.userId).map((f) => f.status)

async function until(ok: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await Bun.sleep(25)
  return ok()
}

/** Every command hangs, as Redis does during an outage. */
const hanging: LiveRedis = {
  eval: () => new Promise(() => {}),
  get: () => new Promise(() => {}),
  set: () => new Promise(() => {}),
  del: () => new Promise(() => {}),
}

describe("presence over the real WebSocket server (S5)", () => {
  const sessions = new Map<string, minimal.Session>()
  const servers: Server<WsData>[] = []
  const clients: WebSocket[] = []
  const instances: string[] = []
  let previous: WebSocketManager | null

  async function newSession(): Promise<minimal.Session> {
    const org = await createTestOrg()
    const s = await minimal.session(org.id)
    sessions.set(s.userId, s)
    return s
  }

  /** One replica: its own manager and instance id, a heartbeat record in Redis. */
  async function replica(
    live?: (instanceId: string) => RedisLiveState,
    opts: { managerRedis?: Redis; redisTimeoutMs?: number } = {},
  ) {
    const instanceId = `presence-test-${crypto.randomUUID()}`
    instances.push(instanceId)
    await redis.set(LIVE_INSTANCE_KEY(instanceId), "{}", "PX", 60_000)
    const manager = new WebSocketManager(opts.managerRedis ?? redis, live?.(instanceId), {
      instanceId,
      redisTimeoutMs: opts.redisTimeoutMs,
    })
    const server = await createServer(
      { fetch: () => new Response("not found", { status: 404 }) },
      {
        wsManager: manager,
        port: 0,
        publicDir: "/nonexistent-public-dir",
        logPrefix: "ws-presence-test",
        onUpgrade: async (req) => {
          const s = sessions.get(new URL(req.url).searchParams.get("as") ?? "")
          if (!s) return null
          return {
            userId: s.userId,
            orgId: s.orgId,
            scopes: ["*"],
            dimensionGrants: {},
            authorized: true,
          }
        },
      },
    )
    servers.push(server)
    return { manager, server }
  }

  /** A socket of `session` on `server`, once the server has recorded it. */
  async function connect(server: Server<WsData>, manager: WebSocketManager, s: minimal.Session) {
    const before = manager.getConnectionCount()
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?as=${s.userId}`)
    clients.push(ws)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(e)
    })
    await until(() => manager.getConnectionCount() > before)
    return ws
  }

  /** The `presence_sync` map a hello on this socket answers. */
  async function presenceSync(ws: WebSocket): Promise<Record<string, string>> {
    const got = new Promise<Record<string, string>>((resolve) => {
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as { type: string; users?: Record<string, string> }
        if (m.type === "presence_sync") resolve(m.users ?? {})
      }
    })
    ws.send(JSON.stringify({ type: "hello", clientKind: "web", lastActiveAt: Date.now() }))
    return got
  }

  beforeAll(async () => {
    await acquireTestLock()
    previous = getWsManager()
    recording = true
  })

  afterAll(async () => {
    recording = false
    for (const ws of clients.splice(0)) ws.close()
    await Bun.sleep(100)
    for (const s of servers.splice(0)) s.stop(true)
    for (const id of instances) await redis.del(LIVE_INSTANCE_KEY(id))
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("closing one of a user's two sockets broadcasts no offline; closing the second does", async () => {
    const u = await newSession()
    const { manager, server } = await replica()
    setWsManager(manager)
    const tab1 = await connect(server, manager, u)
    const tab2 = await connect(server, manager, u)
    expect(await until(() => statusesOf(u).includes("online"))).toBe(true)
    // The second tab is not a new arrival.
    expect(statusesOf(u)).toEqual(["online"])

    tab1.close()
    await until(() => manager.getConnectionCount() === 1)
    await Bun.sleep(1000)
    expect(statusesOf(u)).not.toContain("offline")
    expect(await manager.getPresence(u.orgId, u.userId)).toBe("online")

    tab2.close()
    expect(await until(() => statusesOf(u).includes("offline"))).toBe(true)
    expect(await manager.getPresence(u.orgId, u.userId)).toBe("offline")
  })

  it("pings within 25 s refresh presence once (the client pings every 5 s)", async () => {
    const u = await newSession()
    const { manager, server } = await replica()
    setWsManager(manager)
    const ws = await connect(server, manager, u)
    let refreshes = 0
    const original = manager.refreshPresence.bind(manager)
    manager.refreshPresence = async (orgId: string, userId: string) => {
      refreshes++
      return original(orgId, userId)
    }
    let pongs = 0
    ws.onmessage = (ev) => {
      if ((JSON.parse(String(ev.data)) as { type: string }).type === "pong") pongs++
    }
    for (let i = 0; i < 4; i++) ws.send(JSON.stringify({ type: "ping" }))
    expect(await until(() => pongs === 4)).toBe(true)
    // Every ping is answered; presence is refreshed for the first one only.
    expect(refreshes).toBe(1)
    ws.close()
  })

  it("two tabs on two replicas: closing one keeps the user online", async () => {
    const u = await newSession()
    const a = await replica()
    const b = await replica()
    setWsManager(a.manager)
    const onA = await connect(a.server, a.manager, u)
    const onB = await connect(b.server, b.manager, u)
    expect(await until(() => statusesOf(u).includes("online"))).toBe(true)
    expect(statusesOf(u)).toEqual(["online"])

    onB.close()
    await until(() => b.manager.getConnectionCount() === 0)
    await Bun.sleep(1000)
    expect(statusesOf(u)).not.toContain("offline")

    onA.close()
    expect(await until(() => statusesOf(u).includes("offline"))).toBe(true)
  })

  it("presence_sync lists a user whose only socket is on another replica", async () => {
    const u = await newSession()
    const observer = await minimal.session(u.orgId)
    sessions.set(observer.userId, observer)
    const a = await replica()
    const b = await replica()
    setWsManager(a.manager)
    await connect(b.server, b.manager, u)
    const obs = await connect(a.server, a.manager, observer)
    const users = await presenceSync(obs)
    expect(users[u.userId]).toBe("online")
    expect(users[observer.userId]).toBe("online")
  })

  it("without an answer from Redis, closing one of two local tabs still keeps the user online", async () => {
    const u = await newSession()
    const { manager, server } = await replica(
      (instanceId) => new RedisLiveState(hanging, instanceId, "", { commandTimeoutMs: 100 }),
    )
    setWsManager(manager)
    const tab1 = await connect(server, manager, u)
    const tab2 = await connect(server, manager, u)
    expect(await until(() => statusesOf(u).includes("online"))).toBe(true)

    tab1.close()
    await until(() => manager.getConnectionCount() === 1)
    await Bun.sleep(1000)
    expect(statusesOf(u)).not.toContain("offline")

    tab2.close()
    expect(await until(() => statusesOf(u).includes("offline"))).toBe(true)
  })

  // The open and close paths await no unbounded Redis command (P2-3): the
  // manager's client here never connects, so every command it sends queues
  // forever, as on the shared client (maxRetriesPerRequest: null) during an
  // outage. The replay cursor read proceeds without a cursor, the presence
  // write is skipped, and the arrival and departure are still announced.
  it("a Redis that never answers delays neither the arrival nor the departure", async () => {
    const dead = new Redis({
      host: "127.0.0.1",
      port: 1,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      retryStrategy: () => 1_000,
    })
    dead.on("error", () => {})
    try {
      const u = await newSession()
      const { manager, server } = await replica(
        (instanceId) => new RedisLiveState(hanging, instanceId, "", { commandTimeoutMs: 100 }),
        { managerRedis: dead, redisTimeoutMs: 100 },
      )
      setWsManager(manager)
      const t0 = Date.now()
      const tab = await connect(server, manager, u)
      expect(await until(() => statusesOf(u).includes("online"), 3_000)).toBe(true)
      expect(Date.now() - t0).toBeLessThan(3_000)

      tab.close()
      expect(await until(() => statusesOf(u).includes("offline"), 3_000)).toBe(true)
    } finally {
      dead.disconnect()
    }
  })
})
