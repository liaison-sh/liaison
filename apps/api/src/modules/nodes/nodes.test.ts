// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4 N-S T1 (S19, A25, F11, F12, F17): node registration and presence.
//
// - Enabling binds the node to (owner, the desktop's realtime deviceId) and
//   issues a node credential that only its hash is stored of.
// - The credential speaks for its node and its owner only: another user's
//   session presenting it is refused, and so is a revoked one (DELETE).
// - Online is the live presence registry, not a flag: a desktop connection
//   announcing the node's deviceId makes it online.
// - Connected intervals open on hello and close on disconnect; an interval
//   whose connection is gone from the registry is closed by the sweep.
// - RLS: another member never reads someone's nodes or node jobs; an admin
//   reads them.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { sql as q } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import * as eventBusModule from "~/infra/events/event-bus"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { onNodeConnectionHello } from "./hooks"
import { closeNodeSession, openNodeSessionForHello, sweepStaleNodeSessions } from "./presence"

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

describe("nodes: registration, credential, presence (P4 T1)", () => {
  let owner: minimal.Session
  let other: minimal.Session
  let admin: minimal.Session
  let manager: WebSocketManager
  let previous: WebSocketManager | null

  const call = (
    path: string,
    method: string,
    session: minimal.Session | null,
    body?: unknown,
    nodeCredential?: string,
  ) =>
    app.request(path, {
      method,
      headers: {
        ...(session ? { Authorization: `Bearer ${session.bearer}` } : {}),
        ...(nodeCredential ? { "X-Node-Credential": nodeCredential } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const data = async (res: Response) => ((await res.json()) as { data: any }).data

  async function enable(session: minimal.Session, deviceId = `d.${crypto.randomUUID()}`) {
    const res = await call("/api/nodes", "POST", session, {
      deviceId,
      name: "Studio Mac",
      os: "macos",
      appVersion: "0.1.19",
    })
    expect(res.status).toBe(201)
    const d = await data(res)
    return { nodeId: d.node.id as string, credential: d.credential as string, deviceId }
  }

  /** A desktop app's hello, as lib/server.ts runs it: register, then the node hook. */
  async function connectDesktop(
    session: minimal.Session,
    deviceId: string,
    nodeCredential: string | undefined,
  ) {
    const ws = fakeWs()
    manager.addConnection(session.userId, ws, ["*"], session.orgId)
    const entry = (await manager.registerNotifyClient(ws, "desktop_app", Date.now(), {
      deviceId,
    }))!
    const opened = await onNodeConnectionHello({
      orgId: session.orgId,
      userId: session.userId,
      deviceId,
      connId: entry.connId,
      nodeCredential,
      bindConnection: (nodeId) => manager.markNodeConnection(ws, nodeId),
    })
    return { ws, entry, opened }
  }

  const onlineOf = async (nodeId: string) => {
    const me = await data(await call("/api/nodes/me", "GET", owner))
    return me.nodes.find((x: { id: string }) => x.id === nodeId).online as boolean
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    other = await minimal.session(org.id)
    admin = await minimal.session(org.id, { role: "admin" })
    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
  })

  beforeEach(async () => {
    for (const s of [owner, other, admin]) {
      await sql`DELETE FROM kernel.node_jobs WHERE owner_user_id = ${s.userId}`
      await sql`DELETE FROM kernel.nodes WHERE owner_user_id = ${s.userId}`
    }
  })

  afterAll(async () => {
    if (owner) {
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    }
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("enables a node bound to the deviceId and stores only the credential's hash", async () => {
    const n = await enable(owner)
    expect(n.credential.startsWith("lnn_")).toBe(true)
    const [row] = await sql<
      Array<{ device_id: string; owner_user_id: string; credential_hash: string; enabled: boolean }>
    >`SELECT device_id, owner_user_id, credential_hash, enabled FROM kernel.nodes WHERE id = ${n.nodeId}`
    expect(row.device_id).toBe(n.deviceId)
    expect(row.owner_user_id).toBe(owner.userId)
    expect(row.enabled).toBe(true)
    expect(row.credential_hash).not.toBe(n.credential)
    expect(row.credential_hash).not.toContain(n.credential.slice(4, 20))
    expect(row.credential_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("re-enabling the same install rotates the credential: the old one is refused", async () => {
    const first = await enable(owner)
    const second = await enable(owner, first.deviceId)
    expect(second.nodeId).toBe(first.nodeId)
    expect((await call("/api/nodes/self", "GET", owner, undefined, first.credential)).status).toBe(
      401,
    )
    expect((await call("/api/nodes/self", "GET", owner, undefined, second.credential)).status).toBe(
      200,
    )
  })

  it("refuses another user's session presenting the owner's node credential", async () => {
    const n = await enable(owner)
    const mine = await call("/api/nodes/self", "GET", owner, undefined, n.credential)
    expect(mine.status).toBe(200)
    expect((await data(mine)).id).toBe(n.nodeId)
    const theirs = await call("/api/nodes/self", "GET", other, undefined, n.credential)
    expect(theirs.status).toBe(403)
    expect((await call("/api/nodes/self", "GET", owner, undefined, "lnn_forged")).status).toBe(401)
    expect((await call("/api/nodes/self", "GET", owner)).status).toBe(401)
  })

  it("DELETE revokes the node credential (F17) and the node leaves GET /me", async () => {
    const n = await enable(owner)
    const del = await call(`/api/nodes/${n.nodeId}`, "DELETE", owner)
    expect(del.status).toBe(200)
    expect((await call("/api/nodes/self", "GET", owner, undefined, n.credential)).status).toBe(401)
    const [row] = await sql<Array<{ credential_hash: string | null; revoked_at: Date | null }>>`
      SELECT credential_hash, revoked_at FROM kernel.nodes WHERE id = ${n.nodeId}`
    expect(row.credential_hash).toBeNull()
    expect(row.revoked_at).not.toBeNull()
    const me = await data(await call("/api/nodes/me", "GET", owner))
    expect(me.nodes.map((x: { id: string }) => x.id)).not.toContain(n.nodeId)
  })

  it("PATCH renames and disables the owner's node; another user cannot touch it", async () => {
    const n = await enable(owner)
    const res = await call(`/api/nodes/${n.nodeId}`, "PATCH", owner, {
      name: "Office",
      enabled: false,
    })
    expect(res.status).toBe(200)
    const [row] = await sql<Array<{ name: string; enabled: boolean }>>`
      SELECT name, enabled FROM kernel.nodes WHERE id = ${n.nodeId}`
    expect(row).toEqual({ name: "Office", enabled: false })
    expect((await call(`/api/nodes/${n.nodeId}`, "PATCH", other, { name: "x" })).status).toBe(404)
    expect((await call(`/api/nodes/${n.nodeId}`, "DELETE", other)).status).toBe(404)
  })

  it("PATCH a node publishes change node to its owner (S18)", async () => {
    const n = await enable(owner)
    const spy = spyOn(eventBusModule, "broadcastEphemeral")
    try {
      expect(
        (await call(`/api/nodes/${n.nodeId}`, "PATCH", owner, { name: "Office" })).status,
      ).toBe(200)
      const frames = spy.mock.calls
        .map((c) => c[0])
        .filter((e) => e.app === "kernel" && e.entity === "node")
      expect(frames.map((e) => e.data)).toEqual([
        { ownerUserId: owner.userId, nodeId: n.nodeId, change: "node" },
      ])
    } finally {
      spy.mockRestore()
    }
  })

  it("PATCH sets the live caps and refuses 0 and background above live (P3-T18, D35)", async () => {
    const n = await enable(owner)
    const me0 = await data(await call("/api/nodes/me", "GET", owner))
    expect(me0.nodes.find((x: { id: string }) => x.id === n.nodeId)).toMatchObject({
      maxLiveSessions: 4,
      maxLiveBackground: 2,
    })
    const set = await call(`/api/nodes/${n.nodeId}`, "PATCH", owner, {
      maxLiveSessions: 2,
      maxLiveBackground: 1,
    })
    expect(set.status).toBe(200)
    expect((await data(set)).node).toMatchObject({ maxLiveSessions: 2, maxLiveBackground: 1 })
    for (const body of [
      { maxLiveSessions: 0 },
      { maxLiveSessions: 17 },
      { maxLiveBackground: -1 },
      { maxLiveSessions: 2, maxLiveBackground: 3 },
      // Above the stored live cap (2).
      { maxLiveBackground: 3 },
    ]) {
      const res = await call(`/api/nodes/${n.nodeId}`, "PATCH", owner, body)
      expect({ body, status: res.status }).toEqual({ body, status: 400 })
    }
    const [row] = await sql<Array<{ max_live_sessions: number; max_live_background: number }>>`
      SELECT max_live_sessions, max_live_background FROM kernel.nodes WHERE id = ${n.nodeId}`
    expect(row).toEqual({ max_live_sessions: 2, max_live_background: 1 })
  })

  it("enables without a name (the app sends deviceId and os): a default name", async () => {
    const res = await call("/api/nodes", "POST", owner, {
      deviceId: `d.${crypto.randomUUID()}`,
      os: "macos",
    })
    expect(res.status).toBe(201)
    const d = await data(res)
    expect(d.node.name).toBe("Mac")
    expect(d.node.queue).toEqual({ queued: 0, running: 0 })
    expect(typeof d.credential).toBe("string")
  })

  it("online comes from live presence: a desktop hello presenting the node credential", async () => {
    const n = await enable(owner)
    expect(await onlineOf(n.nodeId)).toBe(false)
    const { ws } = await connectDesktop(owner, n.deviceId, n.credential)
    expect(await onlineOf(n.nodeId)).toBe(true)
    manager.removeConnection(ws)
    await Bun.sleep(50)
    expect(await onlineOf(n.nodeId)).toBe(false)
  })

  it("a hello with the node's deviceId but no, a rotated, or another install's credential is not the node", async () => {
    const n = await enable(owner)
    const bare = await connectDesktop(owner, n.deviceId, undefined)
    expect(bare.opened).toBeNull()
    expect(await onlineOf(n.nodeId)).toBe(false)
    // The credential of another install of the same user.
    const n2 = await enable(owner)
    const crossed = await connectDesktop(owner, n.deviceId, n2.credential)
    expect(crossed.opened).toBeNull()
    expect(await onlineOf(n.nodeId)).toBe(false)
    // A rotated credential.
    const rotated = await enable(owner, n.deviceId)
    const stale = await connectDesktop(owner, n.deviceId, n.credential)
    expect(stale.opened).toBeNull()
    const fresh = await connectDesktop(owner, n.deviceId, rotated.credential)
    expect(fresh.opened?.nodeId).toBe(n.nodeId)
    expect(await onlineOf(n.nodeId)).toBe(true)
    for (const c of [bare, crossed, stale, fresh]) manager.removeConnection(c.ws)
  })

  it("GET /me shows only the caller's nodes and their queued job count", async () => {
    const mine = await enable(owner)
    await enable(other)
    const threadId = await minimal.thread(owner.orgId, owner.userId)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@n-${crypto.randomUUID().slice(0, 8)}`}, 'Mine',
              '["*"]'::jsonb, ${owner.userId}) RETURNING id`
    await sql`INSERT INTO kernel.node_jobs (org_id, owner_user_id, agent_id, thread_id, source, prompt)
      VALUES (${owner.orgId}, ${owner.userId}, ${agent.id}, ${threadId}, 'chat', 'hello')`
    const me = await data(await call("/api/nodes/me", "GET", owner))
    expect(me.nodes.map((x: { id: string }) => x.id)).toEqual([mine.nodeId])
    expect(me.queuedJobs).toBe(1)
    expect(me.nodes[0].queue).toEqual({ queued: 1, running: 0 })
    await sql`DELETE FROM kernel.node_jobs WHERE agent_id = ${agent.id}`
    await sql`DELETE FROM kernel.agents WHERE id = ${agent.id}`
  })

  it("records connected intervals: open on hello, closed on disconnect", async () => {
    const n = await enable(owner)
    const { opened } = await connectDesktop(owner, n.deviceId, n.credential)
    expect(opened?.nodeId).toBe(n.nodeId)
    const open = await sql<Array<{ disconnected_at: Date | null }>>`
      SELECT disconnected_at FROM kernel.node_connections WHERE node_id = ${n.nodeId}`
    expect(open).toHaveLength(1)
    expect(open[0].disconnected_at).toBeNull()
    await closeNodeSession(owner.orgId, opened!.sessionId)
    const closed = await sql<Array<{ disconnected_at: Date | null; close_reason: string }>>`
      SELECT disconnected_at, close_reason FROM kernel.node_connections WHERE node_id = ${n.nodeId}`
    expect(closed[0].disconnected_at).not.toBeNull()
    expect(closed[0].close_reason).toBe("disconnect")
  })

  it("a hello from a device that is no enabled node opens nothing", async () => {
    const n = await enable(owner)
    await call(`/api/nodes/${n.nodeId}`, "PATCH", owner, { enabled: false })
    expect(
      await openNodeSessionForHello({
        orgId: owner.orgId,
        userId: owner.userId,
        deviceId: n.deviceId,
        connId: "x:1",
        nodeCredential: n.credential,
      }),
    ).toBeNull()
    // Another user's node credential, presented on the owner's connection.
    const other2 = await enable(other)
    expect(
      await openNodeSessionForHello({
        orgId: owner.orgId,
        userId: owner.userId,
        deviceId: other2.deviceId,
        connId: "x:2",
        nodeCredential: other2.credential,
      }),
    ).toBeNull()
  })

  it("the sweep closes an open interval whose connection left the presence registry (F12)", async () => {
    const n = await enable(owner)
    const live = await connectDesktop(owner, n.deviceId, n.credential)
    const liveSession = live.opened
    // A process that died: its interval is open, its connection is gone.
    const dead = await openNodeSessionForHello({
      orgId: owner.orgId,
      userId: owner.userId,
      deviceId: n.deviceId,
      connId: "dead-instance:conn",
      nodeCredential: n.credential,
    })
    const closed = await sweepStaleNodeSessions()
    expect(closed).toBeGreaterThanOrEqual(1)
    const rows = await sql<
      Array<{ id: string; disconnected_at: Date | null; close_reason: string }>
    >`
      SELECT id, disconnected_at, close_reason FROM kernel.node_connections WHERE node_id = ${n.nodeId}`
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(dead!.sessionId)?.close_reason).toBe("stale")
    expect(byId.get(liveSession!.sessionId)?.disconnected_at).toBeNull()
    manager.removeConnection(live.ws)
  })

  it("RLS: another member reads neither the nodes nor the node jobs; an admin reads both (F17)", async () => {
    const n = await enable(owner)
    const threadId = await minimal.thread(owner.orgId, owner.userId)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@r-${crypto.randomUUID().slice(0, 8)}`}, 'Mine',
              '["*"]'::jsonb, ${owner.userId}) RETURNING id`
    await sql`INSERT INTO kernel.node_jobs (org_id, owner_user_id, agent_id, thread_id, source, prompt, node_id)
      VALUES (${owner.orgId}, ${owner.userId}, ${agent.id}, ${threadId}, 'chat', 'secret prompt', ${n.nodeId})`
    const as = (userId: string, scopes: string[]) =>
      withRlsContext(
        { actorType: "user", userId, orgId: owner.orgId, scopes, dimensionGrants: {} },
        async (tx) => ({
          nodes: (await tx.execute(
            q`SELECT id FROM kernel.nodes WHERE org_id = ${owner.orgId}`,
          )) as unknown as unknown[],
          jobs: (await tx.execute(
            q`SELECT id FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`,
          )) as unknown as unknown[],
        }),
      )
    const otherView = await as(other.userId, ["kernel:threads:read"])
    expect(otherView.nodes).toHaveLength(0)
    expect(otherView.jobs).toHaveLength(0)
    const ownerView = await as(owner.userId, ["kernel:threads:read"])
    expect(ownerView.nodes.length).toBeGreaterThanOrEqual(1)
    expect(ownerView.jobs).toHaveLength(1)
    const adminView = await as(admin.userId, ["*"])
    expect(adminView.jobs).toHaveLength(1)
    // And nobody writes a job row through RLS, not even its owner: job writes
    // are the server's (privileged), so a status flip matches no row and an
    // insert is refused.
    const asWriter = (userId: string) => ({
      actorType: "user" as const,
      userId,
      orgId: owner.orgId,
      scopes: ["*"],
      dimensionGrants: {},
    })
    for (const userId of [other.userId, owner.userId]) {
      await withRlsContext(asWriter(userId), (tx) =>
        tx.execute(
          q`UPDATE kernel.node_jobs SET status = 'cancelled' WHERE agent_id = ${agent.id}`,
        ),
      )
    }
    const [still] = await sql<Array<{ status: string }>>`
      SELECT status FROM kernel.node_jobs WHERE agent_id = ${agent.id}`
    expect(still.status).toBe("queued")
    await expect(
      withRlsContext(asWriter(other.userId), (tx) =>
        tx.execute(q`INSERT INTO kernel.node_jobs (org_id, owner_user_id, agent_id, thread_id, source, prompt)
          VALUES (${owner.orgId}, ${owner.userId}, ${agent.id}, ${threadId}, 'chat', 'forged')`),
      ),
    ).rejects.toThrow()
    await sql`DELETE FROM kernel.node_jobs WHERE agent_id = ${agent.id}`
    await sql`DELETE FROM kernel.agents WHERE id = ${agent.id}`
  })
})
