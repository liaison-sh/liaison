// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T17, the morning gate: steering a session over the whole server path,
// through the real routes, with a scripted node and the owner's socket on the
// real event bus and WebSocket manager. Nothing is mocked between them.
//
//   start -> claim -> a batch with a permission_request: waiting, the waiting
//   hook fires once -> the owner allows -> the node is woken, pulls, posts the
//   decision and command_applied: acked, running -> the owner's message: wake,
//   pull, user_message {commandId} + command_applied: acked -> result: done ->
//   a message on done: exactly one resume run, whose claim answers resume ->
//   the node's connection closes: paused -> it reconnects and reports alive:
//   running -> it reports nothing: the open request expires, the run is
//   interrupted and resumes -> the owner's Stop on a running session: the node
//   fails the run `stopped`: the session is stopped. Throughout, the events the
//   owner's socket heard equal a pull of the log, and a pull after the
//   reconnect equals one before (S6).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import type { NodeSessionEvent, NodeSessionEventIn } from "@liaison/shared"
import { commandLine, parseCommandLine } from "@liaison/shared"
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
import { onNodeConnectionClosed } from "./lifecycle"
import { canonicalJson } from "./routes-node"
import type { NodeSessionRow } from "./store"
import { onSessionWaiting, type SessionWaitingRequest } from "./waiting-hook"

const MODEL = "claude-haiku-4-5"
const FOLDER = { name: "liaison-walk-sample", path: "/Users/owner/code/liaison-walk-sample" }

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

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")
const digest = (events: ReadonlyArray<NodeSessionEvent>) =>
  sha256(
    events.map((e) => JSON.stringify([e.seq, e.type, sha256(canonicalJson(e.payload))])).join("\n"),
  )

describe("steering through the real routes (P3-T17, the morning gate)", () => {
  let owner: minimal.Session
  let agentId: string
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  const sockets: FakeWs[] = []
  const waiting: Array<{ row: NodeSessionRow; request: SessionWaitingRequest }> = []
  let offWaiting: () => void

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

  /** The scripted node: its credential, its socket, and its run's posting state. */
  const node = {
    nodeId: "",
    credential: "",
    deviceId: `d.${crypto.randomUUID()}`,
    ws: null as FakeWs | null,
    jobId: "",
    gen: 0,
    batchNo: 0,
  }

  async function connectNode() {
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

  async function claimAndStart(jobId: string) {
    const claimed = await call(`/api/nodes/jobs/${jobId}/claim`, "POST", {}, node.credential)
    expect(claimed.status).toBe(200)
    const claim = (await json(claimed)).data
    node.jobId = jobId
    node.gen = claim.leaseGeneration
    node.batchNo = 0
    const started = await call(
      `/api/nodes/jobs/${jobId}/started`,
      "POST",
      { leaseGeneration: node.gen },
      node.credential,
    )
    expect(started.status).toBe(200)
    return claim
  }

  let tick = Date.parse("2026-10-14T08:00:00.000Z")
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

  /** What the node does on a wake: pull, and write each command as its stdin line. */
  async function pullCommands() {
    const res = await call(
      "/api/node/sessions/commands?unacked=1",
      "GET",
      undefined,
      node.credential,
    )
    expect(res.status).toBe(200)
    const commands = (await json(res)).data.commands as Array<{
      commandId: string
      sessionId: string
      jobId: string
      seq: number
      type: string
      payload: Record<string, unknown>
    }>
    // The line the shell writes parses back to the same command (T01).
    return commands.map((c) => {
      const line = commandLine({
        type: "command",
        commandId: c.commandId,
        seq: c.seq,
        command: { type: c.type, payload: c.payload } as never,
      })
      const parsed = parseCommandLine(line)
      expect(parsed?.commandId).toBe(c.commandId)
      return c
    })
  }

  const wakes = (sessionId: string) =>
    (node.ws?.frames ?? []).filter(
      (f) => f.type === "node_session_command" && f.sessionId === sessionId,
    )

  const command = (sessionId: string, type: string, payload: unknown) =>
    call(`/api/me/node-sessions/${sessionId}/commands`, "POST", { type, payload })

  const row = async (sessionId: string) =>
    (await json(await call(`/api/me/node-sessions/${sessionId}`, "GET"))).data

  async function pullAll(sessionId: string): Promise<NodeSessionEvent[]> {
    const out: NodeSessionEvent[] = []
    for (let page = 0; page < 100; page++) {
      const after = out.at(-1)?.seq ?? 0
      const res = await call(
        `/api/me/node-sessions/${sessionId}/events?after=${after}&limit=7`,
        "GET",
      )
      const { events } = (await json(res)).data as { events: NodeSessionEvent[] }
      if (events.length === 0) return out
      out.push(...events)
    }
    throw new Error("pull did not end")
  }

  const heardBy = (ws: FakeWs, sessionId: string) =>
    ws.frames
      .filter(
        (f) =>
          f.type === "event" &&
          f.payload?.entity === "node_session_event" &&
          f.payload?.data?.sessionId === sessionId,
      )
      .map((f) => {
        const { ownerUserId: _o, sessionId: _s, ...e } = f.payload.data
        return e as NodeSessionEvent
      })

  const commandRow = async (id: string) =>
    (
      await sql<Array<{ acked_at: Date | null; outcome: string | null; job_id: string | null }>>`
        SELECT acked_at, outcome, job_id FROM kernel.node_session_commands WHERE id = ${id}`
    )[0]

  async function cleanup() {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(20)
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
    expect(_getGlobalHandlerCount()).toBe(0)
    registerEventSubscribers(manager)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@steer-${crypto.randomUUID().slice(0, 8)}`}, 'Olive',
              '["*"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
    offWaiting = onSessionWaiting((r, request) => void waiting.push({ row: r, request }))
  })

  afterAll(async () => {
    offWaiting?.()
    if (owner) {
      await cleanup()
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  it("permission, message, result, resume, pause, report, dead run, stop", async () => {
    // ── a node with a shared folder, online; the owner's browser tab ──
    const enabled = await call("/api/nodes", "POST", { deviceId: node.deviceId, name: "Mac" })
    expect(enabled.status).toBe(201)
    const d = (await json(enabled)).data
    node.nodeId = d.node.id
    node.credential = d.credential
    expect(
      (
        await call(
          `/api/nodes/${node.nodeId}/capabilities`,
          "PUT",
          {
            sharedFolders: [{ ...FOLDER, kind: "repo" }],
            models: [{ id: MODEL, label: "Haiku 4.5" }],
          },
          node.credential,
        )
      ).status,
    ).toBe(200)
    await connectNode()
    const tab = fakeWs()
    sockets.push(tab)
    manager.addConnection(owner.userId, tab, ["*"], owner.orgId)

    // ── start from the app, claim, run ──
    const started = await call("/api/me/node-sessions", "POST", {
      prompt: "Run the tests, then summarise the README",
      folderName: FOLDER.name,
      model: MODEL,
    })
    expect(started.status).toBe(201)
    const sessionId = (await json(started)).data.id as string
    const firstJob = (await row(sessionId)).jobId as string
    await claimAndStart(firstJob)
    await postBatch(sessionId, [
      ev("system", { subtype: "start", text: "started", data: { sessionId: "sdk-steer-1" } }),
      ev("user_message", { text: "Run the tests, then summarise the README" }),
      ev("tool_call", { id: "toolu_w1", name: "Write", input: { file_path: "/tmp/out.txt" } }),
      ev("permission_request", {
        requestId: "req-1",
        tool: "Write",
        input: { file_path: "/tmp/out.txt" },
        reason: "outside the folder",
      }),
    ])
    expect((await row(sessionId)).status).toBe("waiting")
    expect(waiting).toHaveLength(1)
    expect(waiting[0].request).toMatchObject({
      requestId: "req-1",
      type: "permission_request",
      tool: "Write",
    })

    // ── the owner allows: the node is woken, pulls, applies ──
    const allow = await command(sessionId, "permission_decision", {
      requestId: "req-1",
      allow: true,
      scope: "once",
    })
    expect(allow.status).toBe(201)
    const allowId = (await json(allow)).data.commandId as string
    expect(wakes(sessionId)).toHaveLength(1)
    const pulled1 = await pullCommands()
    expect(pulled1.map((c) => [c.commandId, c.type, c.jobId])).toEqual([
      [allowId, "permission_decision", firstJob],
    ])
    await postBatch(sessionId, [
      ev("decision", { requestId: "req-1", outcome: "allow", by: "owner" }),
      ev("command_applied", {
        commandId: allowId,
        type: "permission_decision",
        outcome: "applied",
      }),
      ev("tool_result", { id: "toolu_w1", isError: false, output: "ok" }),
    ])
    expect(await commandRow(allowId)).toMatchObject({ outcome: "applied", job_id: firstJob })
    expect((await row(sessionId)).status).toBe("running")
    expect(await pullCommands()).toEqual([])

    // ── a message mid-run ──
    const msg = await command(sessionId, "message", { text: "Also list the .claude folder" })
    const msgId = (await json(msg)).data.commandId as string
    expect(wakes(sessionId)).toHaveLength(2)
    expect((await pullCommands()).map((c) => c.commandId)).toEqual([msgId])
    await postBatch(sessionId, [
      ev("user_message", { text: "Also list the .claude folder", commandId: msgId }),
      ev("command_applied", { commandId: msgId, type: "message", outcome: "applied" }),
      ev("assistant_text", { text: "Tests pass; .claude holds settings.json." }),
      ev("result", { text: "Tests pass.", isError: false, subtype: "success" }),
    ])
    expect((await commandRow(msgId)).outcome).toBe("applied")
    const done = await call(
      `/api/nodes/jobs/${firstJob}/result`,
      "POST",
      { leaseGeneration: node.gen, text: "Tests pass.", completion: { by: "session" } },
      node.credential,
    )
    expect(done.status).toBe(201)
    expect((await row(sessionId)).status).toBe("done")

    // ── a message on done: exactly one resume run ──
    const again = await command(sessionId, "message", { text: "What did you change?" })
    const againId = (await json(again)).data.commandId as string
    const resumed = await row(sessionId)
    expect(resumed.status).toBe("queued")
    const secondJob = resumed.jobId as string
    expect(secondJob).not.toBe(firstJob)
    const jobs = await sql<Array<{ id: string }>>`
      SELECT id FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    expect(jobs).toHaveLength(2)
    const claim2 = await claimAndStart(secondJob)
    expect(claim2.session.resume).toEqual({
      sdkSessionId: "sdk-steer-1",
      after: "message",
      commandId: againId,
    })
    await postBatch(sessionId, [
      ev("resumed", { after: "message" }),
      ev("user_message", { text: "What did you change?", commandId: againId }),
      ev("command_applied", { commandId: againId, type: "message", outcome: "applied" }),
    ])
    expect(await commandRow(againId)).toMatchObject({ outcome: "applied", job_id: secondJob })

    // ── the node's connection closes: paused; back and alive: running ──
    await flushEventHandlers()
    const beforeOffline = await pullAll(sessionId)
    manager.removeConnection(node.ws as FakeWs)
    await Bun.sleep(20)
    await onNodeConnectionClosed({ orgId: owner.orgId, userId: owner.userId, nodeId: node.nodeId })
    expect((await row(sessionId)).status).toBe("paused")
    await connectNode()
    const alive = await call(
      "/api/node/sessions/report",
      "POST",
      { sessions: [{ id: sessionId, jobId: secondJob, leaseGeneration: node.gen, alive: true }] },
      node.credential,
    )
    expect(alive.status).toBe(200)
    expect((await json(alive)).data.sessions).toEqual([
      { id: sessionId, lastBatchNo: node.batchNo, lastSeq: (await row(sessionId)).lastSeq },
    ])
    expect((await row(sessionId)).status).toBe("running")
    // S6: a pull after the reconnect answers the same log up to where it was.
    const afterReconnect = await pullAll(sessionId)
    expect(digest(afterReconnect.slice(0, beforeOffline.length))).toBe(digest(beforeOffline))

    // ── the process died (app quit): the report names nothing ──
    await postBatch(sessionId, [
      ev("permission_request", {
        requestId: "req-2",
        tool: "Bash",
        input: { command: "rm x" },
        reason: "",
      }),
    ])
    expect((await row(sessionId)).status).toBe("waiting")
    expect(waiting).toHaveLength(2)
    await sql`UPDATE kernel.node_jobs SET claimed_at = now() - interval '5 minutes' WHERE id = ${secondJob}`
    const dead = await call("/api/node/sessions/report", "POST", { sessions: [] }, node.credential)
    expect(dead.status).toBe(200)
    const log = await pullAll(sessionId)
    expect(
      log.find((e) => e.type === "decision" && e.payload.requestId === "req-2")?.payload,
    ).toEqual({
      requestId: "req-2",
      outcome: "expired",
      by: "process_exit",
    })
    const [interrupted] = await sql<Array<{ status: string }>>`
      SELECT status FROM kernel.node_jobs WHERE id = ${secondJob}`
    expect(interrupted.status).toBe("interrupted")
    const third = await row(sessionId)
    expect(third.status).toBe("queued")
    const thirdJob = third.jobId as string
    const claim3 = await claimAndStart(thirdJob)
    expect(claim3.session.resume).toMatchObject({ sdkSessionId: "sdk-steer-1", after: "offline" })

    // ── Stop on a running session: the node fails the run `stopped` ──
    expect((await row(sessionId)).status).toBe("running")
    const stop = await command(sessionId, "stop", {})
    const stopId = (await json(stop)).data.commandId as string
    expect((await pullCommands()).map((c) => c.commandId)).toEqual([stopId])
    await postBatch(sessionId, [
      ev("command_applied", { commandId: stopId, type: "stop", outcome: "applied" }),
    ])
    const failed = await call(
      `/api/nodes/jobs/${thirdJob}/fail`,
      "POST",
      { leaseGeneration: node.gen, error: "Stopped by you.", code: "stopped" },
      node.credential,
    )
    expect(failed.status).toBe(200)
    const stopped = await row(sessionId)
    expect(stopped.status).toBe("stopped")
    expect(stopped.endedAt).not.toBeNull()
    expect((await commandRow(stopId)).outcome).toBe("applied")
    // A second Stop is a noop, acked by the server.
    const twice = await command(sessionId, "stop", {})
    expect((await commandRow((await json(twice)).data.commandId)).outcome).toBe("noop")

    // ── what the owner's socket heard IS the log ──
    await flushEventHandlers()
    const whole = await pullAll(sessionId)
    expect(whole.map((e) => e.seq)).toEqual(whole.map((_, i) => i + 1))
    expect(digest(heardBy(tab, sessionId))).toBe(digest(whole))
    expect(whole.filter((e) => e.type === "status").map((e) => e.payload.status)).toEqual([
      "queued",
      "running",
      "waiting",
      "running",
      "done",
      "queued",
      "running",
      "paused",
      "running",
      "waiting",
      "running",
      "queued",
      "running",
      "stopped",
    ])
  })
})
