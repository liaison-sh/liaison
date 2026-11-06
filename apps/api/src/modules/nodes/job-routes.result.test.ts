// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T18 (S11, A25, L24): a dispatch or app session's result is its
// session's, never a chat message (the card in the conversation shows it); a
// routine's result still posts to its output thread; a re-sent result answers
// a replay; the owner reads one job by id, and nobody else does.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { appendServerEvents } from "~/modules/node-sessions/store"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createNodeJob, type NodeJobSessionInput } from "./jobs"

const HAIKU = "claude-haiku-4-5-20251001"

describe("node job results per source, and one job by id (P1-T18)", () => {
  let owner: minimal.Session
  let other: minimal.Session
  let agentId: string
  let threadId: string

  const call = (
    path: string,
    method: string,
    body?: unknown,
    nodeCredential?: string,
    session?: minimal.Session,
  ) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${(session ?? owner).bearer}`,
        ...(nodeCredential
          ? { "X-Node-Credential": nodeCredential, "X-Liaison-Node-Protocol": "2" }
          : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const json = async (res: Response) => (await res.json()) as any

  async function enable() {
    const res = await call("/api/nodes", "POST", { deviceId: `d.${crypto.randomUUID()}` })
    expect(res.status).toBe(201)
    const d = (await json(res)).data
    const node = { nodeId: d.node.id as string, credential: d.credential as string }
    const caps = await call(
      `/api/nodes/${node.nodeId}/capabilities`,
      "PUT",
      { sharedFolders: [], models: [{ id: HAIKU, label: "Haiku 4.5" }] },
      node.credential,
    )
    expect(caps.status).toBe(200)
    return node
  }

  async function run(
    source: "dispatch" | "app" | "routine",
    node: { nodeId: string; credential: string },
    routineId?: string,
  ) {
    const job = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId: source === "app" ? null : threadId,
      source,
      routineId: routineId ?? null,
      prompt: "Fix the flaky test",
      sourceRequiredScopes: [],
      targetNodeId: node.nodeId,
      session: {
        source,
        configKind: source === "routine" ? "isolated" : "owner",
        model: source === "routine" ? "default" : HAIKU,
        level: "strict",
      } as NodeJobSessionInput,
    })
    const claimed = await call(`/api/nodes/jobs/${job.id}/claim`, "POST", {}, node.credential)
    expect(claimed.status).toBe(200)
    return { job, gen: (await json(claimed)).data.leaseGeneration as number }
  }

  const result = (
    jobId: string,
    gen: number,
    cred: string,
    text: string,
    extra: Record<string, unknown> = {},
  ) =>
    call(`/api/nodes/jobs/${jobId}/result`, "POST", { leaseGeneration: gen, text, ...extra }, cred)

  /** The node's own `result` event for the session, as its batcher posts it. */
  const resultEvent = (sessionId: string, jobId: string, gen: number, cred: string, text: string) =>
    call(
      `/api/node/sessions/${sessionId}/events`,
      "POST",
      {
        jobId,
        leaseGeneration: gen,
        batchNo: 1,
        events: [{ at: new Date().toISOString(), type: "result", payload: { text } }],
      },
      cred,
    )

  async function lastStatus(jobId: string) {
    const [row] = await sql<Array<{ payload: Record<string, unknown> }>>`
      SELECT e.payload FROM kernel.node_session_events e
        JOIN kernel.node_sessions s ON s.id = e.session_id
       WHERE s.job_id = ${jobId} AND e.type = 'status' ORDER BY e.seq DESC LIMIT 1`
    return row?.payload
  }

  async function endedAt(jobId: string) {
    const [row] = await sql<Array<{ ended_at: Date | null }>>`
      SELECT ended_at FROM kernel.node_sessions WHERE job_id = ${jobId}`
    return row?.ended_at ?? null
  }

  async function messagesIn(thread: string) {
    return sql<Array<{ id: string; content: string }>>`
      SELECT id, content FROM kernel.messages WHERE thread_id = ${thread} AND author_agent_id = ${agentId}`
  }

  async function sessionOf(jobId: string) {
    const [row] = await sql<Array<{ status: string; result_summary: string | null }>>`
      SELECT status, result_summary FROM kernel.node_sessions WHERE job_id = ${jobId}`
    return row
  }

  beforeAll(async () => {
    await acquireTestLock()
    owner = await minimal.session((await createTestOrg()).id)
    other = await minimal.session(owner.orgId)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@rs-${crypto.randomUUID().slice(0, 8)}`}, 'Fixer',
              '["kernel:threads:read","kernel:threads:write"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    threadId = await minimal.thread(owner.orgId, owner.userId)
  })

  afterAll(async () => {
    if (owner) {
      await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.routines WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
    await releaseTestLock()
  })

  it("a dispatch result posts no message and the session is done with its summary", async () => {
    const n = await enable()
    const d = await run("dispatch", n)
    const done = { completion: { by: "session", summary: "Fixed it on node/fix-1a2b." } }
    const res = await result(d.job.id, d.gen, n.credential, "Fixed it on node/fix-1a2b.", done)
    expect(res.status).toBe(201)
    expect((await json(res)).data.messageId).toBeNull()
    expect(await messagesIn(threadId)).toHaveLength(0)
    expect(await sessionOf(d.job.id)).toEqual({
      status: "done",
      result_summary: "Fixed it on node/fix-1a2b.",
    })
    const [job] = await sql<Array<{ status: string; result_message_id: string | null }>>`
      SELECT status, result_message_id FROM kernel.node_jobs WHERE id = ${d.job.id}`
    expect(job).toEqual({ status: "done", result_message_id: null })
    // The node re-sends the same generation's result: a replay, nothing new.
    const again = await result(d.job.id, d.gen, n.credential, "Fixed it on node/fix-1a2b.", done)
    expect(again.status).toBe(200)
    expect((await json(again)).data).toEqual({ replay: true })
    expect(await messagesIn(threadId)).toHaveLength(0)
  })

  it("an app session's result (no conversation) completes its session", async () => {
    const n = await enable()
    const a = await run("app", n)
    const res = await result(a.job.id, a.gen, n.credential, "Done in the app.", {
      completion: { by: "session" },
    })
    expect(res.status).toBe(201)
    expect(await sessionOf(a.job.id)).toEqual({
      status: "done",
      result_summary: "Done in the app.",
    })
  })

  it("a routine result still posts to its output thread", async () => {
    const n = await enable()
    const [routine] = await sql<{ id: string }[]>`INSERT INTO kernel.routines
      (org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone,
       prompt, scopes, created_by_actor_type)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${`r-${crypto.randomUUID()}`}, 'd',
              'recurring', '0 9 * * *', 'UTC', 'p', '{}', 'user') RETURNING id`
    const r = await run("routine", n, routine.id)
    const res = await result(r.job.id, r.gen, n.credential, "The nightly report is ready.")
    expect(res.status).toBe(201)
    const { messageId } = (await json(res)).data
    expect(typeof messageId).toBe("string")
    const posted = await messagesIn(threadId)
    expect(posted.map((m) => m.content)).toEqual(["The nightly report is ready."])
    expect((await sessionOf(r.job.id)).status).toBe("done")
  })

  it("Invariant K: a mail tool's drafted text and result stay out of the stored turn", async () => {
    const n = await enable()
    const [routine] = await sql<{ id: string }[]>`INSERT INTO kernel.routines
      (org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone,
       prompt, scopes, created_by_actor_type)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${`r-${crypto.randomUUID()}`}, 'd',
              'recurring', '0 9 * * *', 'UTC', 'p', '{}', 'user') RETURNING id`
    const r = await run("routine", n, routine.id)
    const res = await result(r.job.id, r.gen, n.credential, "Replied.", {
      turn: {
        toolCalls: [
          {
            toolCallId: "toolu_mail",
            toolName: "mcp__liaison__mail__reply",
            args: { textBody: "OBSIDIANNODEDRAFT" },
            result: '{"textBody":"OBSIDIANNODERESULT"}',
            status: "completed",
          },
          {
            toolCallId: "toolu_other",
            toolName: "Bash",
            args: { command: "ls" },
            result: "a.txt",
            status: "completed",
          },
        ],
      },
    })
    expect(res.status).toBe(201)
    const { messageId } = (await json(res)).data
    const [row] = await sql<Array<{ metadata: { toolCalls: Array<Record<string, unknown>> } }>>`
      SELECT metadata FROM kernel.messages WHERE id = ${messageId}`
    const calls = row?.metadata.toolCalls ?? []
    expect(calls.map((c) => c.toolName)).toEqual(["mail__reply", "Bash"])
    expect(calls[0]?.args).toMatchObject({ redacted: true, redactedFields: ["textBody"] })
    expect(calls[0]?.result).toMatchObject({ redacted: true })
    expect(calls[1]).toMatchObject({ args: { command: "ls" }, result: "a.txt" })
    expect(JSON.stringify(calls)).not.toContain("OBSIDIANNODE")
  })

  it("S1: a dispatch result without completion ends needs_you with reason turn_ended", async () => {
    const n = await enable()
    const d = await run("dispatch", n)
    const res = await result(d.job.id, d.gen, n.credential, "Which name should I use?")
    expect(res.status).toBe(201)
    expect(await sessionOf(d.job.id)).toEqual({
      status: "needs_you",
      result_summary: "Which name should I use?",
    })
    expect(await endedAt(d.job.id)).not.toBeNull()
    expect(await lastStatus(d.job.id)).toEqual({ status: "needs_you", reason: "turn_ended" })
  })

  it("S2: completion by session ends done with the summary, after a node result event with other text", async () => {
    const n = await enable()
    const d = await run("dispatch", n)
    const sessionId = d.job.sessionId as string
    expect((await resultEvent(sessionId, d.job.id, d.gen, n.credential, "other")).status).toBe(200)
    expect((await sessionOf(d.job.id)).result_summary).toBe("other")
    const res = await result(d.job.id, d.gen, n.credential, "other", {
      completion: { by: "session", summary: "Renamed the variable to foo." },
    })
    expect(res.status).toBe(201)
    expect(await sessionOf(d.job.id)).toEqual({
      status: "done",
      result_summary: "Renamed the variable to foo.",
    })
  })

  it("S2: completion by needs_you ends needs_you with the reason as result_summary, after a node result event with other text", async () => {
    const n = await enable()
    const a = await run("app", n)
    const sessionId = a.job.sessionId as string
    expect((await resultEvent(sessionId, a.job.id, a.gen, n.credential, "other")).status).toBe(200)
    const res = await result(a.job.id, a.gen, n.credential, "other", {
      completion: { by: "needs_you", reason: "I need the staging password." },
    })
    expect(res.status).toBe(201)
    expect(await sessionOf(a.job.id)).toEqual({
      status: "needs_you",
      result_summary: "I need the staging password.",
    })
    expect(await lastStatus(a.job.id)).toEqual({
      status: "needs_you",
      reason: "I need the staging password.",
    })
  })

  it("S57: a result with completion.prUrl https sets pr_url; javascript: is refused by the schema (400)", async () => {
    const n = await enable()
    const d = await run("dispatch", n)
    const refused = await result(d.job.id, d.gen, n.credential, "Opened it.", {
      completion: { by: "session", summary: "Opened it.", prUrl: "javascript:alert(1)" },
    })
    expect(refused.status).toBe(400)
    const prUrl = "https://github.com/o/r/pull/12"
    const res = await result(d.job.id, d.gen, n.credential, "Opened it.", {
      completion: { by: "session", summary: "Opened it.", prUrl },
    })
    expect(res.status).toBe(201)
    const [row] = await sql<Array<{ status: string; pr_url: string | null }>>`
      SELECT status, pr_url FROM kernel.node_sessions WHERE job_id = ${d.job.id}`
    expect(row).toEqual({ status: "done", pr_url: prUrl })
  })

  it("S32: a completion {by:'needs_you', reasonCode:'stuck_after_5_continues'} sets reason_code and the status event reason", async () => {
    const n = await enable()
    const d = await run("dispatch", n)
    const res = await result(d.job.id, d.gen, n.credential, "Still looking.", {
      completion: { by: "needs_you", reasonCode: "stuck_after_5_continues" },
    })
    expect(res.status).toBe(201)
    const [row] = await sql<Array<{ status: string; reason_code: string | null }>>`
      SELECT status, reason_code FROM kernel.node_sessions WHERE job_id = ${d.job.id}`
    expect(row).toEqual({ status: "needs_you", reason_code: "stuck_after_5_continues" })
    expect(await lastStatus(d.job.id)).toEqual({
      status: "needs_you",
      reason: "stuck_after_5_continues",
    })
  })

  it("S36: a completion by atelier ends done", async () => {
    const n = await enable()
    const d = await run("dispatch", n)
    const res = await result(d.job.id, d.gen, n.credential, "Handoff written.", {
      completion: { by: "atelier", summary: "The pipeline is complete." },
    })
    expect(res.status).toBe(201)
    expect(await sessionOf(d.job.id)).toEqual({
      status: "done",
      result_summary: "The pipeline is complete.",
    })
  })

  it("S2: a result event appended after /result does not overwrite the summary", async () => {
    const n = await enable()
    const d = await run("dispatch", n)
    const sessionId = d.job.sessionId as string
    await result(d.job.id, d.gen, n.credential, "other", {
      completion: { by: "session", summary: "Shipped." },
    })
    // The runner's late batch drain: a result event after the session ended.
    await withPrivilegedDb(owner.orgId, "test:late-result", (tx) =>
      appendServerEvents(tx, owner.orgId, sessionId, [
        { at: new Date().toISOString(), type: "result", payload: { text: "late text" } },
      ]),
    )
    expect(await sessionOf(d.job.id)).toEqual({ status: "done", result_summary: "Shipped." })
  })

  it("S3: a routine run's posted answer still ends done", async () => {
    const n = await enable()
    const [routine] = await sql<{ id: string }[]>`INSERT INTO kernel.routines
      (org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone,
       prompt, scopes, created_by_actor_type)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${`r-${crypto.randomUUID()}`}, 'd',
              'recurring', '0 9 * * *', 'UTC', 'p', '{}', 'user') RETURNING id`
    const r = await run("routine", n, routine.id)
    const res = await result(r.job.id, r.gen, n.credential, "Here is the digest.")
    expect(res.status).toBe(201)
    expect((await sessionOf(r.job.id)).status).toBe("done")
  })

  /**
   * A routine run on a node, dispatched as the worker does: a dedicated output
   * thread, a `dispatched` run row the job settles, and the conversation the
   * routine was created from as its report thread.
   */
  async function reportingRoutineRun(n: { nodeId: string; credential: string }) {
    await sql`UPDATE kernel.threads SET type = 'routine' WHERE id = ${threadId}`
    const reportThreadId = await minimal.thread(owner.orgId, owner.userId)
    const name = `nr-${crypto.randomUUID().slice(0, 8)}`
    const [routine] = await sql<{ id: string }[]>`INSERT INTO kernel.routines
      (org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone,
       prompt, scopes, created_by_actor_type, output_thread_id, report_thread_id, runs_on)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${name}, 'd',
              'recurring', '0 9 * * *', 'UTC', 'p', '{}', 'user', ${threadId},
              ${reportThreadId}, 'node') RETURNING id`
    const [runRow] = await sql<{ id: string }[]>`INSERT INTO kernel.routine_runs
      (org_id, routine_id, status) VALUES (${owner.orgId}, ${routine.id}, 'dispatched')
      RETURNING id`
    const job = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId,
      source: "routine",
      sourceRef: runRow.id,
      routineId: routine.id,
      prompt: "p",
      sourceRequiredScopes: [],
      targetNodeId: n.nodeId,
      session: { source: "routine", configKind: "owner", model: "default", level: "strict" },
    })
    const claimed = await call(`/api/nodes/jobs/${job.id}/claim`, "POST", {}, n.credential)
    expect(claimed.status).toBe(200)
    const gen = (await json(claimed)).data.leaseGeneration as number
    return { job, gen, routineId: routine.id, name, reportThreadId, runId: runRow.id }
  }

  async function reportsIn(thread: string) {
    return sql<Array<{ content: string; metadata: Record<string, any> }>>`
      SELECT content, metadata FROM kernel.messages
       WHERE thread_id = ${thread} AND author_agent_id = ${agentId} AND author_type = 'agent'`
  }

  it("a node-run routine reports its final message to the conversation it was set up in", async () => {
    const n = await enable()
    const r = await reportingRoutineRun(n)
    const res = await result(r.job.id, r.gen, n.credential, "Your one-minute message: hello.")
    expect(res.status).toBe(201)
    const reports = await reportsIn(r.reportThreadId)
    expect(reports.map((m) => m.content)).toEqual(["Your one-minute message: hello."])
    expect(reports[0].metadata.agentAuthorLabel).toBe(`Routine ${r.name}`)
    expect(reports[0].metadata.routineReport).toEqual({
      routineId: r.routineId,
      routineName: r.name,
      outputThreadId: threadId,
      ownerUserId: owner.userId,
    })
    const [run] = await sql<{ status: string }[]>`
      SELECT status FROM kernel.routine_runs WHERE id = ${r.runId}`
    expect(run.status).toBe("succeeded")
    // A re-sent result is a replay: the report is not posted twice.
    const again = await result(r.job.id, r.gen, n.credential, "Your one-minute message: hello.")
    expect(again.status).toBe(200)
    expect(await reportsIn(r.reportThreadId)).toHaveLength(1)
  })

  it("a node-run routine that wrote no text reports nothing", async () => {
    const n = await enable()
    const r = await reportingRoutineRun(n)
    const res = await result(r.job.id, r.gen, n.credential, "")
    expect(res.status).toBe(201)
    expect(await reportsIn(r.reportThreadId)).toHaveLength(0)
  })

  it("S4: a token_limit result without completion ends needs_you reason token_limit", async () => {
    const n = await enable()
    const d = await run("dispatch", n)
    const res = await result(d.job.id, d.gen, n.credential, "Halfway there.", {
      endedBy: "token_limit",
    })
    expect(res.status).toBe(201)
    expect((await sessionOf(d.job.id)).status).toBe("needs_you")
    expect(await lastStatus(d.job.id)).toEqual({ status: "needs_you", reason: "token_limit" })
  })

  it("S4: a token_limit result with completion by session ends done", async () => {
    const n = await enable()
    const d = await run("dispatch", n)
    const res = await result(d.job.id, d.gen, n.credential, "Finished.", {
      endedBy: "token_limit",
      completion: { by: "session", summary: "Finished before the limit." },
    })
    expect(res.status).toBe(201)
    expect(await sessionOf(d.job.id)).toEqual({
      status: "done",
      result_summary: "Finished before the limit.",
    })
  })

  it("S10: a result whose text is 'All done!' and no completion ends needs_you", async () => {
    const n = await enable()
    const d = await run("dispatch", n)
    const res = await result(d.job.id, d.gen, n.credential, "All done!")
    expect(res.status).toBe(201)
    expect((await sessionOf(d.job.id)).status).toBe("needs_you")
  })

  it("GET /jobs/:id answers the owner and 404s another user", async () => {
    const n = await enable()
    const d = await run("dispatch", n)
    const mine = await call(`/api/nodes/jobs/${d.job.id}`, "GET")
    expect(mine.status).toBe(200)
    expect((await json(mine)).data).toMatchObject({
      id: d.job.id,
      agentId,
      agentName: "Fixer",
      source: "dispatch",
      status: "running",
    })
    expect(
      (await call(`/api/nodes/jobs/${d.job.id}`, "GET", undefined, undefined, other)).status,
    ).toBe(404)
    expect((await call(`/api/nodes/jobs/${crypto.randomUUID()}`, "GET")).status).toBe(404)
  })
})
