// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The node credential binding through the REAL realtime server path
// (lib/server.ts `hello` -> onNodeConnectionHello -> markNodeConnection, and
// `close` -> closeNodeSession), over a real WebSocket: the other node tests
// call the hook directly, which is exactly what would hide a server.ts that
// stopped calling it, or passed it the wrong fields (A25, F11, F12).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { Server } from "bun"
import { app } from "~/app"
import { sql } from "~/db"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { createServer, type WsData } from "~/lib/server"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { liveDesktopConnections } from "./presence"

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms
  let v = await fn()
  while (!ok(v) && Date.now() < end) {
    await Bun.sleep(25)
    v = await fn()
  }
  return v
}

describe("node binding over the real WebSocket server (P4)", () => {
  let owner: minimal.Session
  let other: minimal.Session
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  let server: Server<WsData>
  const clients: WebSocket[] = []

  const call = (session: minimal.Session, path: string, method: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${session.bearer}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  async function enable(session: minimal.Session) {
    const deviceId = `d.${crypto.randomUUID()}`
    const res = await call(session, "/api/nodes", "POST", { deviceId })
    const d = ((await res.json()) as { data: { node: { id: string }; credential: string } }).data
    return { nodeId: d.node.id, credential: d.credential, deviceId }
  }

  /** A desktop connection of `session`, saying hello with these fields. */
  async function connect(session: minimal.Session, hello: Record<string, unknown>) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?as=${session.userId}`)
    clients.push(ws)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(e)
    })
    ws.send(
      JSON.stringify({
        type: "hello",
        clientKind: "desktop_app",
        lastActiveAt: Date.now(),
        ...hello,
      }),
    )
    // presence_sync is the last frame of a processed hello.
    await new Promise<void>((resolve) => {
      ws.onmessage = (ev) => {
        if (JSON.parse(String(ev.data)).type === "presence_sync") resolve()
      }
    })
    return ws
  }

  const openSessions = (nodeId: string) =>
    sql<Array<{ disconnected_at: Date | null; close_reason: string | null }>>`
      SELECT disconnected_at, close_reason FROM kernel.node_connections WHERE node_id = ${nodeId}`

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    other = await minimal.session(org.id)
    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
    const sessions = new Map([owner, other].map((s) => [s.userId, s]))
    server = await createServer(
      { fetch: () => new Response("not found", { status: 404 }) },
      {
        wsManager: manager,
        port: 0,
        publicDir: "/nonexistent-public-dir",
        logPrefix: "ws-node-test",
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
  })

  beforeEach(async () => {
    for (const ws of clients.splice(0)) ws.close()
    await Bun.sleep(50)
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
  })

  afterAll(async () => {
    for (const ws of clients.splice(0)) ws.close()
    await Bun.sleep(50)
    server?.stop(true)
    if (owner) await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  // S53 (D29), batch-3 F3: the hello's `nodeSessionEvents: "top"` must reach
  // the socket's filter through server.ts; the manager's own test calls
  // setNodeSessionScope directly, which would hide a server that dropped it.
  it("D29: a hello with nodeSessionEvents top keeps a subagent's frames off that socket; a hello without it still gets them", async () => {
    const top = await connect(owner, { nodeSessionEvents: "top" })
    const all = await connect(owner, {})
    const got = new Map<WebSocket, Array<string | null>>([
      [top, []],
      [all, []],
    ])
    for (const [ws, frames] of got) {
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data))
        if (m.type === "event" && m.payload?.entity === "node_session_event") {
          frames.push(m.payload.data.parentToolUseId ?? null)
        }
      }
    }
    const frame = (seq: number, parentToolUseId?: string) => ({
      app: "kernel",
      entity: "node_session_event",
      action: "create",
      entityId: "s1",
      orgId: owner.orgId,
      data: {
        ownerUserId: owner.userId,
        sessionId: "s1",
        seq,
        type: "assistant_text",
        ...(parentToolUseId ? { parentToolUseId } : {}),
      },
    })
    await manager.broadcast(frame(1, "tu_a") as never)
    await manager.broadcast(frame(2) as never)
    // Frames reach a socket in order: once the top-level one is in, the
    // subagent's would be too.
    await until(
      async () => [...got.values()].every((f) => f.includes(null)),
      (v) => v,
    )
    expect(got.get(top)).toEqual([null])
    expect(got.get(all)).toEqual(["tu_a", null])
  })

  it("a hello with the node's credential for its deviceId opens the interval and makes it live; close ends it", async () => {
    const n = await enable(owner)
    const ws = await connect(owner, { deviceId: n.deviceId, nodeCredential: n.credential })
    const opened = await until(
      () => openSessions(n.nodeId),
      (rows) => rows.length === 1,
    )
    expect(opened).toHaveLength(1)
    expect(opened[0].disconnected_at).toBeNull()
    const live = await liveDesktopConnections(owner.orgId, owner.userId)
    expect(live.has(n.nodeId)).toBe(true)

    ws.close()
    const closed = await until(
      () => openSessions(n.nodeId),
      (rows) => rows[0]?.disconnected_at !== null,
    )
    expect(closed[0].disconnected_at).not.toBeNull()
    expect(closed[0].close_reason).toBe("disconnect")
  })

  it("a desktop hello without a credential is a plain desktop connection, not the node", async () => {
    const n = await enable(owner)
    await connect(owner, { deviceId: n.deviceId })
    await Bun.sleep(100)
    expect(await openSessions(n.nodeId)).toHaveLength(0)
    expect((await liveDesktopConnections(owner.orgId, owner.userId)).has(n.nodeId)).toBe(false)
  })

  it("another user's session presenting the credential binds nothing", async () => {
    const n = await enable(owner)
    await connect(other, { deviceId: n.deviceId, nodeCredential: n.credential })
    await Bun.sleep(100)
    expect(await openSessions(n.nodeId)).toHaveLength(0)
    expect((await liveDesktopConnections(other.orgId, other.userId)).size).toBe(0)
  })

  it("the credential presented from another install (deviceId) binds nothing", async () => {
    const n = await enable(owner)
    await connect(owner, { deviceId: `d.${crypto.randomUUID()}`, nodeCredential: n.credential })
    await Bun.sleep(100)
    expect(await openSessions(n.nodeId)).toHaveLength(0)
  })
})
