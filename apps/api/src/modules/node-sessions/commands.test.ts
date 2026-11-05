// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T06 (C5, D36, S9, S16): the owner's commands to a session. Each one gets
// the next per-session seq; with a live process it is stored and the node's
// connection is woken; with none, the server applies it under the row lock
// (a Stop on a queued session cancels its job, a message on an ended session
// starts exactly one resume run, a raise needs an attached session_raise).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { decodeJwt } from "jose"
import { app } from "~/app"
import { sql } from "~/db"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { signAccessToken } from "~/modules/auth/jwt"
import { onNodeConnectionHello } from "~/modules/nodes/hooks"
import { createNodeJob } from "~/modules/nodes/jobs"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { onSessionStatus, type SessionStatusChange } from "./waiting-hook"

const MODEL = "claude-haiku-4-5"

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

describe("node session commands (P3-T06)", () => {
  let owner: minimal.Session
  let other: minimal.Session
  let agentId: string
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  const sockets: FakeWs[] = []

  const call = (
    path: string,
    method: string,
    body?: unknown,
    opts: { cred?: string; bearer?: string; protocol?: number } = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${opts.bearer ?? owner.bearer}`,
        ...(opts.cred
          ? {
              "X-Node-Credential": opts.cred,
              "X-Liaison-Node-Protocol": String(opts.protocol ?? 2),
            }
          : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const json = async (res: Response) => (await res.json()) as any

  interface Node {
    nodeId: string
    credential: string
    ws: FakeWs
  }

  async function liveNode(): Promise<Node> {
    const deviceId = `d.${crypto.randomUUID()}`
    const res = await call("/api/nodes", "POST", { deviceId, name: "Studio Mac" })
    expect(res.status).toBe(201)
    const d = (await json(res)).data
    const nodeId = d.node.id as string
    const credential = d.credential as string
    const caps = await call(
      `/api/nodes/${nodeId}/capabilities`,
      "PUT",
      { sharedFolders: [], models: [{ id: MODEL, label: "Haiku 4.5" }] },
      { cred: credential },
    )
    expect(caps.status).toBe(200)
    const ws = fakeWs()
    sockets.push(ws)
    manager.addConnection(owner.userId, ws, ["*"], owner.orgId)
    const entry = await manager.registerNotifyClient(ws, "desktop_app", Date.now(), { deviceId })
    await onNodeConnectionHello({
      orgId: owner.orgId,
      userId: owner.userId,
      deviceId,
      connId: entry!.connId,
      nodeCredential: credential,
      bindConnection: (id) => manager.markNodeConnection(ws, id),
    })
    return { nodeId, credential, ws }
  }

  /** A queued app session targeting the node. */
  async function queuedSession(node: Node, level: "strict" | "standard" = "strict") {
    const job = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId: null,
      source: "app",
      prompt: "Fix the flaky test",
      sourceRequiredScopes: [],
      targetNodeId: node.nodeId,
      session: { source: "app", configKind: "owner", model: MODEL, level },
    })
    // A created job's node is set at claim; give the session its node now, as
    // the claim would, so a queued session's node is known.
    await sql`UPDATE kernel.node_sessions SET node_id = ${node.nodeId} WHERE id = ${job.sessionId!}`
    return { sessionId: job.sessionId as string, jobId: job.id }
  }

  /** A session the node claimed and started: status running. */
  async function runningSession(node: Node, protocol = 2) {
    const s = await queuedSession(node)
    const claimed = await call(
      `/api/nodes/jobs/${s.jobId}/claim`,
      "POST",
      {},
      { cred: node.credential, protocol },
    )
    expect(claimed.status).toBe(200)
    const leaseGeneration = (await json(claimed)).data.leaseGeneration as number
    const started = await call(
      `/api/nodes/jobs/${s.jobId}/started`,
      "POST",
      { leaseGeneration },
      { cred: node.credential },
    )
    expect(started.status).toBe(200)
    return { ...s, leaseGeneration }
  }

  async function doneSession(node: Node) {
    const s = await runningSession(node)
    await sql`UPDATE kernel.node_jobs SET status = 'done', finished_at = now() WHERE id = ${s.jobId}`
    await sql`UPDATE kernel.node_sessions SET status = 'done', ended_at = now(),
                sdk_session_id = 'sdk-1' WHERE id = ${s.sessionId}`
    return s
  }

  const send = (sessionId: string, type: string, payload: unknown, opts = {}) =>
    call(`/api/me/node-sessions/${sessionId}/commands`, "POST", { type, payload }, opts)

  const commands = (sessionId: string) =>
    sql<
      Array<{
        id: string
        seq: number
        type: string
        acked_at: Date | null
        outcome: string | null
      }>
    >`SELECT id, seq, type, acked_at, outcome FROM kernel.node_session_commands
       WHERE session_id = ${sessionId} ORDER BY seq`

  const sessionRow = async (sessionId: string) =>
    (
      await sql<
        Array<{ status: string; job_id: string; ended_at: Date | null; level: string }>
      >`SELECT status, job_id, ended_at, level FROM kernel.node_sessions WHERE id = ${sessionId}`
    )[0]

  const events = (sessionId: string) =>
    sql<Array<{ seq: number; type: string; payload: Record<string, any> }>>`
      SELECT seq, type, payload FROM kernel.node_session_events
       WHERE session_id = ${sessionId} ORDER BY seq`

  const wakes = (node: Node, sessionId: string) =>
    node.ws.frames.filter((f) => f.type === "node_session_command" && f.sessionId === sessionId)

  async function cleanup() {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(10)
    await sql`DELETE FROM kernel.node_level_confirmations WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    other = await minimal.session(org.id)
    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@cmd-${crypto.randomUUID().slice(0, 8)}`}, 'Olive',
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

  it("two commands get seq 1 and 2", async () => {
    const node = await liveNode()
    const s = await runningSession(node)
    const a = await send(s.sessionId, "message", { text: "first" })
    const b = await send(s.sessionId, "set_model", { model: MODEL })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect((await json(a)).data.seq).toBe(1)
    expect((await json(b)).data.seq).toBe(2)
    expect((await commands(s.sessionId)).map((c) => [c.seq, c.type])).toEqual([
      [1, "message"],
      [2, "set_model"],
    ])
  })

  it("a command on a running session is stored unacked and wakes the node's connection once", async () => {
    const node = await liveNode()
    const s = await runningSession(node)
    const res = await send(s.sessionId, "message", { text: "Also list the .claude folder" })
    expect(res.status).toBe(201)
    const { commandId } = (await json(res)).data
    const [cmd] = await commands(s.sessionId)
    expect(cmd).toMatchObject({ id: commandId, acked_at: null, outcome: null })
    expect(wakes(node, s.sessionId)).toEqual([
      { type: "node_session_command", sessionId: s.sessionId },
    ])
    expect((await sessionRow(s.sessionId)).status).toBe("running")
  })

  it("stop on a queued session cancels its job and the session is stopped with command_applied", async () => {
    const node = await liveNode()
    const s = await queuedSession(node)
    const res = await send(s.sessionId, "stop", {})
    expect(res.status).toBe(201)
    const { commandId } = (await json(res)).data
    const [job] = await sql<Array<{ status: string }>>`
      SELECT status FROM kernel.node_jobs WHERE id = ${s.jobId}`
    expect(job.status).toBe("cancelled")
    const row = await sessionRow(s.sessionId)
    expect(row.status).toBe("stopped")
    expect(row.ended_at).not.toBeNull()
    const [cmd] = await commands(s.sessionId)
    expect(cmd.outcome).toBe("applied")
    expect(cmd.acked_at).not.toBeNull()
    const evs = await events(s.sessionId)
    expect(evs.find((e) => e.type === "command_applied")?.payload).toEqual({
      commandId,
      type: "stop",
      outcome: "applied",
    })
    expect(evs.some((e) => e.type === "status" && e.payload.status === "stopped")).toBe(true)
    expect(wakes(node, s.sessionId)).toHaveLength(0)
  })

  it("stop on a done session is noop, acked", async () => {
    const node = await liveNode()
    const s = await doneSession(node)
    const res = await send(s.sessionId, "stop", {})
    expect(res.status).toBe(201)
    const [cmd] = await commands(s.sessionId)
    expect(cmd.outcome).toBe("noop")
    expect(cmd.acked_at).not.toBeNull()
    expect((await sessionRow(s.sessionId)).status).toBe("done")
  })

  it("a message on a done session makes it queued with exactly one new job, prompt = the text, resume_after message, command unacked", async () => {
    const node = await liveNode()
    const s = await doneSession(node)
    const res = await send(s.sessionId, "message", { text: "What did you do before?" })
    expect(res.status).toBe(201)
    const { commandId } = (await json(res)).data
    const row = await sessionRow(s.sessionId)
    expect(row.status).toBe("queued")
    expect(row.ended_at).toBeNull()
    expect(row.job_id).not.toBe(s.jobId)
    const jobs = await sql<
      Array<{ id: string; prompt: string; resume_after: string; resume_command_id: string }>
    >`SELECT id, prompt, resume_after, resume_command_id FROM kernel.node_jobs
       WHERE org_id = ${owner.orgId} AND id <> ${s.jobId}`
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      id: row.job_id,
      prompt: "What did you do before?",
      resume_after: "message",
      resume_command_id: commandId,
    })
    const [cmd] = await commands(s.sessionId)
    expect(cmd).toMatchObject({ id: commandId, acked_at: null, outcome: null })
    // The new run is offered to the node.
    expect(
      node.ws.frames.filter((f) => f.type === "node_job_offer" && f.jobId === row.job_id),
    ).toHaveLength(1)
  })

  it("S8: a message to a needs_you session creates exactly one resume run", async () => {
    const node = await liveNode()
    const s = await doneSession(node)
    await sql`UPDATE kernel.node_sessions SET status = 'needs_you' WHERE id = ${s.sessionId}`
    const [a, b] = await Promise.all([
      send(s.sessionId, "message", { text: "Use foo." }),
      send(s.sessionId, "message", { text: "And bar." }),
    ])
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    const jobs = await sql<Array<{ id: string; resume_after: string }>>`
      SELECT id, resume_after FROM kernel.node_jobs
       WHERE org_id = ${owner.orgId} AND id <> ${s.jobId}`
    expect(jobs).toHaveLength(1)
    expect(jobs[0].resume_after).toBe("message")
    const row = await sessionRow(s.sessionId)
    expect(row.status).toBe("queued")
    expect(row.job_id).toBe(jobs[0].id)
  })

  it("two messages on a done session still create one job", async () => {
    const node = await liveNode()
    const s = await doneSession(node)
    const [a, b] = await Promise.all([
      send(s.sessionId, "message", { text: "one" }),
      send(s.sessionId, "message", { text: "two" }),
    ])
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    const jobs = await sql`SELECT id FROM kernel.node_jobs
                            WHERE org_id = ${owner.orgId} AND id <> ${s.jobId}`
    expect(jobs).toHaveLength(1)
    expect((await sessionRow(s.sessionId)).status).toBe("queued")
    const cmds = await commands(s.sessionId)
    expect(cmds.map((c) => c.outcome)).toEqual([null, null])
  })

  it("set_model on a done session updates the row, applied", async () => {
    const node = await liveNode()
    const s = await doneSession(node)
    const res = await send(s.sessionId, "set_model", { model: "claude-sonnet-4-5" })
    expect(res.status).toBe(201)
    const [m] = await sql<Array<{ model: string }>>`
      SELECT model FROM kernel.node_sessions WHERE id = ${s.sessionId}`
    expect(m.model).toBe("claude-sonnet-4-5")
    const evs = await events(s.sessionId)
    expect(evs.find((e) => e.type === "model_changed")?.payload).toEqual({
      from: MODEL,
      to: "claude-sonnet-4-5",
    })
    expect((await commands(s.sessionId))[0].outcome).toBe("applied")
  })

  it("a raise without a confirmation is 403 confirmation_required and stores nothing; with an attached session_raise it is stored", async () => {
    const node = await liveNode()
    const s = await runningSession(node)
    const refused = await send(s.sessionId, "set_level", { level: "standard" })
    expect(refused.status).toBe(403)
    expect((await json(refused)).error.code).toBe("confirmation_required")
    expect(await commands(s.sessionId)).toHaveLength(0)

    // A confirmation for another session does not attach.
    const otherNode = await liveNode()
    const otherSession = await runningSession(otherNode)
    const mint = async (sessionId: string, nodeId: string) => {
      const r = await call("/api/me/node-level-confirmations", "POST", {
        nodeId,
        sessionId,
        level: "standard",
        purpose: "session_raise",
      })
      expect(r.status).toBe(201)
      return (await json(r)).data.confirmationId as string
    }
    const wrong = await mint(otherSession.sessionId, otherNode.nodeId)
    const mismatched = await send(s.sessionId, "set_level", {
      level: "standard",
      confirmationId: wrong,
    })
    expect(mismatched.status).toBe(403)
    expect(await commands(s.sessionId)).toHaveLength(0)

    const id = await mint(s.sessionId, node.nodeId)
    const ok = await send(s.sessionId, "set_level", { level: "standard", confirmationId: id })
    expect(ok.status).toBe(201)
    expect(await commands(s.sessionId)).toHaveLength(1)
    const [conf] = await sql<Array<{ attached_at: Date | null }>>`
      SELECT attached_at FROM kernel.node_level_confirmations WHERE id = ${id}`
    expect(conf.attached_at).not.toBeNull()
    // Lowering never asks.
    expect((await send(s.sessionId, "set_level", { level: "strict" })).status).toBe(201)
  })

  it("another user's session is 404; an MCP token is 401; a node credential is 403", async () => {
    const node = await liveNode()
    const s = await runningSession(node)
    const res = await send(s.sessionId, "stop", {}, { bearer: other.bearer })
    expect(res.status).toBe(404)
    const open = await call(
      `/api/me/node-sessions/${s.sessionId}/commands?open=1`,
      "GET",
      undefined,
      {
        bearer: other.bearer,
      },
    )
    expect(open.status).toBe(404)

    const claims = decodeJwt(owner.bearer) as Record<string, any>
    const mcpToken = await signAccessToken(
      {
        userId: claims.userId,
        orgId: claims.orgId,
        name: claims.name,
        authVersion: claims.authVersion,
        permissionVersion: claims.permissionVersion,
        roles: claims.roles,
        scopes: claims.scopes,
        mcpConnectionId: crypto.randomUUID(),
        agentId,
      },
      env.JWT_SECRET,
      600,
    )
    expect((await send(s.sessionId, "stop", {}, { bearer: mcpToken })).status).toBe(401)
    const byNode = await send(s.sessionId, "stop", {}, { cred: node.credential })
    expect(byNode.status).toBe(403)
    expect(await commands(s.sessionId)).toHaveLength(0)
  })

  it("an invalid command is 400 and stores nothing", async () => {
    const node = await liveNode()
    const s = await runningSession(node)
    expect((await send(s.sessionId, "message", { text: "" })).status).toBe(400)
    expect((await send(s.sessionId, "reboot", {})).status).toBe(400)
    expect(await commands(s.sessionId)).toHaveLength(0)
  })

  it("GET open lists the unacked ones in order", async () => {
    const node = await liveNode()
    const s = await runningSession(node)
    await send(s.sessionId, "message", { text: "one" })
    await send(s.sessionId, "message", { text: "two" })
    const [first] = await commands(s.sessionId)
    await sql`UPDATE kernel.node_session_commands SET acked_at = now(), outcome = 'applied'
               WHERE id = ${first.id}`
    await send(s.sessionId, "stop", {})
    const res = await call(`/api/me/node-sessions/${s.sessionId}/commands?open=1`, "GET")
    expect(res.status).toBe(200)
    const listed = (await json(res)).data.commands as Array<Record<string, unknown>>
    expect(listed.map((c) => [c.seq, c.type, c.payload])).toEqual([
      [2, "message", { text: "two" }],
      [3, "stop", {}],
    ])
  })
  // ── round 2: the owner's Mark done and reasoning level (P1-T04) ────────────

  const statusChanges = () => {
    const seen: Array<{ sessionId: string } & SessionStatusChange> = []
    const off = onSessionStatus((row, change) => {
      seen.push({ sessionId: row.id, ...change })
    })
    return { seen, off }
  }

  const fullRow = async (sessionId: string) =>
    (
      await sql<
        Array<{
          status: string
          job_id: string
          ended_at: Date | null
          result_summary: string | null
          effort: string | null
          autonomy: string
        }>
      >`SELECT status, job_id, ended_at, result_summary, effort, autonomy
          FROM kernel.node_sessions WHERE id = ${sessionId}`
    )[0]

  it("S7: mark_done on needs_you ends done with command_applied applied and fires fireSessionStatus cause owner", async () => {
    const node = await liveNode()
    const s = await doneSession(node)
    await sql`UPDATE kernel.node_sessions SET status = 'needs_you', result_summary = 'Which branch?'
               WHERE id = ${s.sessionId}`
    const endedBefore = (await fullRow(s.sessionId)).ended_at
    const hook = statusChanges()
    try {
      const res = await send(s.sessionId, "mark_done", { summary: "Merged by hand." })
      expect(res.status).toBe(201)
      const { commandId } = (await json(res)).data
      const row = await fullRow(s.sessionId)
      expect(row.status).toBe("done")
      expect(row.result_summary).toBe("Merged by hand.")
      expect(endedBefore).not.toBeNull()
      expect(String(row.ended_at)).toBe(String(endedBefore))
      const [cmd] = await commands(s.sessionId)
      expect(cmd).toMatchObject({ id: commandId, outcome: "applied" })
      expect(cmd.acked_at).not.toBeNull()
      const evs = await events(s.sessionId)
      expect(evs.find((e) => e.type === "status" && e.payload.status === "done")?.payload).toEqual({
        status: "done",
        reason: "marked_done_by_owner",
      })
      expect(evs.find((e) => e.type === "command_applied")?.payload).toEqual({
        commandId,
        type: "mark_done",
        outcome: "applied",
      })
      expect(hook.seen.filter((c) => c.sessionId === s.sessionId)).toEqual([
        {
          sessionId: s.sessionId,
          from: "needs_you",
          to: "done",
          reason: "marked_done_by_owner",
          cause: "owner",
        },
      ])
      // No run was created and the node is not woken.
      const jobs = await sql`SELECT id FROM kernel.node_jobs
                              WHERE org_id = ${owner.orgId} AND id <> ${s.jobId}`
      expect(jobs).toHaveLength(0)
      expect(wakes(node, s.sessionId)).toHaveLength(0)
    } finally {
      hook.off()
    }
  })

  it("S7: mark_done on done is noop", async () => {
    const node = await liveNode()
    const s = await doneSession(node)
    const hook = statusChanges()
    try {
      const res = await send(s.sessionId, "mark_done", {})
      expect(res.status).toBe(201)
      const [cmd] = await commands(s.sessionId)
      expect(cmd.outcome).toBe("noop")
      expect(cmd.acked_at).not.toBeNull()
      expect((await fullRow(s.sessionId)).status).toBe("done")
      expect(hook.seen.filter((c) => c.sessionId === s.sessionId)).toHaveLength(0)
    } finally {
      hook.off()
    }
  })

  for (const status of ["running", "waiting", "paused"] as const) {
    it(`S7: mark_done on a ${status} session whose job has node_protocol 2 is refused node_outdated`, async () => {
      const node = await liveNode()
      const s = await runningSession(node)
      const [job] = await sql<Array<{ node_protocol: number | null }>>`
        SELECT node_protocol FROM kernel.node_jobs WHERE id = ${s.jobId}`
      expect(job.node_protocol).toBe(2)
      await sql`UPDATE kernel.node_sessions SET status = ${status} WHERE id = ${s.sessionId}`
      const res = await send(s.sessionId, "mark_done", { summary: "ok" })
      expect(res.status).toBe(409)
      expect((await json(res)).error.code).toBe("node_outdated")
      expect(await commands(s.sessionId)).toHaveLength(0)
      expect((await fullRow(s.sessionId)).status).toBe(status)
      expect(wakes(node, s.sessionId)).toHaveLength(0)
    })
  }

  it("S7: mark_done on a running session whose node speaks protocol 3 is delivered to the node, unacked", async () => {
    const node = await liveNode()
    const s = await runningSession(node, 3)
    const [job] = await sql<Array<{ node_protocol: number | null }>>`
      SELECT node_protocol FROM kernel.node_jobs WHERE id = ${s.jobId}`
    expect(job.node_protocol).toBe(3)
    const res = await send(s.sessionId, "mark_done", { summary: "Good enough." })
    expect(res.status).toBe(201)
    const [cmd] = await commands(s.sessionId)
    expect(cmd).toMatchObject({ type: "mark_done", acked_at: null, outcome: null })
    expect(wakes(node, s.sessionId)).toHaveLength(1)
    expect((await fullRow(s.sessionId)).status).toBe("running")
  })

  it("S7: mark_done on queued ends done without a run", async () => {
    const node = await liveNode()
    const s = await queuedSession(node)
    const hook = statusChanges()
    try {
      const res = await send(s.sessionId, "mark_done", { summary: "Not needed any more." })
      expect(res.status).toBe(201)
      const [job] = await sql<Array<{ status: string }>>`
        SELECT status FROM kernel.node_jobs WHERE id = ${s.jobId}`
      expect(job.status).toBe("cancelled")
      const row = await fullRow(s.sessionId)
      expect(row.status).toBe("done")
      expect(row.ended_at).not.toBeNull()
      expect(row.result_summary).toBe("Not needed any more.")
      const [cmd] = await commands(s.sessionId)
      expect(cmd.outcome).toBe("applied")
      const evs = await events(s.sessionId)
      expect(evs.some((e) => e.type === "status" && e.payload.status === "stopped")).toBe(false)
      expect(evs.find((e) => e.type === "status" && e.payload.status === "done")?.payload).toEqual({
        status: "done",
        reason: "marked_done_by_owner",
      })
      expect(hook.seen.filter((c) => c.sessionId === s.sessionId)).toEqual([
        {
          sessionId: s.sessionId,
          from: "queued",
          to: "done",
          reason: "marked_done_by_owner",
          cause: "owner",
        },
      ])
      const jobs = await sql`SELECT id FROM kernel.node_jobs
                              WHERE org_id = ${owner.orgId} AND id <> ${s.jobId}`
      expect(jobs).toHaveLength(0)
      expect(wakes(node, s.sessionId)).toHaveLength(0)
    } finally {
      hook.off()
    }
  })

  // ── F1: an ending command never outlives the run it was sent to ───────────

  const pull = (node: Node) =>
    call("/api/node/sessions/commands?unacked=1", "GET", undefined, {
      cred: node.credential,
      protocol: 3,
    })

  /** The owner's message on the ended session; its resume run claimed by the node. */
  async function resumeClaimed(node: Node, sessionId: string) {
    await sql`UPDATE kernel.node_sessions SET sdk_session_id = 'sdk-1' WHERE id = ${sessionId}`
    const msg = await send(sessionId, "message", { text: "One more thing." })
    expect(msg.status).toBe(201)
    const row = await sessionRow(sessionId)
    expect(row.status).toBe("queued")
    const claimed = await call(
      `/api/nodes/jobs/${row.job_id}/claim`,
      "POST",
      {},
      { cred: node.credential, protocol: 3 },
    )
    expect(claimed.status).toBe(200)
    return row.job_id
  }

  it("S7: a Mark done that loses the race to the run's own end ends the session done and never reaches the next run", async () => {
    const node = await liveNode()
    const s = await runningSession(node, 3)
    const hook = statusChanges()
    try {
      const sent = await send(s.sessionId, "mark_done", { summary: "Good enough." })
      expect(sent.status).toBe(201)
      const { commandId } = (await json(sent)).data
      // The turn ends before the node pulls it: a result with no completion.
      const res = await call(
        `/api/nodes/jobs/${s.jobId}/result`,
        "POST",
        { leaseGeneration: s.leaseGeneration, text: "Turn over." },
        { cred: node.credential, protocol: 3 },
      )
      expect(res.status).toBe(201)
      const row = await fullRow(s.sessionId)
      expect(row.status).toBe("done")
      expect(row.result_summary).toBe("Good enough.")
      const [cmd] = await commands(s.sessionId)
      expect(cmd).toMatchObject({ id: commandId, outcome: "applied" })
      expect(cmd.acked_at).not.toBeNull()
      expect(hook.seen.filter((c) => c.sessionId === s.sessionId)).toEqual([
        {
          sessionId: s.sessionId,
          from: "running",
          to: "done",
          reason: "marked_done_by_owner",
          cause: "owner",
        },
      ])
    } finally {
      hook.off()
    }
    const resumeJob = await resumeClaimed(node, s.sessionId)
    const pulled = (await json(await pull(node))).data.commands as Array<{
      type: string
      jobId: string
    }>
    expect(pulled.map((c) => [c.type, c.jobId])).toEqual([["message", resumeJob]])
  })

  it("S7: a Stop that loses the race to the run's own end is settled noop and never reaches the next run", async () => {
    const node = await liveNode()
    const s = await runningSession(node, 3)
    const sent = await send(s.sessionId, "stop", {})
    expect(sent.status).toBe(201)
    const res = await call(
      `/api/nodes/jobs/${s.jobId}/result`,
      "POST",
      { leaseGeneration: s.leaseGeneration, text: "Shipped.", completion: { by: "session" } },
      { cred: node.credential, protocol: 3 },
    )
    expect(res.status).toBe(201)
    expect((await fullRow(s.sessionId)).status).toBe("done")
    const [cmd] = await commands(s.sessionId)
    expect(cmd).toMatchObject({ type: "stop", outcome: "noop" })
    expect(cmd.acked_at).not.toBeNull()
    const evs = await events(s.sessionId)
    expect(evs.find((e) => e.type === "command_applied")?.payload).toEqual({
      commandId: cmd.id,
      type: "stop",
      outcome: "noop",
    })
    const resumeJob = await resumeClaimed(node, s.sessionId)
    const pulled = (await json(await pull(node))).data.commands as Array<{
      type: string
      jobId: string
    }>
    expect(pulled.map((c) => [c.type, c.jobId])).toEqual([["message", resumeJob]])
  })

  it("S7: a run that fails with a Mark done pending stays failed and settles it noop", async () => {
    const node = await liveNode()
    const s = await runningSession(node, 3)
    expect((await send(s.sessionId, "mark_done", { summary: "ok" })).status).toBe(201)
    const res = await call(
      `/api/nodes/jobs/${s.jobId}/fail`,
      "POST",
      { leaseGeneration: s.leaseGeneration, error: "the build broke", code: "error" },
      { cred: node.credential, protocol: 3 },
    )
    expect(res.status).toBe(200)
    expect((await fullRow(s.sessionId)).status).toBe("failed")
    const [cmd] = await commands(s.sessionId)
    expect(cmd).toMatchObject({ type: "mark_done", outcome: "noop" })
    expect(cmd.acked_at).not.toBeNull()
  })

  it("S7: the pull never hands a stop or mark_done stamped with an older run to the current one", async () => {
    const node = await liveNode()
    const older = await queuedSession(node)
    const s = await runningSession(node, 3)
    expect((await send(s.sessionId, "stop", {})).status).toBe(201)
    expect((await send(s.sessionId, "mark_done", {})).status).toBe(201)
    expect((await send(s.sessionId, "message", { text: "hi" })).status).toBe(201)
    await sql`UPDATE kernel.node_session_commands SET job_id = ${older.jobId}
               WHERE session_id = ${s.sessionId} AND type IN ('stop', 'mark_done')`
    const pulled = (await json(await pull(node))).data.commands as Array<{
      type: string
      sessionId: string
    }>
    expect(pulled.filter((c) => c.sessionId === s.sessionId).map((c) => c.type)).toEqual([
      "message",
    ])
  })

  it("S7: stop on a queued session fires fireSessionStatus cause owner", async () => {
    const node = await liveNode()
    const s = await queuedSession(node)
    const hook = statusChanges()
    try {
      expect((await send(s.sessionId, "stop", {})).status).toBe(201)
      expect(hook.seen.filter((c) => c.sessionId === s.sessionId)).toEqual([
        {
          sessionId: s.sessionId,
          from: "queued",
          to: "stopped",
          reason: "stopped_by_owner",
          cause: "owner",
        },
      ])
    } finally {
      hook.off()
    }
  })

  it("S24: set_effort on an ended session updates the row and appends effort_changed", async () => {
    const node = await liveNode()
    const s = await doneSession(node)
    const res = await send(s.sessionId, "set_effort", { effort: "xhigh" })
    expect(res.status).toBe(201)
    expect((await json(res)).data.applied).toBeUndefined()
    expect((await fullRow(s.sessionId)).effort).toBe("xhigh")
    const [cmd] = await commands(s.sessionId)
    expect(cmd.outcome).toBe("applied")
    const evs = await events(s.sessionId)
    expect(evs.find((e) => e.type === "system")?.payload).toEqual({
      subtype: "effort_changed",
      data: { from: null, to: "xhigh" },
    })
    // Back to the model's default.
    expect((await send(s.sessionId, "set_effort", { effort: null })).status).toBe(201)
    expect((await fullRow(s.sessionId)).effort).toBeNull()
    // The same value again changes nothing.
    expect((await send(s.sessionId, "set_effort", { effort: null })).status).toBe(201)
    expect((await commands(s.sessionId)).map((c) => c.outcome)).toEqual([
      "applied",
      "applied",
      "noop",
    ])
    expect((await events(s.sessionId)).filter((e) => e.type === "system")).toHaveLength(2)
    expect((await fullRow(s.sessionId)).status).toBe("done")
  })

  it("S24: set_effort on a running session with an old node changes the row only and answers row_only", async () => {
    const node = await liveNode()
    const s = await runningSession(node)
    const res = await send(s.sessionId, "set_effort", { effort: "low" })
    expect(res.status).toBe(201)
    expect((await json(res)).data.applied).toBe("row_only")
    expect((await fullRow(s.sessionId)).effort).toBe("low")
    const [cmd] = await commands(s.sessionId)
    expect(cmd.outcome).toBe("applied")
    expect(cmd.acked_at).not.toBeNull()
    expect(wakes(node, s.sessionId)).toHaveLength(0)
  })

  it("S24: set_effort on a paused session reaches the node on reconnect", async () => {
    const node = await liveNode()
    const s = await runningSession(node, 3)
    await sql`UPDATE kernel.node_sessions SET status = 'paused' WHERE id = ${s.sessionId}`
    const res = await send(s.sessionId, "set_effort", { effort: "high" })
    expect(res.status).toBe(201)
    expect((await json(res)).data.applied).toBeUndefined()
    expect((await fullRow(s.sessionId)).effort).toBe("high")
    const [cmd] = await commands(s.sessionId)
    expect(cmd).toMatchObject({ type: "set_effort", acked_at: null, outcome: null })
    const pulled = (await json(await pull(node))).data.commands as Array<{
      type: string
      payload: Record<string, unknown>
    }>
    expect(pulled.map((c) => [c.type, c.payload])).toEqual([["set_effort", { effort: "high" }]])
  })

  it("S24: set_effort on a paused session with an old node changes the row only and answers row_only", async () => {
    const node = await liveNode()
    const s = await runningSession(node)
    await sql`UPDATE kernel.node_sessions SET status = 'paused' WHERE id = ${s.sessionId}`
    const res = await send(s.sessionId, "set_effort", { effort: "low" })
    expect(res.status).toBe(201)
    expect((await json(res)).data.applied).toBe("row_only")
    const [cmd] = await commands(s.sessionId)
    expect(cmd.outcome).toBe("applied")
  })

  it("S24: set_effort on a running session with a protocol 3 node changes the row and is delivered", async () => {
    const node = await liveNode()
    const s = await runningSession(node, 3)
    const [job] = await sql<Array<{ node_protocol: number | null }>>`
      SELECT node_protocol FROM kernel.node_jobs WHERE id = ${s.jobId}`
    expect(job.node_protocol).toBe(3)
    const res = await send(s.sessionId, "set_effort", { effort: "max" })
    expect(res.status).toBe(201)
    expect((await json(res)).data.applied).toBeUndefined()
    expect((await fullRow(s.sessionId)).effort).toBe("max")
    const [cmd] = await commands(s.sessionId)
    expect(cmd).toMatchObject({ type: "set_effort", acked_at: null, outcome: null })
    expect(wakes(node, s.sessionId)).toHaveLength(1)
    const evs = await events(s.sessionId)
    expect(evs.find((e) => e.type === "system")?.payload).toEqual({
      subtype: "effort_changed",
      data: { from: null, to: "max" },
    })
  })
  it("S33: set_autonomy on a live session whose job has node_protocol 3 answers row_only; with 4 it is delivered", async () => {
    const node = await liveNode()
    const old = await runningSession(node, 3)
    const res = await send(old.sessionId, "set_autonomy", { autonomy: "autonomous" })
    expect(res.status).toBe(201)
    expect((await json(res)).data.applied).toBe("row_only")
    expect((await fullRow(old.sessionId)).autonomy).toBe("autonomous")
    const [oldCmd] = await commands(old.sessionId)
    expect(oldCmd).toMatchObject({ type: "set_autonomy", outcome: "applied" })
    expect(oldCmd.acked_at).not.toBeNull()
    expect(wakes(node, old.sessionId)).toHaveLength(0)
    expect((await events(old.sessionId)).find((e) => e.type === "system")?.payload).toEqual({
      subtype: "autonomy_changed",
      data: { from: "guided", to: "autonomous" },
    })

    const s = await runningSession(node, 4)
    const live = await send(s.sessionId, "set_autonomy", { autonomy: "autonomous" })
    expect(live.status).toBe(201)
    expect((await json(live)).data.applied).toBeUndefined()
    expect((await fullRow(s.sessionId)).autonomy).toBe("autonomous")
    const [cmd] = await commands(s.sessionId)
    expect(cmd).toMatchObject({ type: "set_autonomy", acked_at: null, outcome: null })
    expect(wakes(node, s.sessionId)).toHaveLength(1)
    expect((await fullRow(s.sessionId)).status).toBe("running")

    // An ended session: the row changes, nothing reaches a node; the same value is a noop.
    const done = await doneSession(node)
    expect((await send(done.sessionId, "set_autonomy", { autonomy: "autonomous" })).status).toBe(
      201,
    )
    expect((await send(done.sessionId, "set_autonomy", { autonomy: "autonomous" })).status).toBe(
      201,
    )
    expect((await commands(done.sessionId)).map((c) => c.outcome)).toEqual(["applied", "noop"])
    expect((await fullRow(done.sessionId)).autonomy).toBe("autonomous")
    // 'yolo' is not an autonomy.
    expect((await send(done.sessionId, "set_autonomy", { autonomy: "yolo" })).status).toBe(400)
  })

  it("S54: stop_task reaches a protocol 3 node's live run; an older node is refused node_outdated; an ended session is a noop", async () => {
    const node = await liveNode()
    const s = await runningSession(node, 3)
    const res = await send(s.sessionId, "stop_task", { taskId: "task_1" })
    expect(res.status).toBe(201)
    const [cmd] = await commands(s.sessionId)
    expect(cmd).toMatchObject({ type: "stop_task", acked_at: null, outcome: null })
    expect(wakes(node, s.sessionId)).toHaveLength(1)
    // The session goes on: only the node stops that one subagent.
    expect((await fullRow(s.sessionId)).status).toBe("running")

    const old = await runningSession(node)
    const refused = await send(old.sessionId, "stop_task", { taskId: "task_1" })
    expect(refused.status).toBe(409)
    expect(await commands(old.sessionId)).toHaveLength(0)

    const done = await doneSession(node)
    expect((await send(done.sessionId, "stop_task", { taskId: "task_1" })).status).toBe(201)
    expect((await commands(done.sessionId)).map((c) => c.outcome)).toEqual(["noop"])
  })
})
