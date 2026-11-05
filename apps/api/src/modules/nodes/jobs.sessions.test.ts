// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T17 (S16, S17, L24, L25, L29, L30, D33, D36, D41, D46): every unattended
// node job is a session's current run, and the server owns the session's
// status. Creation makes exactly one session (none for My node chat, none on a
// refusal); a newer routine tick stops the older queued one as replaced; the
// claim answers the session as the CLAIMING node runs it (its own folder
// path, the model resolved among its models, the level, the confirmations of
// this session only); an outdated node is refused in words; fail, complete,
// interrupted, requeue, discard and re-run map per the job-to-session table.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { attachConfirmation, insertLevelConfirmation } from "~/modules/node-sessions/confirmations"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { attachmentCapRefusal } from "./attachments"
import { onNodeConnectionHello } from "./hooks"
import {
  type CreateNodeJobInput,
  createNodeJob,
  NodeJobRefusedError,
  type NodeJobSessionInput,
  sweepNodeLeases,
} from "./jobs"

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

const HAIKU = "claude-haiku-4-5-20251001"
const OPUS = "claude-opus-4-5-20251101"

describe("node jobs carry sessions (P1-T17)", () => {
  let owner: minimal.Session
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  let agentId: string
  let threadId: string
  const sockets: FakeWs[] = []

  const call = (
    path: string,
    method: string,
    body?: unknown,
    nodeCredential?: string,
    protocol: string | null = "2",
  ) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${owner.bearer}`,
        ...(nodeCredential ? { "X-Node-Credential": nodeCredential } : {}),
        ...(nodeCredential && protocol ? { "X-Liaison-Node-Protocol": protocol } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const json = async (res: Response) => (await res.json()) as any

  async function enable(folders: Array<{ name: string; path: string; kind?: string }> = []) {
    const res = await call("/api/nodes", "POST", { deviceId: `d.${crypto.randomUUID()}` })
    expect(res.status).toBe(201)
    const d = (await json(res)).data
    const n = {
      nodeId: d.node.id as string,
      credential: d.credential as string,
      deviceId: d.node.deviceId as string,
    }
    const caps = await call(
      `/api/nodes/${n.nodeId}/capabilities`,
      "PUT",
      {
        sharedFolders: folders.map((f) => ({ kind: "root", ...f })),
        models: [{ id: HAIKU, label: "Haiku 4.5" }],
      },
      n.credential,
    )
    expect(caps.status).toBe(200)
    return n
  }

  async function connect(node: { deviceId: string; credential: string }) {
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
      bindConnection: (nodeId) => manager.markNodeConnection(ws, nodeId),
    })
    return ws
  }

  type Source = "dispatch" | "app" | "routine" | "agent_tag"
  function newJob(
    source: Source,
    over: Omit<Partial<CreateNodeJobInput>, "session"> & {
      session?: Partial<NodeJobSessionInput>
    } = {},
  ) {
    const { session, ...rest } = over
    return createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId: source === "app" ? null : threadId,
      source,
      prompt: "Fix the flaky test\nand push it",
      sourceRequiredScopes: [],
      ...rest,
      session: {
        source,
        configKind: source === "routine" || source === "agent_tag" ? "isolated" : "owner",
        model: source === "routine" || source === "agent_tag" ? "default" : HAIKU,
        level: "strict",
        ...session,
      } as NodeJobSessionInput,
    })
  }

  const claim = (jobId: string, cred: string, protocol: string | null = "2") =>
    call(`/api/nodes/jobs/${jobId}/claim`, "POST", {}, cred, protocol)

  async function sessionOf(jobId: string) {
    const [row] = await sql<
      Array<{
        id: string
        status: string
        node_id: string | null
        job_id: string | null
        folder_path: string | null
        model: string
        level: string
        error: string | null
        result_summary: string | null
        started_at: Date | null
        ended_at: Date | null
      }>
    >`SELECT id, status, node_id, job_id, folder_path, model, level, error, result_summary,
             started_at, ended_at
        FROM kernel.node_sessions WHERE job_id = ${jobId}`
    return row
  }

  async function statusEvents(sessionId: string) {
    const rows = await sql<Array<{ seq: number; payload: Record<string, unknown> }>>`
      SELECT seq, payload FROM kernel.node_session_events
       WHERE session_id = ${sessionId} AND type = 'status' ORDER BY seq`
    return rows.map((r): Record<string, unknown> => ({ seq: r.seq, ...r.payload }))
  }

  async function jobRow(id: string) {
    const [row] = await sql<Array<{ status: string; error_code: string | null }>>`
      SELECT status, error_code FROM kernel.node_jobs WHERE id = ${id}`
    return row
  }

  async function routine(over: { model?: string } = {}) {
    const [row] = await sql<{ id: string }[]>`INSERT INTO kernel.routines
      (org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone,
       prompt, scopes, created_by_actor_type, model)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${`r-${crypto.randomUUID()}`}, 'd',
              'recurring', '0 9 * * *', 'UTC', 'p', '{}', 'user', ${over.model ?? null})
      RETURNING id`
    return row.id
  }

  beforeAll(async () => {
    await acquireTestLock()
    owner = await minimal.session((await createTestOrg()).id)
    previous = getWsManager()
    manager = new WebSocketManager(redis)
    setWsManager(manager)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@js-${crypto.randomUUID().slice(0, 8)}`}, 'Fixer',
              '["kernel:threads:read","kernel:threads:write"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
  })

  beforeEach(async () => {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(20)
    await sql`DELETE FROM kernel.node_level_confirmations WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    threadId = await minimal.thread(owner.orgId, owner.userId)
  })

  afterAll(async () => {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    if (owner) {
      await sql`DELETE FROM kernel.node_level_confirmations WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.routine_runs WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.routines WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  // ── create ───────────────────────────────────────────────────────────────

  it("a dispatch, app, routine and agent_tag job each create exactly one session; an interactive job none", async () => {
    for (const source of ["dispatch", "app", "routine", "agent_tag"] as const) {
      const job = await newJob(source)
      expect(job.sessionId).toBeDefined()
      const rows = await sql<Array<{ id: string; source: string; status: string; title: string }>>`
        SELECT id, source, status, title FROM kernel.node_sessions WHERE job_id = ${job.id}`
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        id: job.sessionId,
        source,
        status: "queued",
        title: "Fix the flaky test",
      })
      expect(await statusEvents(rows[0].id)).toEqual([{ seq: 1, status: "queued" }])
    }
    const interactive = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId,
      source: "chat",
      kind: "interactive",
      prompt: "hello",
      sourceRequiredScopes: [],
      session: { source: "app", configKind: "owner", model: HAIKU, level: "strict" },
    })
    expect(interactive.sessionId).toBeUndefined()
    const none = await sql`SELECT id FROM kernel.node_sessions WHERE job_id = ${interactive.id}`
    expect(none).toHaveLength(0)
  })

  it("a refused creation leaves no session", async () => {
    await expect(
      newJob("dispatch", { sourceRequiredScopes: ["nodetest:secret:read"] }),
    ).rejects.toBeInstanceOf(NodeJobRefusedError)
    const rows = await sql`SELECT id FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    expect(rows).toHaveLength(0)
  })

  it("a newer routine tick stops the older queued session as replaced", async () => {
    const routineId = await routine()
    const older = await newJob("routine", { routineId, prompt: "tick 1" })
    const newer = await newJob("routine", { routineId, prompt: "tick 2" })
    const stopped = await sessionOf(older.id)
    expect(stopped.status).toBe("stopped")
    expect(stopped.ended_at).not.toBeNull()
    expect((await statusEvents(stopped.id)).at(-1)).toMatchObject({
      status: "stopped",
      reason: "replaced",
    })
    expect((await sessionOf(newer.id)).status).toBe("queued")
  })

  // ── claim ────────────────────────────────────────────────────────────────

  it("the claim answers the session with folder path, model and level, and the session is running with a status event", async () => {
    const n = await enable([{ name: "code", path: "/Users/someone/code" }])
    const job = await newJob("app", {
      targetNodeId: n.nodeId,
      session: { folderName: "code", folderPath: "/Users/someone/code" },
    })
    const res = await claim(job.id, n.credential)
    expect(res.status).toBe(200)
    const d = (await json(res)).data
    expect(d.session).toEqual({
      id: job.sessionId,
      folderPath: "/Users/someone/code",
      folderName: "code",
      repo: null,
      model: HAIKU,
      level: "strict",
      profileLevel: "strict",
      effort: null,
      autonomy: "guided",
      finishWith: null,
      configKind: "owner",
      liaisonTools: true,
    })
    const s = await sessionOf(job.id)
    expect(s).toMatchObject({ status: "running", node_id: n.nodeId, job_id: job.id })
    expect(s.started_at).not.toBeNull()
    expect((await statusEvents(s.id)).map((e) => e.status)).toEqual(["queued", "running"])
  })

  it("W2-D5: the claim names another in-place session that still holds the folder (waiting on the owner); none once it ended, none for another folder", async () => {
    const n = await enable([
      { name: "code", path: "/Users/someone/code" },
      { name: "other", path: "/Users/someone/other" },
    ])
    const first = await newJob("app", {
      targetNodeId: n.nodeId,
      session: { folderName: "code", folderPath: "/Users/someone/code" },
    })
    expect((await claim(first.id, n.credential)).status).toBe(200)
    // The first session ended its turn on a question: it waits on the owner.
    await sql`UPDATE kernel.node_sessions SET status = 'needs_you', title = 'Fix cart total'
               WHERE id = ${first.sessionId as string}`
    const second = await newJob("dispatch", {
      targetNodeId: n.nodeId,
      session: { folderName: "code", folderPath: "/Users/someone/code" },
    })
    const d = (await json(await claim(second.id, n.credential))).data
    expect(d.session.folderHeldBy).toBe(
      `"Fix cart total" (${String(first.sessionId).slice(0, 8)}, waiting on you)`,
    )
    // Another folder is not held.
    const elsewhere = await newJob("dispatch", {
      targetNodeId: n.nodeId,
      session: { folderName: "other", folderPath: "/Users/someone/other" },
    })
    const e = (await json(await claim(elsewhere.id, n.credential))).data
    expect(e.session.folderHeldBy).toBeUndefined()
    // Once the first one ends, the folder is free again.
    await sql`UPDATE kernel.node_sessions SET status = 'done' WHERE id = ${first.sessionId as string}`
    await sql`UPDATE kernel.node_sessions SET status = 'done' WHERE id = ${second.sessionId as string}`
    const third = await newJob("dispatch", {
      targetNodeId: n.nodeId,
      session: { folderName: "code", folderPath: "/Users/someone/code" },
    })
    const t = (await json(await claim(third.id, n.credential))).data
    expect(t.session.folderHeldBy).toBeUndefined()
  })

  it("a routine session with folder X claims with X's path on the claiming node; with two nodes, each claim gets its own node's path", async () => {
    const a = await enable([{ name: "code", path: "/Users/a/code" }])
    const b = await enable([{ name: "code", path: "/Volumes/b/code" }])
    const first = await newJob("routine", {
      routineId: await routine(),
      session: { folderName: "code" },
    })
    const second = await newJob("routine", {
      routineId: await routine(),
      session: { folderName: "code" },
    })
    const ca = (await json(await claim(first.id, a.credential))).data
    const cb = (await json(await claim(second.id, b.credential))).data
    expect(ca.session.folderPath).toBe("/Users/a/code")
    expect(cb.session.folderPath).toBe("/Volumes/b/code")
    // "default" resolves among the claiming node's models, and the row says which.
    expect(ca.session.model).toBe(HAIKU)
    expect((await sessionOf(first.id)).model).toBe(HAIKU)
    expect((await sessionOf(second.id)).folder_path).toBe("/Volumes/b/code")
    // A node that does not share the folder answers no path: the node fails folder_missing.
    const c = await enable([{ name: "notes", path: "/Users/c/notes" }])
    const third = await newJob("routine", {
      routineId: await routine(),
      session: { folderName: "code" },
    })
    const cc = (await json(await claim(third.id, c.credential))).data
    expect(cc.session).toMatchObject({ folderPath: null, folderName: "code" })
  })

  it("the claim carries the profile confirmation at the profile level and this session's session_start, never another session's", async () => {
    const n = await enable()
    await sql`INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, level)
              VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, 'standard')`
    const mint = async (purpose: "profile_raise" | "session_start", level: "standard" | "open") =>
      (
        await insertLevelConfirmation({
          orgId: owner.orgId,
          ownerUserId: owner.userId,
          nodeId: n.nodeId,
          agentId,
          level,
          purpose,
        })
      ).id
    const attach = (
      id: string,
      purpose: "profile_raise" | "session_start",
      level: "standard" | "open",
      attachedSessionId?: string,
    ) =>
      withPrivilegedDb(owner.orgId, "test-attach", (tx) =>
        attachConfirmation(tx, {
          id,
          orgId: owner.orgId,
          ownerUserId: owner.userId,
          nodeId: n.nodeId,
          agentId,
          level,
          purpose,
          attachedSessionId,
        }),
      )
    // An Open raise attached first, then the standard one: the newer
    // supersedes it, and a claim hands out only the profile level's.
    const stray = await mint("profile_raise", "open")
    expect((await attach(stray, "profile_raise", "open")).ok).toBe(true)
    const raise = await mint("profile_raise", "standard")
    expect((await attach(raise, "profile_raise", "standard")).ok).toBe(true)

    const jobA = await newJob("app", { targetNodeId: n.nodeId, session: { level: "open" } })
    const jobB = await newJob("app", { targetNodeId: n.nodeId, session: { level: "open" } })
    const start = await mint("session_start", "open")
    expect((await attach(start, "session_start", "open", jobA.sessionId)).ok).toBe(true)

    const b = (await json(await claim(jobB.id, n.credential))).data
    expect(b.session).toMatchObject({
      level: "open",
      profileLevel: "standard",
      profileConfirmationId: raise,
    })
    expect(b.session.sessionConfirmationId).toBeUndefined()
    const fail = await call(
      `/api/nodes/jobs/${jobB.id}/fail`,
      "POST",
      { leaseGeneration: b.leaseGeneration, error: "level_unconfirmed", code: "level_unconfirmed" },
      n.credential,
    )
    expect(fail.status).toBe(200)
    expect((await json(fail)).data.status).toBe("refused")
    expect((await sessionOf(jobB.id)).status).toBe("failed")

    const a = (await json(await claim(jobA.id, n.credential))).data
    expect(a.session).toMatchObject({
      level: "open",
      profileLevel: "standard",
      profileConfirmationId: raise,
      sessionConfirmationId: start,
    })
  })

  it("a claim without X-Liaison-Node-Protocol: 2 is 409 node_outdated and the session fails with that reason", async () => {
    const n = await enable()
    for (const protocol of [null, "1"]) {
      const job = await newJob("app", { targetNodeId: n.nodeId })
      const res = await claim(job.id, n.credential, protocol)
      expect(res.status).toBe(409)
      expect((await json(res)).error.code).toBe("node_outdated")
      expect(await jobRow(job.id)).toEqual({ status: "refused", error_code: "node_outdated" })
      const s = await sessionOf(job.id)
      expect(s.status).toBe("failed")
      expect(s.error).toContain("Update the Liaison desktop app")
      expect((await statusEvents(s.id)).at(-1)).toMatchObject({
        status: "failed",
        code: "node_outdated",
      })
    }
  })

  // ── the job-to-session table ─────────────────────────────────────────────

  it("fail, complete, interrupted and a requeue map per the job-to-session table", async () => {
    const n = await enable()
    // One running job per node: the requeue case runs on a second node.
    const m = await enable()
    const run = async (on = n) => {
      const job = await newJob("dispatch", { targetNodeId: on.nodeId })
      const d = (await json(await claim(job.id, on.credential))).data
      return { job, gen: d.leaseGeneration as number }
    }

    // fail -> failed, with the error and the end.
    const f = await run()
    expect(
      (
        await call(
          `/api/nodes/jobs/${f.job.id}/fail`,
          "POST",
          { leaseGeneration: f.gen, error: "the build broke", code: "error" },
          n.credential,
        )
      ).status,
    ).toBe(200)
    expect(await sessionOf(f.job.id)).toMatchObject({ status: "failed", error: "the build broke" })
    expect((await sessionOf(f.job.id)).ended_at).not.toBeNull()

    // complete (a completion signal) -> done; with no result event the summary is the result text.
    const c = await run()
    const done = await call(
      `/api/nodes/jobs/${c.job.id}/result`,
      "POST",
      {
        leaseGeneration: c.gen,
        text: "Fixed the flaky test and pushed node/fix-1a2b.",
        completion: { by: "session" },
      },
      n.credential,
    )
    expect(done.status).toBe(201)
    expect(await sessionOf(c.job.id)).toMatchObject({
      status: "done",
      result_summary: "Fixed the flaky test and pushed node/fix-1a2b.",
    })

    // A lease lapsed after the run started, its node offline: the session is
    // paused and the job keeps running (P3, G5), never interrupted.
    const i = await run()
    await call(
      `/api/nodes/jobs/${i.job.id}/started`,
      "POST",
      { leaseGeneration: i.gen },
      n.credential,
    )
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '1 second'
               WHERE id = ${i.job.id}`
    // A lease lapsed before it started: requeued -> queued.
    const q = await run(m)
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '1 second'
               WHERE id = ${q.job.id}`
    await sweepNodeLeases()
    expect((await jobRow(i.job.id)).status).toBe("running")
    expect((await sessionOf(i.job.id)).status).toBe("paused")
    expect((await jobRow(q.job.id)).status).toBe("queued")
    expect(await sessionOf(q.job.id)).toMatchObject({ status: "queued", ended_at: null })

    // A session's run is steered through the session (P3, L4): discard and
    // re-run answer use_session_commands (a Stop and a message instead).
    for (const [id, action] of [
      [q.job.id, "discard"],
      [i.job.id, "rerun"],
    ]) {
      const res = await call(`/api/nodes/jobs/${id}/${action}`, "POST")
      expect(res.status).toBe(409)
      expect((await json(res)).error.code).toBe("use_session_commands")
    }
  })

  it("S7: a stopped run after mark_done ends done", async () => {
    const n = await enable()
    const job = await newJob("dispatch", { targetNodeId: n.nodeId })
    const gen = (await json(await claim(job.id, n.credential, "3"))).data.leaseGeneration as number
    const session = await sessionOf(job.id)
    const sent = await call(`/api/me/node-sessions/${session.id}/commands`, "POST", {
      type: "mark_done",
      payload: { summary: "Good enough, ship it." },
    })
    expect(sent.status).toBe(201)
    // The node stops the process as for Stop and reports the run stopped.
    const res = await call(
      `/api/nodes/jobs/${job.id}/fail`,
      "POST",
      {
        leaseGeneration: gen,
        error: "Stopped by you.",
        code: "stopped",
        completion: { by: "owner", summary: "Good enough, ship it." },
      },
      n.credential,
    )
    expect(res.status).toBe(200)
    expect(await sessionOf(job.id)).toMatchObject({
      status: "done",
      result_summary: "Good enough, ship it.",
    })
    expect((await sessionOf(job.id)).ended_at).not.toBeNull()
    expect((await statusEvents(session.id)).at(-1)).toMatchObject({
      status: "done",
      reason: "marked_done_by_owner",
    })
    // A plain Stop (no mark_done) still ends stopped.
    const other = await newJob("dispatch", { targetNodeId: n.nodeId })
    const g2 = (await json(await claim(other.id, n.credential))).data.leaseGeneration as number
    await call(
      `/api/nodes/jobs/${other.id}/fail`,
      "POST",
      { leaseGeneration: g2, error: "Stopped by you.", code: "stopped" },
      n.credential,
    )
    expect((await sessionOf(other.id)).status).toBe("stopped")
  })

  it("the claim records the node's protocol on the job and answers the session's effort", async () => {
    const n = await enable()
    const job = await newJob("dispatch", { targetNodeId: n.nodeId })
    await sql`UPDATE kernel.node_sessions SET effort = 'high' WHERE job_id = ${job.id}`
    const d = (await json(await claim(job.id, n.credential, "3"))).data
    expect(d.session.effort).toBe("high")
    const [row] = await sql<Array<{ node_protocol: number | null }>>`
      SELECT node_protocol FROM kernel.node_jobs WHERE id = ${job.id}`
    expect(row.node_protocol).toBe(3)
  })

  it("S57 (D43 F2): the claim advertises the server's node protocol, 4 from wave 2", async () => {
    const n = await enable()
    const job = await newJob("dispatch", { targetNodeId: n.nodeId })
    const d = (await json(await claim(job.id, n.credential, "3"))).data
    expect(d.serverProtocol).toBe(4)
  })

  it("the offer frame carries the agent id", async () => {
    const n = await enable()
    const ws = await connect(n)
    const job = await newJob("dispatch")
    const offer = ws.frames.find((f) => f.type === "node_job_offer" && f.jobId === job.id)
    expect(offer).toEqual({ type: "node_job_offer", jobId: job.id, agentId })
  })

  it("a model_unavailable fail is refused-free and the session failed with that reason", async () => {
    const n = await enable()
    const job = await newJob("dispatch", { targetNodeId: n.nodeId })
    const gen = (await json(await claim(job.id, n.credential))).data.leaseGeneration
    const res = await call(
      `/api/nodes/jobs/${job.id}/fail`,
      "POST",
      { leaseGeneration: gen, error: "claude-opus-9 is not offered", code: "model_unavailable" },
      n.credential,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).data.status).toBe("failed")
    expect(await jobRow(job.id)).toEqual({ status: "failed", error_code: "model_unavailable" })
    expect(await sessionOf(job.id)).toMatchObject({
      status: "failed",
      error: "claude-opus-9 is not offered",
    })

    // A routine naming a model this node does not offer fails at claim, listing what it offers.
    const tick = await newJob("routine", {
      routineId: await routine({ model: "claude-opus-9" }),
      session: { model: "claude-opus-9" },
    })
    const refused = await claim(tick.id, n.credential)
    expect(refused.status).toBe(403)
    expect((await json(refused)).error.code).toBe("model_unavailable")
    const s = await sessionOf(tick.id)
    expect(s.status).toBe("failed")
    expect(s.error).toContain(HAIKU)
  })

  // ── capability refusals with two nodes (P1a skeptic S3) ──────────────────

  async function routineRun(routineId: string) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.routine_runs (org_id, routine_id, status)
      VALUES (${owner.orgId}, ${routineId}, 'dispatched') RETURNING id`
    return row.id
  }
  async function runStatus(id: string) {
    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM kernel.routine_runs WHERE id = ${id}`
    return row.status
  }
  async function routineJob(model?: string) {
    const routineId = await routine(model ? { model } : {})
    const runId = await routineRun(routineId)
    const job = await newJob("routine", {
      routineId,
      sourceRef: runId,
      ...(model ? { session: { model } } : {}),
    })
    return { job, runId, routineId }
  }

  it("an outdated node's claim leaves the job to the owner's current node", async () => {
    const current = await enable()
    const outdated = await enable()
    const { job, runId } = await routineJob()
    const res = await claim(job.id, outdated.credential, null)
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe("node_outdated")
    const waiting = await jobRow(job.id)
    expect(["queued", "offered"]).toContain(waiting.status)
    expect(waiting.error_code).toBeNull()
    expect((await sessionOf(job.id)).status).toBe("queued")
    expect(await runStatus(runId)).toBe("dispatched")
    const ok = await claim(job.id, current.credential)
    expect(ok.status).toBe(200)
    expect((await sessionOf(job.id)).status).toBe("running")
  })

  it("a node that does not offer the routine's model leaves the job to a node that does", async () => {
    const haikuOnly = await enable()
    const opusNode = await enable()
    const caps = await call(
      `/api/nodes/${opusNode.nodeId}/capabilities`,
      "PUT",
      { sharedFolders: [], models: [{ id: OPUS, label: "Opus" }] },
      opusNode.credential,
    )
    expect(caps.status).toBe(200)
    const { job, runId } = await routineJob(OPUS)
    const res = await claim(job.id, haikuOnly.credential)
    expect(res.status).toBe(403)
    expect((await json(res)).error.code).toBe("model_unavailable")
    const waiting = await jobRow(job.id)
    expect(["queued", "offered"]).toContain(waiting.status)
    expect((await sessionOf(job.id)).status).toBe("queued")
    expect(await runStatus(runId)).toBe("dispatched")
    const ok = await claim(job.id, opusNode.credential)
    expect(ok.status).toBe(200)
    expect((await json(ok)).data.session.model).toBe(OPUS)

    // A model no node of the owner offers: refused for good, the run failed.
    const none = await routineJob("claude-opus-9")
    expect((await claim(none.job.id, haikuOnly.credential)).status).toBe(403)
    expect(await jobRow(none.job.id)).toEqual({
      status: "refused",
      error_code: "model_unavailable",
    })
    expect((await sessionOf(none.job.id)).status).toBe("failed")
    expect(await runStatus(none.runId)).toBe("failed")
  })

  // Review of #63: the claim resolves against every model the node runs, as
  // creation does, so a routine on an older version runs as named; a refusal
  // names the current models only.
  it("a routine on an older version the node runs is claimed as named", async () => {
    const n = await enable()
    const caps = await call(
      `/api/nodes/${n.nodeId}/capabilities`,
      "PUT",
      {
        sharedFolders: [],
        models: ["claude-opus-5-5", "claude-haiku-5-5", "claude-opus-4-6"].map((id) => ({
          id,
          label: id,
        })),
      },
      n.credential,
    )
    expect(caps.status).toBe(200)
    const { job } = await routineJob("claude-opus-4-6")
    const ok = await claim(job.id, n.credential)
    expect(ok.status).toBe(200)
    expect((await json(ok)).data.session.model).toBe("claude-opus-4-6")
    const none = await routineJob("claude-opus-9")
    const refused = await claim(none.job.id, n.credential)
    expect(refused.status).toBe(403)
    expect((await json(refused)).error.message).toContain(
      "It offers: claude-opus-5-5, claude-haiku-5-5.",
    )
  })

  it("a refusal at claim never touches a run another node holds", async () => {
    const holder = await enable()
    const late = await enable()
    const { job, runId, routineId } = await routineJob()
    expect((await claim(job.id, holder.credential)).status).toBe(200)
    // An outdated second node, then a pre-check refusal (routine paused meanwhile).
    expect((await claim(job.id, late.credential, null)).status).toBe(409)
    await sql`UPDATE kernel.routines SET enabled = false WHERE id = ${routineId}`
    expect((await claim(job.id, late.credential)).status).toBe(403)
    expect((await jobRow(job.id)).status).toBe("running")
    expect((await sessionOf(job.id)).status).toBe("running")
    expect(await runStatus(runId)).toBe("dispatched")
  })

  it("dispatch, app and routine jobs are not counted by the daily cap", async () => {
    for (const source of ["dispatch", "app", "routine"] as const) await newJob(source)
    const route = {
      orgId: owner.orgId,
      attachmentId: crypto.randomUUID(),
      nodeOwnerUserId: owner.userId,
      agentId,
      nodeId: null,
      maxJobsPerDay: 1,
      maxTokensPerDay: 1_000_000,
    }
    expect(await attachmentCapRefusal(route)).toBeNull()
    await newJob("agent_tag")
    expect(await attachmentCapRefusal(route)).toContain("daily limit of jobs")
  })

  // ── P3-T18: parallel claims under the node's caps (L2, D35, G8) ──────────

  it("a node claims four sessions, the fifth is node_busy; the claim answers the caps", async () => {
    const n = await enable()
    const jobs = await Promise.all(
      Array.from({ length: 5 }, () => newJob("app", { targetNodeId: n.nodeId })),
    )
    for (const job of jobs.slice(0, 4)) {
      const res = await claim(job.id, n.credential)
      expect(res.status).toBe(200)
      expect((await json(res)).data.caps).toEqual({ maxLive: 4, maxBackground: 2 })
    }
    const fifth = await claim(jobs[4].id, n.credential)
    expect(fifth.status).toBe(409)
    expect(JSON.stringify(await json(fifth))).toContain("node_busy")
    // A slot frees when one run ends.
    await sql`UPDATE kernel.node_jobs SET status = 'done', lease_holder = NULL WHERE id = ${jobs[0].id}`
    expect((await claim(jobs[4].id, n.credential)).status).toBe(200)
  })

  it("a third routine job is node_busy while two run, an app session is not", async () => {
    const n = await enable()
    const bg = await Promise.all(
      Array.from({ length: 3 }, () =>
        newJob("routine", { routineId: null, sourceRef: null, targetNodeId: n.nodeId }),
      ),
    )
    // No routine id: nothing coalesces, all three stay queued.
    expect((await claim(bg[0].id, n.credential)).status).toBe(200)
    expect((await claim(bg[1].id, n.credential)).status).toBe(200)
    const third = await claim(bg[2].id, n.credential)
    expect(third.status).toBe(409)
    expect(JSON.stringify(await json(third))).toContain("node_busy")
    const appJob = await newJob("app", { targetNodeId: n.nodeId })
    expect((await claim(appJob.id, n.credential)).status).toBe(200)
  })

  it("walk D5: three claims at once under a cap of 2: exactly two win, the third is node_busy", async () => {
    const n = await enable()
    await sql`UPDATE kernel.nodes SET max_live_sessions = 2 WHERE id = ${n.nodeId}`
    const jobs = await Promise.all(
      Array.from({ length: 3 }, () => newJob("app", { targetNodeId: n.nodeId })),
    )
    const answers = await Promise.all(jobs.map((job) => claim(job.id, n.credential)))
    expect(answers.map((r) => r.status).sort()).toEqual([200, 200, 409])
    const busy = answers.find((r) => r.status === 409) as Response
    expect(JSON.stringify(await json(busy))).toContain("node_busy")
  })

  it("the caps come from the node's row: 2 live", async () => {
    const n = await enable()
    await sql`UPDATE kernel.nodes SET max_live_sessions = 2, max_live_background = 1
               WHERE id = ${n.nodeId}`
    const jobs = await Promise.all(
      Array.from({ length: 3 }, () => newJob("app", { targetNodeId: n.nodeId })),
    )
    const first = await claim(jobs[0].id, n.credential)
    expect((await json(first)).data.caps).toEqual({ maxLive: 2, maxBackground: 1 })
    expect((await claim(jobs[1].id, n.credential)).status).toBe(200)
    expect((await claim(jobs[2].id, n.credential)).status).toBe(409)
  })
})
