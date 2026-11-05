// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T12 (S16, L4, D36, G4, G5, G7): a session's life across its runs.
// Paused from presence; alive or dead from the node's report; a lapsed lease
// pauses while the node is offline and only counts as dead after 10 minutes
// with the node online; a dead run expires its requests, is interrupted and
// resumes (or reruns its prompt); a Stop ends `stopped`; a message left
// unread when a run ends starts exactly one resume run; the claim of a resume
// run answers what to resume; re-run and discard of a session's job are
// refused in favour of the session's own commands.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { NodeSessionEventIn } from "@liaison/shared"
import { app } from "~/app"
import { sql } from "~/db"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { onNodeConnectionHello } from "~/modules/nodes/hooks"
import { createNodeJob, sweepNodeLeases } from "~/modules/nodes/jobs"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  NODE_CLOSE_GRACE_MS,
  NODE_RESTART_GRACE_MS,
  nodeCloseGraceMs,
  onNodeConnectionClosed,
} from "./lifecycle"
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

describe("node session lifecycle (P3-T12)", () => {
  let owner: minimal.Session
  let agentId: string
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  const sockets: FakeWs[] = []

  const call = (path: string, method: string, body?: unknown, cred?: string, protocol = "2") =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${owner.bearer}`,
        ...(cred ? { "X-Node-Credential": cred, "X-Liaison-Node-Protocol": protocol } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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
    const res = await call("/api/nodes", "POST", { deviceId, name: "Studio Mac" })
    expect(res.status).toBe(201)
    const d = (await json(res)).data
    const node = { nodeId: d.node.id as string, credential: d.credential as string, deviceId }
    const caps = await call(
      `/api/nodes/${node.nodeId}/capabilities`,
      "PUT",
      { sharedFolders: [], models: [{ id: MODEL, label: "Haiku 4.5" }] },
      node.credential,
    )
    expect(caps.status).toBe(200)
    return node
  }

  async function connect(node: Node): Promise<FakeWs> {
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
    return ws
  }

  async function disconnect(node: Node) {
    if (node.ws) manager.removeConnection(node.ws)
    await Bun.sleep(20)
  }

  /** A session the node claimed and started (status running), with an SDK session. */
  async function running(node: Node, opts: { sdk?: boolean; protocol?: string } = {}) {
    const job = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId: null,
      source: "app",
      prompt: "Fix the flaky test",
      sourceRequiredScopes: [],
      targetNodeId: node.nodeId,
      session: { source: "app", configKind: "owner", model: MODEL, level: "strict" },
    })
    const claimed = await call(
      `/api/nodes/jobs/${job.id}/claim`,
      "POST",
      {},
      node.credential,
      opts.protocol,
    )
    expect(claimed.status).toBe(200)
    const gen = (await json(claimed)).data.leaseGeneration as number
    expect(
      (
        await call(
          `/api/nodes/jobs/${job.id}/started`,
          "POST",
          { leaseGeneration: gen },
          node.credential,
        )
      ).status,
    ).toBe(200)
    const sessionId = job.sessionId as string
    if (opts.sdk !== false) {
      await post(node, sessionId, job.id, gen, 1, [
        {
          at: new Date().toISOString(),
          type: "system",
          payload: { subtype: "start", text: "started", data: { sessionId: "sdk-1" } },
        },
      ])
    }
    return { sessionId, jobId: job.id, gen }
  }

  const post = async (
    node: Node,
    sessionId: string,
    jobId: string,
    leaseGeneration: number,
    batchNo: number,
    events: NodeSessionEventIn[],
  ) => {
    const res = await call(
      `/api/node/sessions/${sessionId}/events`,
      "POST",
      { jobId, leaseGeneration, batchNo, events },
      node.credential,
    )
    expect(res.status).toBe(200)
  }

  const permission = (requestId: string): NodeSessionEventIn => ({
    at: new Date().toISOString(),
    type: "permission_request",
    payload: { requestId, tool: "Write", input: { file_path: "/x" }, reason: "outside" },
  })

  const sessionRow = async (id: string) =>
    (
      await sql<
        Array<{
          status: string
          job_id: string
          pending_count: number
          ended_at: Date | null
          last_batch_no: number
          last_seq: number
        }>
      >`SELECT status, job_id, pending_count, ended_at, last_batch_no, last_seq
          FROM kernel.node_sessions WHERE id = ${id}`
    )[0]
  const jobRow = async (id: string) =>
    (
      await sql<
        Array<{
          status: string
          lease_holder: string | null
          lease_expires_at: Date | null
          error_code: string | null
          prompt: string
          resume_after: string | null
          resume_command_id: string | null
        }>
      >`SELECT status, lease_holder, lease_expires_at, error_code, prompt, resume_after,
               resume_command_id FROM kernel.node_jobs WHERE id = ${id}`
    )[0]
  const otherJobs = (jobId: string) =>
    sql<
      Array<{
        id: string
        prompt: string
        resume_after: string | null
        resume_command_id: string | null
      }>
    >`
      SELECT id, prompt, resume_after, resume_command_id FROM kernel.node_jobs
       WHERE org_id = ${owner.orgId} AND id <> ${jobId} ORDER BY created_at`
  const events = (sessionId: string) =>
    sql<Array<{ type: string; payload: Record<string, any> }>>`
      SELECT type, payload FROM kernel.node_session_events
       WHERE session_id = ${sessionId} ORDER BY seq`
  const report = (node: Node, sessions: unknown[]) =>
    call("/api/node/sessions/report", "POST", { sessions }, node.credential)

  async function cleanup() {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(10)
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
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@lc-${crypto.randomUUID().slice(0, 8)}`}, 'Olive',
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

  it("the node's last connection closing pauses its running and waiting sessions", async () => {
    const node = await enable()
    const other = await enable()
    await connect(node)
    await connect(other)
    const a = await running(node)
    const b = await running(other)
    await post(other, b.sessionId, b.jobId, b.gen, 2, [permission("r1")])
    expect((await sessionRow(b.sessionId)).status).toBe("waiting")

    // A second connection of the same node keeps it online: nothing pauses.
    const first = node.ws as FakeWs
    await connect(node)
    manager.removeConnection(first)
    await Bun.sleep(20)
    await onNodeConnectionClosed({ orgId: owner.orgId, userId: owner.userId, nodeId: node.nodeId })
    expect((await sessionRow(a.sessionId)).status).toBe("running")

    for (const n of [node, other]) {
      await disconnect(n)
      await onNodeConnectionClosed({ orgId: owner.orgId, userId: owner.userId, nodeId: n.nodeId })
    }
    expect((await sessionRow(a.sessionId)).status).toBe("paused")
    expect((await sessionRow(b.sessionId)).status).toBe("paused")
    expect((await jobRow(a.jobId)).status).toBe("running")
    const statuses = (await events(a.sessionId)).filter((e) => e.type === "status")
    expect(statuses.at(-1)?.payload).toEqual({ status: "paused", reason: "node_offline" })
  })

  it("a socket close followed within the grace by the same node reconnecting (a page reload) pauses nothing; with no reconnect it pauses once the grace is over (walk D10)", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    await disconnect(node)
    const closed = onNodeConnectionClosed({
      orgId: owner.orgId,
      userId: owner.userId,
      nodeId: node.nodeId,
      graceMs: 300,
    })
    await Bun.sleep(50)
    await connect(node)
    await closed
    expect((await sessionRow(s.sessionId)).status).toBe("running")
    expect(
      (await events(s.sessionId)).filter((e) => e.type === "status").map((e) => e.payload.status),
    ).not.toContain("paused")

    await disconnect(node)
    const t0 = Date.now()
    await onNodeConnectionClosed({
      orgId: owner.orgId,
      userId: owner.userId,
      nodeId: node.nodeId,
      graceMs: 200,
    })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190)
    expect((await sessionRow(s.sessionId)).status).toBe("paused")
  })

  it("a node whose presence lapsed without a socket close (network loss) is paused by the presence sweep, its lease still valid (walk D9)", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    // The socket died silently: the registry entry is gone, no close ran.
    await disconnect(node)
    expect((await sessionRow(s.sessionId)).status).toBe("running")
    await sweepNodeLeases()
    expect((await sessionRow(s.sessionId)).status).toBe("paused")
    expect(await jobRow(s.jobId)).toMatchObject({ status: "running", lease_holder: node.nodeId })
    const statuses = (await events(s.sessionId)).filter((e) => e.type === "status")
    expect(statuses.at(-1)?.payload).toEqual({ status: "paused", reason: "node_offline" })
  })

  it("a report alive brings a paused session back to waiting when a request is open, running otherwise, extends the lease, and answers lastBatchNo", async () => {
    const node = await enable()
    const other = await enable()
    await connect(node)
    await connect(other)
    const a = await running(node)
    const b = await running(other)
    await post(other, b.sessionId, b.jobId, b.gen, 2, [permission("r1")])
    for (const n of [node, other]) {
      await disconnect(n)
      await onNodeConnectionClosed({ orgId: owner.orgId, userId: owner.userId, nodeId: n.nodeId })
    }
    expect((await sessionRow(b.sessionId)).status).toBe("paused")
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() + interval '5 seconds'
               WHERE id IN (${a.jobId}, ${b.jobId})`

    await connect(node)
    await connect(other)
    const resA = await report(node, [
      { id: a.sessionId, jobId: a.jobId, leaseGeneration: a.gen, alive: true },
    ])
    const resB = await report(other, [
      { id: b.sessionId, jobId: b.jobId, leaseGeneration: b.gen, alive: true },
    ])
    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    const rowA = await sessionRow(a.sessionId)
    const rowB = await sessionRow(b.sessionId)
    expect(rowA.status).toBe("running")
    expect(rowB.status).toBe("waiting")
    expect((await json(resA)).data.sessions).toEqual([
      { id: a.sessionId, lastBatchNo: 1, lastSeq: rowA.last_seq },
    ])
    expect((await json(resB)).data.sessions).toEqual([
      { id: b.sessionId, lastBatchNo: 2, lastSeq: rowB.last_seq },
    ])
    const lease = new Date((await jobRow(a.jobId)).lease_expires_at as Date)
    expect(lease.getTime() - Date.now()).toBeGreaterThan(60_000)
    // A stale generation is not alive: nothing extended, nothing answered.
    const stale = await report(node, [
      { id: a.sessionId, jobId: a.jobId, leaseGeneration: a.gen + 5, alive: true },
    ])
    expect((await json(stale)).data.sessions).toEqual([])
  })

  it("a report without a running session expires its open requests, interrupts the job and queues one resume job with resume_after offline", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    await post(node, s.sessionId, s.jobId, s.gen, 2, [permission("r1"), permission("r2")])
    await sql`UPDATE kernel.node_jobs SET claimed_at = now() - interval '5 minutes' WHERE id = ${s.jobId}`
    const res = await report(node, [])
    expect(res.status).toBe(200)
    expect((await json(res)).data.sessions).toEqual([])

    const decisions = (await events(s.sessionId)).filter((e) => e.type === "decision")
    expect(decisions.map((d) => d.payload)).toEqual([
      { requestId: "r1", outcome: "expired", by: "process_exit" },
      { requestId: "r2", outcome: "expired", by: "process_exit" },
    ])
    expect(await jobRow(s.jobId)).toMatchObject({
      status: "interrupted",
      error_code: "lease_expired",
    })
    const resumed = await otherJobs(s.jobId)
    expect(resumed).toHaveLength(1)
    expect(resumed[0]).toMatchObject({ prompt: "Fix the flaky test", resume_after: "offline" })
    const row = await sessionRow(s.sessionId)
    expect(row).toMatchObject({ status: "queued", job_id: resumed[0].id, pending_count: 0 })
  })

  it("a report sent before the relaunched node's socket is bound queues a resume job that is not backlog, and the node's hello offers it (walk D4)", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    await disconnect(node)
    await onNodeConnectionClosed({ orgId: owner.orgId, userId: owner.userId, nodeId: node.nodeId })
    await sql`UPDATE kernel.node_jobs SET claimed_at = now() - interval '5 minutes' WHERE id = ${s.jobId}`
    // The relaunched app reports before its socket says hello.
    expect((await report(node, [])).status).toBe(200)
    const [resumed] = await otherJobs(s.jobId)
    expect(resumed).toMatchObject({ resume_after: "offline" })
    const [flags] = await sql<Array<{ backlog: boolean; status: string }>>`
      SELECT backlog, status FROM kernel.node_jobs WHERE id = ${resumed.id}`
    expect(flags).toEqual({ backlog: false, status: "queued" })

    const ws = await connect(node)
    expect(ws.frames.some((f) => f.type === "node_job_offer" && f.jobId === resumed.id)).toBe(true)
    expect((await jobRow(resumed.id)).status).toBe("offered")
  })

  it("a session with no sdk_session_id is requeued with its prompt", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node, { sdk: false })
    await sql`UPDATE kernel.node_jobs SET claimed_at = now() - interval '5 minutes' WHERE id = ${s.jobId}`
    expect((await report(node, [])).status).toBe(200)
    const again = await otherJobs(s.jobId)
    expect(again).toHaveLength(1)
    expect(again[0]).toMatchObject({ prompt: "Fix the flaky test", resume_after: null })
    expect((await sessionRow(s.sessionId)).status).toBe("queued")
  })

  it("a run claimed seconds ago is not judged dead by a report", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    expect((await report(node, [])).status).toBe(200)
    expect((await jobRow(s.jobId)).status).toBe("running")
  })

  it("a lapsed lease while the node is offline pauses and never interrupts", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    await disconnect(node)
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '30 minutes'
               WHERE id = ${s.jobId}`
    await sweepNodeLeases()
    expect(await jobRow(s.jobId)).toMatchObject({ status: "running", lease_holder: node.nodeId })
    expect((await sessionRow(s.sessionId)).status).toBe("paused")
    expect(await otherJobs(s.jobId)).toHaveLength(0)
  })

  it("a lapsed lease over 10 minutes with the node online resumes; under 10 minutes it pauses", async () => {
    const node = await enable()
    const other = await enable()
    await connect(node)
    await connect(other)
    const recent = await running(node)
    const old = await running(other)
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '2 minutes'
               WHERE id = ${recent.jobId}`
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '11 minutes'
               WHERE id = ${old.jobId}`
    await sweepNodeLeases()
    expect((await jobRow(recent.jobId)).status).toBe("running")
    expect((await sessionRow(recent.sessionId)).status).toBe("paused")
    expect((await jobRow(old.jobId)).status).toBe("interrupted")
    const row = await sessionRow(old.sessionId)
    expect(row.status).toBe("queued")
    expect((await jobRow(row.job_id)).resume_after).toBe("offline")
  })

  it("W2-D4: a reply to a paused session wakes its connected node; the node's report without that run ends it and resumes with the reply", async () => {
    const node = await enable()
    const ws = await connect(node)
    const s = await running(node)
    // The node lost the run's result (a 401) and stopped heartbeating it.
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '2 minutes',
                                          claimed_at = now() - interval '5 minutes'
               WHERE id = ${s.jobId}`
    await sweepNodeLeases()
    expect((await sessionRow(s.sessionId)).status).toBe("paused")
    ws.frames.length = 0
    const sent = await call(`/api/me/node-sessions/${s.sessionId}/commands`, "POST", {
      type: "message",
      payload: { text: "foo" },
    })
    expect(sent.status).toBe(201)
    const { commandId } = (await json(sent)).data
    expect(
      ws.frames.some((f) => f.type === "node_session_command" && f.sessionId === s.sessionId),
    ).toBe(true)
    // The woken node runs nothing for that session: it reports what is alive.
    expect((await report(node, [])).status).toBe(200)
    expect(await jobRow(s.jobId)).toMatchObject({
      status: "interrupted",
      error_code: "lease_expired",
      lease_holder: null,
    })
    const resumed = await otherJobs(s.jobId)
    expect(resumed).toHaveLength(1)
    expect(resumed[0]).toMatchObject({
      prompt: "foo",
      resume_after: "message",
      resume_command_id: commandId,
    })
    expect((await sessionRow(s.sessionId)).status).toBe("queued")
  })

  it("W2-D4: the 10-minute sweep resumes a dead run with the reply it never read", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    await disconnect(node)
    await onNodeConnectionClosed({ orgId: owner.orgId, userId: owner.userId, nodeId: node.nodeId })
    const sent = await call(`/api/me/node-sessions/${s.sessionId}/commands`, "POST", {
      type: "message",
      payload: { text: "are you there?" },
    })
    const { commandId } = (await json(sent)).data
    await connect(node)
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '11 minutes'
               WHERE id = ${s.jobId}`
    await sweepNodeLeases()
    expect((await jobRow(s.jobId)).status).toBe("interrupted")
    const resumed = await otherJobs(s.jobId)
    expect(resumed).toHaveLength(1)
    expect(resumed[0]).toMatchObject({ resume_after: "message", resume_command_id: commandId })
  })

  it("W2-D4 review: a resume run started for a message that dies before reading it fails the message, never resumes with it again", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    await disconnect(node)
    await onNodeConnectionClosed({ orgId: owner.orgId, userId: owner.userId, nodeId: node.nodeId })
    const sent = await call(`/api/me/node-sessions/${s.sessionId}/commands`, "POST", {
      type: "message",
      payload: { text: "are you there?" },
    })
    const { commandId } = (await json(sent)).data
    await connect(node)
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '11 minutes'
               WHERE id = ${s.jobId}`
    await sweepNodeLeases()
    const [resume] = await otherJobs(s.jobId)
    expect(resume).toMatchObject({ resume_after: "message", resume_command_id: commandId })
    // The resume run starts, then dies before it acks the message.
    const claimed = await call(`/api/nodes/jobs/${resume.id}/claim`, "POST", {}, node.credential)
    expect(claimed.status).toBe(200)
    const gen = (await json(claimed)).data.leaseGeneration as number
    expect(
      (
        await call(
          `/api/nodes/jobs/${resume.id}/started`,
          "POST",
          { leaseGeneration: gen },
          node.credential,
        )
      ).status,
    ).toBe(200)
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '11 minutes'
               WHERE id = ${resume.id}`
    await sweepNodeLeases()
    expect((await jobRow(resume.id)).status).toBe("interrupted")
    const [cmd] = await sql<Array<{ outcome: string | null }>>`
      SELECT outcome FROM kernel.node_session_commands WHERE id = ${commandId}`
    expect(cmd?.outcome).toBe("failed")
    const later = (await otherJobs(s.jobId)).filter((j) => j.id !== resume.id)
    expect(later.filter((j) => j.resume_command_id === commandId)).toEqual([])
    expect(later.map((j) => j.resume_after)).toEqual(["offline"])
  })

  it("a job failed with code stopped ends the session stopped and the job cancelled", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    const res = await call(
      `/api/nodes/jobs/${s.jobId}/fail`,
      "POST",
      { leaseGeneration: s.gen, error: "Stopped by you.", code: "stopped" },
      node.credential,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).data.status).toBe("cancelled")
    expect((await jobRow(s.jobId)).status).toBe("cancelled")
    const row = await sessionRow(s.sessionId)
    expect(row.status).toBe("stopped")
    expect(row.ended_at).not.toBeNull()
  })

  it("a run that completes with an unacked message creates exactly one resume job with that command id", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    const sent = await call(`/api/me/node-sessions/${s.sessionId}/commands`, "POST", {
      type: "message",
      payload: { text: "Also list the .claude folder" },
    })
    expect(sent.status).toBe(201)
    const { commandId } = (await json(sent)).data
    const done = await call(
      `/api/nodes/jobs/${s.jobId}/result`,
      "POST",
      { leaseGeneration: s.gen, text: "Fixed." },
      node.credential,
    )
    expect(done.status).toBe(201)
    const resumed = await otherJobs(s.jobId)
    expect(resumed).toHaveLength(1)
    expect(resumed[0]).toMatchObject({
      prompt: "Also list the .claude folder",
      resume_after: "message",
      resume_command_id: commandId,
    })
    expect((await sessionRow(s.sessionId)).status).toBe("queued")
  })

  it("a resume run that ends without reading its message acks it failed instead of looping", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    await sql`UPDATE kernel.node_jobs SET status = 'done', lease_holder = NULL WHERE id = ${s.jobId}`
    await sql`UPDATE kernel.node_sessions SET status = 'done', ended_at = now() WHERE id = ${s.sessionId}`
    const sent = await call(`/api/me/node-sessions/${s.sessionId}/commands`, "POST", {
      type: "message",
      payload: { text: "Continue" },
    })
    const { commandId } = (await json(sent)).data
    const [resume] = await otherJobs(s.jobId)
    const claimed = await call(`/api/nodes/jobs/${resume.id}/claim`, "POST", {}, node.credential)
    const gen = (await json(claimed)).data.leaseGeneration as number
    await call(
      `/api/nodes/jobs/${resume.id}/fail`,
      "POST",
      { leaseGeneration: gen, error: "the model is gone", code: "model_unavailable" },
      node.credential,
    )
    expect(await otherJobs(s.jobId)).toHaveLength(1)
    const [cmd] = await sql<Array<{ outcome: string | null }>>`
      SELECT outcome FROM kernel.node_session_commands WHERE id = ${commandId}`
    expect(cmd.outcome).toBe("failed")
  })

  it("a resume run that ends without reading its messages fails every one of them, none left queued (m3)", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    await sql`UPDATE kernel.node_jobs SET status = 'done', lease_holder = NULL WHERE id = ${s.jobId}`
    await sql`UPDATE kernel.node_sessions SET status = 'done', ended_at = now() WHERE id = ${s.sessionId}`
    const ids: string[] = []
    for (const text of ["Continue", "And also this"]) {
      const sent = await call(`/api/me/node-sessions/${s.sessionId}/commands`, "POST", {
        type: "message",
        payload: { text },
      })
      expect(sent.status).toBe(201)
      ids.push((await json(sent)).data.commandId as string)
    }
    const [resume] = await otherJobs(s.jobId)
    const claimed = await call(`/api/nodes/jobs/${resume.id}/claim`, "POST", {}, node.credential)
    const gen = (await json(claimed)).data.leaseGeneration as number
    await call(
      `/api/nodes/jobs/${resume.id}/fail`,
      "POST",
      { leaseGeneration: gen, error: "the model is gone", code: "model_unavailable" },
      node.credential,
    )
    expect(await otherJobs(s.jobId)).toHaveLength(1)
    const cmds = await sql<Array<{ id: string; outcome: string | null }>>`
      SELECT id, outcome FROM kernel.node_session_commands WHERE session_id = ${s.sessionId}`
    expect(Object.fromEntries(cmds.map((c) => [c.id, c.outcome]))).toEqual({
      [ids[0]]: "failed",
      [ids[1]]: "failed",
    })
    const failedEvents = (await events(s.sessionId)).filter(
      (e) => e.type === "command_applied" && e.payload.outcome === "failed",
    )
    expect(failedEvents.map((e) => e.payload.commandId)).toEqual(ids)
  })

  it("the claim of a resume job answers resume with the sdk session id", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    await sql`UPDATE kernel.node_jobs SET status = 'done', lease_holder = NULL WHERE id = ${s.jobId}`
    await sql`UPDATE kernel.node_sessions SET status = 'done', ended_at = now() WHERE id = ${s.sessionId}`
    const sent = await call(`/api/me/node-sessions/${s.sessionId}/commands`, "POST", {
      type: "message",
      payload: { text: "What did you do before?" },
    })
    const { commandId } = (await json(sent)).data
    const [resume] = await otherJobs(s.jobId)
    const claimed = await call(`/api/nodes/jobs/${resume.id}/claim`, "POST", {}, node.credential)
    expect(claimed.status).toBe(200)
    expect((await json(claimed)).data.session).toMatchObject({
      id: s.sessionId,
      resume: { sdkSessionId: "sdk-1", after: "message", commandId },
    })
    // A fresh session's claim carries no resume (on a second node).
    const second = await enable()
    await connect(second)
    const fresh = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId: null,
      source: "app",
      prompt: "p",
      sourceRequiredScopes: [],
      targetNodeId: second.nodeId,
      session: { source: "app", configKind: "owner", model: MODEL, level: "strict" },
    })
    const c2 = await call(`/api/nodes/jobs/${fresh.id}/claim`, "POST", {}, second.credential)
    expect((await json(c2)).data.session.resume).toBeUndefined()
  })

  it("S51: a confirmed message's resume claim carries confirmDrivenElsewhere; an unconfirmed one does not", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    const resumeClaim = async (payload: Record<string, unknown>) => {
      await sql`UPDATE kernel.node_jobs SET status = 'done', lease_holder = NULL WHERE org_id = ${owner.orgId} AND status <> 'done'`
      await sql`UPDATE kernel.node_sessions SET status = 'done', ended_at = now() WHERE id = ${s.sessionId}`
      const sent = await call(`/api/me/node-sessions/${s.sessionId}/commands`, "POST", {
        type: "message",
        payload,
      })
      expect(sent.status).toBeLessThan(300)
      const { commandId } = (await json(sent)).data
      const [job] = await sql<Array<{ id: string }>>`
        SELECT id FROM kernel.node_jobs WHERE resume_command_id = ${commandId}`
      const claimed = await call(`/api/nodes/jobs/${job.id}/claim`, "POST", {}, node.credential)
      expect(claimed.status).toBe(200)
      return { commandId, resume: (await json(claimed)).data.session.resume }
    }
    const confirmed = await resumeClaim({ text: "go on anyway", confirmDrivenElsewhere: true })
    expect(confirmed.resume).toEqual({
      sdkSessionId: "sdk-1",
      after: "message",
      commandId: confirmed.commandId,
      confirmDrivenElsewhere: true,
    })
    const plain = await resumeClaim({ text: "and now?" })
    expect(plain.resume).toEqual({
      sdkSessionId: "sdk-1",
      after: "message",
      commandId: plain.commandId,
    })
  })

  it("a resume keeps the session's current level, never the profile's re-read (M3)", async () => {
    const node = await enable()
    await connect(node)
    await sql`INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, level, liaison_tools)
              VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, 'standard', true)`
    try {
      const threadId = await minimal.thread(owner.orgId, owner.userId)
      const job = await createNodeJob({
        orgId: owner.orgId,
        ownerUserId: owner.userId,
        agentId,
        threadId,
        source: "dispatch",
        prompt: "Fix the flaky test",
        sourceRequiredScopes: [],
        targetNodeId: node.nodeId,
        session: { source: "dispatch", configKind: "owner", model: MODEL, level: "strict" },
      })
      const claimed = await call(`/api/nodes/jobs/${job.id}/claim`, "POST", {}, node.credential)
      expect(claimed.status).toBe(200)
      // A dispatch runs at the profile's level (D24).
      expect((await json(claimed)).data.session.level).toBe("standard")
      // The owner lowered this session; its run then died.
      const sessionId = job.sessionId as string
      await sql`UPDATE kernel.node_sessions SET level = 'strict' WHERE id = ${sessionId}`
      await sql`UPDATE kernel.node_jobs SET claimed_at = now() - interval '5 minutes',
                       started_at = now() WHERE id = ${job.id}`
      expect((await report(node, [])).status).toBe(200)
      const [resume] = await otherJobs(job.id)
      expect(resume).toBeDefined()
      const again = await call(`/api/nodes/jobs/${resume.id}/claim`, "POST", {}, node.credential)
      expect(again.status).toBe(200)
      expect((await json(again)).data.session).toMatchObject({
        level: "strict",
        profileLevel: "standard",
      })
      const [row] = await sql<Array<{ level: string }>>`
        SELECT level FROM kernel.node_sessions WHERE id = ${sessionId}`
      expect(row.level).toBe("strict")
    } finally {
      await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
    }
  })

  it("a Stop pending on a paused session whose process died ends it stopped, with no resume run (M4)", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    await disconnect(node)
    await onNodeConnectionClosed({ orgId: owner.orgId, userId: owner.userId, nodeId: node.nodeId })
    expect((await sessionRow(s.sessionId)).status).toBe("paused")
    const queuedMsg = await call(`/api/me/node-sessions/${s.sessionId}/commands`, "POST", {
      type: "message",
      payload: { text: "and then this" },
    })
    expect(queuedMsg.status).toBe(201)
    const stop = await call(`/api/me/node-sessions/${s.sessionId}/commands`, "POST", {
      type: "stop",
      payload: {},
    })
    expect(stop.status).toBe(201)
    const stopId = (await json(stop)).data.commandId as string
    const msgId = (await json(queuedMsg)).data.commandId as string
    // The node comes back: the process is gone.
    await connect(node)
    await sql`UPDATE kernel.node_jobs SET claimed_at = now() - interval '5 minutes' WHERE id = ${s.jobId}`
    expect((await report(node, [])).status).toBe(200)
    expect(await otherJobs(s.jobId)).toHaveLength(0)
    const row = await sessionRow(s.sessionId)
    expect(row.status).toBe("stopped")
    expect(row.ended_at).not.toBeNull()
    expect((await jobRow(s.jobId)).status).not.toBe("running")
    const acks = await sql<Array<{ id: string; outcome: string | null }>>`
      SELECT id, outcome FROM kernel.node_session_commands WHERE session_id = ${s.sessionId}`
    expect(Object.fromEntries(acks.map((a) => [a.id, a.outcome]))).toEqual({
      [stopId]: "applied",
      [msgId]: "cancelled",
    })
  })

  it("S7: mark_done on a paused session whose run dies ends done, no resume run", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node, { protocol: "3" })
    await disconnect(node)
    await onNodeConnectionClosed({ orgId: owner.orgId, userId: owner.userId, nodeId: node.nodeId })
    expect((await sessionRow(s.sessionId)).status).toBe("paused")
    const queuedMsg = await call(`/api/me/node-sessions/${s.sessionId}/commands`, "POST", {
      type: "message",
      payload: { text: "and then this" },
    })
    expect(queuedMsg.status).toBe(201)
    const mark = await call(`/api/me/node-sessions/${s.sessionId}/commands`, "POST", {
      type: "mark_done",
      payload: { summary: "Fine as it is." },
    })
    expect(mark.status).toBe(201)
    const markId = (await json(mark)).data.commandId as string
    const msgId = (await json(queuedMsg)).data.commandId as string
    // The node comes back: the process is gone.
    await connect(node)
    await sql`UPDATE kernel.node_jobs SET claimed_at = now() - interval '5 minutes' WHERE id = ${s.jobId}`
    expect((await report(node, [])).status).toBe(200)
    expect(await otherJobs(s.jobId)).toHaveLength(0)
    const row = await sessionRow(s.sessionId)
    expect(row.status).toBe("done")
    expect(row.ended_at).not.toBeNull()
    const [summary] = await sql<Array<{ result_summary: string | null }>>`
      SELECT result_summary FROM kernel.node_sessions WHERE id = ${s.sessionId}`
    expect(summary.result_summary).toBe("Fine as it is.")
    expect((await jobRow(s.jobId)).status).not.toBe("running")
    const status = (await events(s.sessionId)).filter((e) => e.type === "status").at(-1)
    expect(status?.payload).toEqual({ status: "done", reason: "marked_done_by_owner" })
    const acks = await sql<Array<{ id: string; outcome: string | null }>>`
      SELECT id, outcome FROM kernel.node_session_commands WHERE session_id = ${s.sessionId}`
    expect(Object.fromEntries(acks.map((a) => [a.id, a.outcome]))).toEqual({
      [markId]: "applied",
      [msgId]: "cancelled",
    })
  })

  it("S12: a resume after needs_you fires fireSessionStatus from needs_you to queued/running", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    const fired: SessionStatusChange[] = []
    const off = onSessionStatus((_row, change) => void fired.push(change))
    try {
      const ended = await call(
        `/api/nodes/jobs/${s.jobId}/result`,
        "POST",
        { leaseGeneration: s.gen, text: "Which of the two names?" },
        node.credential,
      )
      expect(ended.status).toBe(201)
      expect((await sessionRow(s.sessionId)).status).toBe("needs_you")
      expect(fired.map((c) => [c.from, c.to])).toEqual([["running", "needs_you"]])
      const sent = await call(`/api/me/node-sessions/${s.sessionId}/commands`, "POST", {
        type: "message",
        payload: { text: "Use foo." },
      })
      expect(sent.status).toBe(201)
      const [resume] = await otherJobs(s.jobId)
      const claimed = await call(`/api/nodes/jobs/${resume.id}/claim`, "POST", {}, node.credential)
      expect(claimed.status).toBe(200)
      expect(fired.map((c) => [c.from, c.to])).toEqual([
        ["running", "needs_you"],
        ["needs_you", "queued"],
        ["queued", "running"],
      ])
      expect(fired[0].cause).toBe("node")
    } finally {
      off()
    }
  })

  it("a silent pause clears on the current run's heartbeat or events, and wakes the node for its commands (M5)", async () => {
    const node = await enable()
    const ws = await connect(node)
    const a = await running(node)
    const b = await running(node)
    await post(node, b.sessionId, b.jobId, b.gen, 2, [permission("r1")])
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '2 minutes'
               WHERE id IN (${a.jobId}, ${b.jobId})`
    await sweepNodeLeases()
    expect((await sessionRow(a.sessionId)).status).toBe("paused")
    expect((await sessionRow(b.sessionId)).status).toBe("paused")
    const sent = await call(`/api/me/node-sessions/${a.sessionId}/commands`, "POST", {
      type: "message",
      payload: { text: "still there?" },
    })
    expect(sent.status).toBe(201)
    ws.frames.length = 0

    // The run's heartbeat: back to running, and the node is told to pull.
    const beat = await call(
      `/api/nodes/jobs/${a.jobId}/heartbeat`,
      "POST",
      { leaseGeneration: a.gen },
      node.credential,
    )
    expect(beat.status).toBe(200)
    expect((await sessionRow(a.sessionId)).status).toBe("running")
    expect(
      ws.frames.some((f) => f.type === "node_session_command" && f.sessionId === a.sessionId),
    ).toBe(true)
    // An event batch of the other run: back to waiting (its request is open).
    await post(node, b.sessionId, b.jobId, b.gen, 3, [
      { at: new Date().toISOString(), type: "assistant_text", payload: { text: "hm" } },
    ])
    expect((await sessionRow(b.sessionId)).status).toBe("waiting")
  })

  it("a run whose started signal was lost counts as started from its first event batch, so an outage pauses it (m1)", async () => {
    const node = await enable()
    await connect(node)
    const job = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId: null,
      source: "app",
      prompt: "Fix the flaky test",
      sourceRequiredScopes: [],
      targetNodeId: node.nodeId,
      session: { source: "app", configKind: "owner", model: MODEL, level: "strict" },
    })
    const claimed = await call(`/api/nodes/jobs/${job.id}/claim`, "POST", {}, node.credential)
    const gen = (await json(claimed)).data.leaseGeneration as number
    // No /started reached the server; the run's events did.
    await post(node, job.sessionId as string, job.id, gen, 1, [
      {
        at: new Date().toISOString(),
        type: "system",
        payload: { subtype: "start", text: "started", data: { sessionId: "sdk-1" } },
      },
    ])
    await disconnect(node)
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '30 minutes'
               WHERE id = ${job.id}`
    await sweepNodeLeases()
    expect(await jobRow(job.id)).toMatchObject({ status: "running", lease_holder: node.nodeId })
    expect((await sessionRow(job.sessionId as string)).status).toBe("paused")
    expect(await otherJobs(job.id)).toHaveLength(0)
  })

  it("rerun and discard of a session job answer use_session_commands; an interactive job still reruns", async () => {
    const node = await enable()
    await connect(node)
    const s = await running(node)
    await sql`UPDATE kernel.node_jobs SET status = 'interrupted', lease_holder = NULL WHERE id = ${s.jobId}`
    for (const action of ["rerun", "discard"]) {
      const res = await call(`/api/nodes/jobs/${s.jobId}/${action}`, "POST")
      expect(res.status).toBe(409)
      expect((await json(res)).error.code).toBe("use_session_commands")
    }
    const threadId = await minimal.thread(owner.orgId, owner.userId)
    const [chat] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_jobs (org_id, owner_user_id, agent_id, thread_id, source, kind, prompt, status)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${threadId}, 'chat', 'interactive', 'hi',
              'interrupted') RETURNING id`
    expect((await call(`/api/nodes/jobs/${chat.id}/rerun`, "POST")).status).toBe(200)
  })
})

describe("node close grace", () => {
  it("a 1012 close keeps the node session for 30 s", () => {
    // A server restart: the node reconnects to another process, which takes
    // longer than a page reload; its sessions must not pause meanwhile.
    expect(NODE_RESTART_GRACE_MS).toBe(30_000)
    expect(nodeCloseGraceMs(1012)).toBe(NODE_RESTART_GRACE_MS)
    expect(nodeCloseGraceMs(1006)).toBe(NODE_CLOSE_GRACE_MS)
    expect(nodeCloseGraceMs(undefined)).toBe(NODE_CLOSE_GRACE_MS)
  })
})
