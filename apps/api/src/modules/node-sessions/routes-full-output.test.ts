// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T21 (S7, D3, R26, G12): "Show full output". The owner asks for a cut
// tool output; the session's node gets one connection frame and PUTs the
// spill file (or says it is gone); the owner reads it back. 202 while the
// node has not answered, 404 when the node is offline or the file is gone,
// 400 for a tool use id that is not one, 403 for another node's upload, and
// the ready ping reaches the owner only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { _getGlobalHandlerCount, flushEventHandlers } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { onNodeConnectionHello } from "~/modules/nodes/hooks"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const TOOL = "toolu_01ABCdef-ghi_9"

interface FakeWs {
  send(data: string): void
  close(): void
  readyState: number
  frames: Array<Record<string, any>>
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

describe("full output of a cut tool result (P3-T21)", () => {
  let owner: minimal.Session
  let member: minimal.Session
  let agentId: string
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  const sockets: FakeWs[] = []

  const call = (
    path: string,
    method: string,
    body?: unknown,
    opts: {
      cred?: string
      who?: minimal.Session
      raw?: string
      headers?: Record<string, string>
    } = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${(opts.who ?? owner).bearer}`,
        ...(opts.cred ? { "X-Node-Credential": opts.cred } : {}),
        "Content-Type": opts.raw !== undefined ? "text/plain" : "application/json",
        ...(opts.headers ?? {}),
      },
      body:
        opts.raw !== undefined ? opts.raw : body === undefined ? undefined : JSON.stringify(body),
    })
  const json = async (res: Response) => (await res.json()) as any

  interface Node {
    nodeId: string
    credential: string
    deviceId: string
    ws?: FakeWs
  }

  async function enable(): Promise<Node> {
    const deviceId = `d.${crypto.randomUUID()}`
    const res = await call("/api/nodes", "POST", { deviceId })
    const d = (await json(res)).data
    return { nodeId: d.node.id, credential: d.credential, deviceId }
  }

  async function connect(node: Node) {
    const ws = fakeWs()
    sockets.push(ws)
    manager.addConnection(owner.userId, ws, ["*"], owner.orgId)
    const entry = await manager.registerNotifyClient(ws, "desktop_app", Date.now(), {
      deviceId: node.deviceId,
    })
    await onNodeConnectionHello({
      orgId: owner.orgId,
      userId: owner.userId,
      deviceId: node.deviceId,
      connId: entry!.connId,
      nodeCredential: node.credential,
      bindConnection: (id) => manager.markNodeConnection(ws, id),
    })
    node.ws = ws
  }

  async function session(node: Node): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_sessions
        (org_id, owner_user_id, node_id, agent_id, source, config_kind, title, prompt, model,
         level, status)
      VALUES (${owner.orgId}, ${owner.userId}, ${node.nodeId}, ${agentId}, 'app', 'owner', 'S',
              'p', 'claude-haiku-4-5', 'strict', 'running')
      RETURNING id`
    return row.id
  }

  const ask = (sessionId: string, toolUseId = TOOL, who = owner) =>
    call(`/api/me/node-sessions/${sessionId}/full-output`, "POST", { toolUseId }, { who })
  const read = (sessionId: string, toolUseId = TOOL, who = owner) =>
    call(`/api/me/node-sessions/${sessionId}/full-output/${toolUseId}`, "GET", undefined, { who })
  const upload = (
    node: Node,
    sessionId: string,
    text: string,
    headers: Record<string, string> = {},
  ) =>
    call(`/api/node/sessions/${sessionId}/full-output/${TOOL}`, "PUT", undefined, {
      cred: node.credential,
      raw: text,
      headers,
    })

  async function cleanup() {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(20)
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    member = await minimal.session(org.id)
    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
    expect(_getGlobalHandlerCount()).toBe(0)
    registerEventSubscribers(manager)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@fo-${crypto.randomUUID().slice(0, 8)}`}, 'Olive',
              '["*"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
  })

  beforeEach(cleanup)

  afterAll(async () => {
    if (owner) {
      await cleanup()
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("the owner asks, the node gets one frame, PUTs 5 MiB, the owner GETs it; the ready ping reaches only the owner", async () => {
    const node = await enable()
    await connect(node)
    const sessionId = await session(node)
    const ownerTab = fakeWs()
    const memberTab = fakeWs()
    sockets.push(ownerTab, memberTab)
    manager.addConnection(owner.userId, ownerTab, ["*"], owner.orgId)
    manager.addConnection(member.userId, memberTab, ["*"], member.orgId)

    const asked = await ask(sessionId)
    expect(asked.status).toBe(202)
    expect(node.ws?.frames.filter((f) => f.type === "node_session_full_output")).toEqual([
      { type: "node_session_full_output", sessionId, toolUseId: TOOL },
    ])
    expect((await read(sessionId)).status).toBe(202)

    const big = `${"0123456789abcdef".repeat(5 * 65536)}\nlast line`
    const put = await upload(node, sessionId, big)
    expect(put.status).toBe(200)
    const got = await read(sessionId)
    expect(got.status).toBe(200)
    expect(got.headers.get("content-type")).toContain("text/plain")
    expect(await got.text()).toBe(big)

    await flushEventHandlers()
    const ready = (ws: FakeWs) =>
      ws.frames.filter(
        (f) => f.type === "event" && f.payload?.entity === "node_session_full_output",
      )
    expect(ready(ownerTab).map((f) => f.payload.data)).toEqual([
      { ownerUserId: owner.userId, sessionId, toolUseId: TOOL, state: "ready" },
    ])
    expect(ready(memberTab)).toEqual([])
    // Another member reads nothing.
    expect((await read(sessionId, TOOL, member)).status).toBe(404)
    expect((await ask(sessionId, TOOL, member)).status).toBe(404)
  })

  it("202 while pending; 404 offline; gone is 404", async () => {
    const node = await enable()
    const sessionId = await session(node)
    // Offline: refused at once, nothing pending.
    const offline = await ask(sessionId)
    expect(offline.status).toBe(404)
    expect((await json(offline)).error.code).toBe("node_offline")

    await connect(node)
    expect((await ask(sessionId)).status).toBe(202)
    expect((await read(sessionId)).status).toBe(202)
    // The node went offline before answering.
    manager.removeConnection(node.ws as FakeWs)
    await Bun.sleep(20)
    const lost = await read(sessionId)
    expect(lost.status).toBe(404)
    expect((await json(lost)).error.code).toBe("node_offline")

    await connect(node)
    expect((await ask(sessionId)).status).toBe(202)
    const gone = await upload(node, sessionId, "", { "X-Full-Output": "gone" })
    expect(gone.status).toBe(200)
    const after = await read(sessionId)
    expect(after.status).toBe(404)
    expect((await json(after)).error.code).toBe("gone")
  })

  it("a bad toolUseId is 400", async () => {
    const node = await enable()
    await connect(node)
    const sessionId = await session(node)
    expect((await ask(sessionId, "../etc/passwd")).status).toBe(400)
    expect((await ask(sessionId, "toolu_a/b")).status).toBe(400)
    expect((await read(sessionId, "nope")).status).toBe(400)
  })

  it("another node's PUT is 403; an unrequested PUT is 409", async () => {
    const node = await enable()
    const other = await enable()
    await connect(node)
    const sessionId = await session(node)
    expect((await upload(node, sessionId, "unasked")).status).toBe(409)
    expect((await ask(sessionId)).status).toBe(202)
    expect((await upload(other, sessionId, "not mine")).status).toBe(403)
    expect((await read(sessionId)).status).toBe(202)
  })
})
