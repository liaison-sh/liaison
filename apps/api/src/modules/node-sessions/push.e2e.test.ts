// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4-T08: a node batch that opens a session's first pending request sends
// exactly one push to the owner, end to end through the real ingest route and
// the boot wiring (`registerEventSubscribers`). Only the wire (`send`) is a
// double: the router, the owner's locale, the push token rows and the waiting
// hook are the real ones.
//
//   text only: no push -> a permission_request for Bash whose input holds a
//   canary: one push naming Bash, no canary -> a question while one is open:
//   no push (1 -> 2) -> both decided (0) -> a new question whose header is a
//   canary: a second push, same collapse id, "a question", no header. A
//   non-owner's device never receives anything.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { NodeSessionEventIn } from "@liaison/shared"
import { app } from "~/app"
import { sql } from "~/db"
import { _getGlobalHandlerCount } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { onNodeConnectionHello } from "~/modules/nodes/hooks"
import { PushFanoutTestAccess } from "~/modules/push/fanout-consumer"
import { NodeSessionPushTestAccess } from "~/modules/push/node-session-push"
import type { PushPayload, PushSendResult, PushTokenRow } from "~/modules/push/types"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MODEL = "claude-haiku-4-5"
const FOLDER = { name: "push-sample", path: "/Users/owner/code/push-sample" }
const TOOL_CANARY = "CANARY-tool-input-7f3a"
const HEADER_CANARY = "CANARY-question-header-91c2"
const OWNER_TOKEN = `push-e2e-owner-${crypto.randomUUID()}`
const OTHER_TOKEN = `push-e2e-other-${crypto.randomUUID()}`

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

describe("the session push through the real ingest route (P4-T08)", () => {
  let owner: minimal.Session
  let other: minimal.Session
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  const sockets: FakeWs[] = []
  const sends: Array<{ token: PushTokenRow; payload: PushPayload }> = []

  const call = (path: string, method: string, body?: unknown, cred?: string) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${owner.bearer}`,
        ...(cred ? { "X-Node-Credential": cred, "X-Liaison-Node-Protocol": "2" } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const json = async (res: Response) => (await res.json()) as any

  const node = {
    nodeId: "",
    credential: "",
    deviceId: `d.${crypto.randomUUID()}`,
    jobId: "",
    gen: 0,
    batchNo: 0,
  }

  let tick = Date.parse("2026-10-14T09:00:00.000Z")
  const ev = (type: NodeSessionEventIn["type"], payload: Record<string, unknown>) => {
    tick += 100
    return { at: new Date(tick).toISOString(), type, payload } as NodeSessionEventIn
  }

  async function postBatch(sessionId: string, events: NodeSessionEventIn[]) {
    node.batchNo++
    const res = await call(
      `/api/node/sessions/${sessionId}/events`,
      "POST",
      { jobId: node.jobId, leaseGeneration: node.gen, batchNo: node.batchNo, events },
      node.credential,
    )
    expect(res.status).toBe(200)
  }

  /** The hook runs after the response; give it time, then read what was sent. */
  async function sendsAfter(expected: number): Promise<typeof sends> {
    for (let i = 0; i < 100 && sends.length < expected; i++) await Bun.sleep(20)
    await Bun.sleep(150)
    return sends
  }

  const row = async (sessionId: string) =>
    (await json(await call(`/api/me/node-sessions/${sessionId}`, "GET"))).data

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    other = await minimal.session(org.id)
    await sql`INSERT INTO kernel.user_preferences (user_id, language)
      VALUES (${owner.userId}, 'en')
      ON CONFLICT (user_id) DO UPDATE SET language = EXCLUDED.language`
    await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${owner.orgId}, ${owner.userId}, 'ios', ${OWNER_TOKEN})`
    await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${owner.orgId}, ${other.userId}, 'ios', ${OTHER_TOKEN})`

    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
    expect(_getGlobalHandlerCount()).toBe(0)
    // The boot wiring: this is what subscribes the push to the waiting hook.
    registerEventSubscribers(manager)
    PushFanoutTestAccess.resetDedupe()
    NodeSessionPushTestAccess.setDeps({
      send: async (token: PushTokenRow, payload: PushPayload): Promise<PushSendResult> => {
        sends.push({ token, payload })
        return { kind: "sent" }
      },
      badgeCount: async () => 1,
    })
  })

  afterAll(async () => {
    NodeSessionPushTestAccess.setDeps({})
    PushFanoutTestAccess.resetDedupe()
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(20)
    if (owner) {
      await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.user_preferences WHERE user_id IN (${owner.userId}, ${other.userId})`
    }
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("S12: a waiting edge fired from the node batch route pushes once: one push per 0 -> >0 transition, naming the request's type and tool, never its input", async () => {
    // ── an online node with a shared folder; a session claimed and started ──
    const enabled = await call("/api/nodes", "POST", { deviceId: node.deviceId, name: "Mac" })
    expect(enabled.status).toBe(201)
    const d = (await json(enabled)).data
    node.nodeId = d.node.id
    node.credential = d.credential
    const caps = await call(
      `/api/nodes/${node.nodeId}/capabilities`,
      "PUT",
      {
        sharedFolders: [{ ...FOLDER, kind: "repo" }],
        models: [{ id: MODEL, label: "Haiku 4.5" }],
      },
      node.credential,
    )
    expect(caps.status).toBe(200)
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

    const started = await call("/api/me/node-sessions", "POST", {
      prompt: "Fix the sum bug",
      folderName: FOLDER.name,
      model: MODEL,
    })
    expect(started.status).toBe(201)
    const sessionId = (await json(started)).data.id as string
    const title = (await row(sessionId)).title as string
    node.jobId = (await row(sessionId)).jobId as string
    const claimed = await call(`/api/nodes/jobs/${node.jobId}/claim`, "POST", {}, node.credential)
    expect(claimed.status).toBe(200)
    node.gen = (await json(claimed)).data.leaseGeneration
    const run = await call(
      `/api/nodes/jobs/${node.jobId}/started`,
      "POST",
      { leaseGeneration: node.gen },
      node.credential,
    )
    expect(run.status).toBe(200)

    // ── batch 1: text only, no push ──
    await postBatch(sessionId, [
      ev("system", { subtype: "start", text: "started", data: { sessionId: "sdk-push-1" } }),
      ev("user_message", { text: "Fix the sum bug" }),
      ev("assistant_text", { text: "Looking at the tests." }),
    ])
    expect(await sendsAfter(0)).toHaveLength(0)

    // ── batch 2: the first request opens: exactly one push ──
    await postBatch(sessionId, [
      ev("tool_call", { id: "toolu_b1", name: "Bash", input: { command: `echo ${TOOL_CANARY}` } }),
      ev("permission_request", {
        requestId: "req-1",
        tool: "Bash",
        input: { command: `echo ${TOOL_CANARY}` },
        reason: `wants to run echo ${TOOL_CANARY}`,
      }),
    ])
    expect((await row(sessionId)).status).toBe("waiting")
    const first = await sendsAfter(1)
    expect(first).toHaveLength(1)
    expect(first[0].token.token).toBe(OWNER_TOKEN)
    expect(first[0].payload).toMatchObject({
      type: "node_session",
      sessionId,
      deepLink: `liaison://session/${sessionId}`,
      collapseId: sessionId,
      title: "Session needs you",
      body: `${title}: permission for Bash`,
    })
    expect(JSON.stringify(first[0].payload)).not.toContain(TOOL_CANARY)

    // ── batch 3: a question while one is open (1 -> 2): no push ──
    await postBatch(sessionId, [
      ev("question", {
        requestId: "q-1",
        questions: [{ header: "Which file?", question: "Which file?", options: [] }],
      }),
    ])
    expect((await row(sessionId)).pendingCount).toBe(2)
    expect(await sendsAfter(1)).toHaveLength(1)

    // ── both decided: back to none, running ──
    await postBatch(sessionId, [
      ev("decision", { requestId: "req-1", outcome: "allow", by: "owner" }),
      ev("decision", { requestId: "q-1", outcome: "answered", by: "owner" }),
    ])
    const settled = await row(sessionId)
    expect(settled.pendingCount).toBe(0)
    expect(settled.status).toBe("running")
    expect(await sendsAfter(1)).toHaveLength(1)

    // ── batch 4: a new question whose header is a canary: the second push ──
    await postBatch(sessionId, [
      ev("question", {
        requestId: "q-2",
        questions: [{ header: HEADER_CANARY, question: `Pick ${HEADER_CANARY}?`, options: [] }],
      }),
    ])
    const second = await sendsAfter(2)
    expect(second).toHaveLength(2)
    expect(second[1].token.token).toBe(OWNER_TOKEN)
    expect(second[1].payload).toMatchObject({
      type: "node_session",
      sessionId,
      collapseId: sessionId,
      body: `${title}: a question`,
    })
    expect(second[1].payload.notificationId).not.toBe(second[0].payload.notificationId)
    expect(JSON.stringify(second[1].payload)).not.toContain(HEADER_CANARY)

    // ── the other member's device received nothing ──
    expect(sends.some((s) => s.token.token === OTHER_TOKEN)).toBe(false)
  })
})
