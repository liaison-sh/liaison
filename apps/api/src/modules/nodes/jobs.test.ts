// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4 N-S T2 (S20, S23, A18-A20, A23, A26, A27, F7): node jobs.
//
// Create (source scope refusal, routine coalescing, backlog), offer (live
// enabled nodes only, never a backlog job), claim (node credential + owner,
// one winner, one running job per node, routine pre-checks and agent access
// re-run, profile returned: level and Liaison tools, S20), heartbeat and result fencing by lease
// generation, result idempotent per (job, generation) and tagged with the job
// taint union the source scopes, lease expiry (requeue before start,
// interrupted + owner notification after), /fail, backlog listing, re-run and
// discard, profile CRUD.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { mcpTurnTaintKey } from "~/modules/mcp/connection-service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { onNodeConnectionHello } from "./hooks"
import { createNodeJob, NodeJobRefusedError, sweepNodeLeases } from "./jobs"

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

const offers = (ws: FakeWs) =>
  ws.frames.filter((f) => f.type === "node_job_offer").map((f) => f.jobId as string)

describe("node jobs (P4 T2)", () => {
  let owner: minimal.Session
  let other: minimal.Session
  let manager: WebSocketManager
  let previous: WebSocketManager | null
  let agentId: string
  let threadId: string
  const sockets: FakeWs[] = []

  const call = (
    path: string,
    method: string,
    session: minimal.Session,
    body?: unknown,
    nodeCredential?: string,
  ) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${session.bearer}`,
        ...(nodeCredential
          ? { "X-Node-Credential": nodeCredential, "X-Liaison-Node-Protocol": "2" }
          : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const data = async (res: Response) => ((await res.json()) as { data: any }).data

  async function enable(session: minimal.Session) {
    const deviceId = `d.${crypto.randomUUID()}`
    const res = await call("/api/nodes", "POST", session, { deviceId, name: "Mac" })
    expect(res.status).toBe(201)
    const d = await data(res)
    return { nodeId: d.node.id as string, credential: d.credential as string, deviceId }
  }

  async function connect(session: minimal.Session, node: { deviceId: string; credential: string }) {
    const ws = fakeWs()
    sockets.push(ws)
    manager.addConnection(session.userId, ws, ["*"], session.orgId)
    const entry = await manager.registerNotifyClient(ws, "desktop_app", Date.now(), {
      deviceId: node.deviceId,
    })
    await onNodeConnectionHello({
      orgId: session.orgId,
      userId: session.userId,
      deviceId: node.deviceId,
      connId: entry!.connId,
      nodeCredential: node.credential,
      bindConnection: (nodeId) => manager.markNodeConnection(ws, nodeId),
    })
    return ws
  }

  function newJob(over: Partial<Parameters<typeof createNodeJob>[0]> = {}) {
    return createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId,
      source: "chat",
      prompt: "Summarise the open bugs",
      sourceRequiredScopes: [],
      ...over,
    })
  }

  const claim = (jobId: string, cred: string, session = owner, body: unknown = {}) =>
    call(`/api/nodes/jobs/${jobId}/claim`, "POST", session, body, cred)

  async function jobRow(id: string) {
    const [row] = await sql<
      Array<{
        status: string
        lease_generation: number
        started_at: Date | null
        node_id: string | null
        skipped_count: number
        backlog: boolean
        error: string | null
        error_code: string | null
        result_message_id: string | null
      }>
    >`SELECT status, lease_generation, started_at, node_id, skipped_count, backlog, error,
             error_code, result_message_id
        FROM kernel.node_jobs WHERE id = ${id}`
    return row
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
      VALUES (${owner.orgId}, 'personal', ${`@node-${crypto.randomUUID().slice(0, 8)}`}, 'Fixer',
              '["kernel:threads:read","kernel:threads:write"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
  })

  beforeEach(async () => {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    await Bun.sleep(20)
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${owner.orgId}`
    await sql`UPDATE kernel.agents SET archived_at = NULL WHERE id = ${agentId}`
    threadId = await minimal.thread(owner.orgId, owner.userId)
  })

  afterAll(async () => {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    if (owner) {
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_profiles WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.routines WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
    if (previous) setWsManager(previous)
    await releaseTestLock()
  })

  // ── create ───────────────────────────────────────────────────────────────

  it("refuses a job whose source scopes the node owner lacks (A18): no row", async () => {
    await expect(newJob({ sourceRequiredScopes: ["nodetest:secret:read"] })).rejects.toBeInstanceOf(
      NodeJobRefusedError,
    )
    const rows = await sql`SELECT id FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    expect(rows).toHaveLength(0)
    // A scope the owner holds is fine.
    const ok = await newJob({ sourceRequiredScopes: ["kernel:contacts:read"] })
    expect(ok.status).toBe("queued")
  })

  it("coalesces queued jobs of the same routine: newest kept, skipped count recorded (A23)", async () => {
    const [routine] = await sql<{ id: string }[]>`INSERT INTO kernel.routines
      (org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone,
       prompt, scopes, created_by_actor_type)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${`r-${crypto.randomUUID()}`}, 'd',
              'recurring', '0 9 * * *', 'UTC', 'p', '{}', 'user') RETURNING id`
    const a = await newJob({ source: "routine", routineId: routine.id, prompt: "tick 1" })
    const b = await newJob({ source: "routine", routineId: routine.id, prompt: "tick 2" })
    const c = await newJob({ source: "routine", routineId: routine.id, prompt: "tick 3" })
    expect((await jobRow(a.id)).status).toBe("cancelled")
    expect((await jobRow(b.id)).status).toBe("cancelled")
    const kept = await jobRow(c.id)
    expect(kept.status).toBe("queued")
    expect(kept.skipped_count).toBe(2)
    // A different routine, or a chat job, is never folded in.
    const chat = await newJob()
    expect((await jobRow(chat.id)).status).toBe("queued")
  })

  it("a job created while no node is connected is backlog and is never offered (A23)", async () => {
    const n = await enable(owner)
    const job = await newJob()
    expect((await jobRow(job.id)).backlog).toBe(true)
    // The node connects afterwards: the backlog job is not offered on reconnect.
    const ws = await connect(owner, n)
    expect(offers(ws)).not.toContain(job.id)
    // It is listed by the backlog endpoint instead.
    const listed = await data(
      await call("/api/nodes/me/jobs?status=queued&backlog=1", "GET", owner),
    )
    expect(listed.map((j: { id: string }) => j.id)).toEqual([job.id])
  })

  it("offers a job created while a node is live to every live enabled node, and only those (A26)", async () => {
    const n1 = await enable(owner)
    const n2 = await enable(owner)
    const n3 = await enable(owner)
    await call(`/api/nodes/${n3.nodeId}`, "PATCH", owner, { enabled: false })
    const ws1 = await connect(owner, n1)
    const ws2 = await connect(owner, n2)
    const ws3 = await connect(owner, n3)
    const theirs = await enable(other)
    const wsOther = await connect(other, theirs)
    const job = await newJob()
    const row = await jobRow(job.id)
    expect(row.backlog).toBe(false)
    expect(row.status).toBe("offered")
    expect(offers(ws1)).toEqual([job.id])
    expect(offers(ws2)).toEqual([job.id])
    expect(offers(ws3)).toEqual([])
    expect(offers(wsOther)).toEqual([])
    // Not in the backlog list.
    const listed = await data(
      await call("/api/nodes/me/jobs?status=queued&backlog=1", "GET", owner),
    )
    expect(listed).toHaveLength(0)
  })

  it("re-offers a non-backlog queued job when a node reconnects", async () => {
    const n = await enable(owner)
    const first = await connect(owner, n)
    const job = await newJob()
    expect(offers(first)).toEqual([job.id])
    manager.removeConnection(first)
    const again = await connect(owner, n)
    expect(offers(again)).toEqual([job.id])
  })

  // ── claim ────────────────────────────────────────────────────────────────

  it("a lease race between claims has exactly one winner", async () => {
    const racers = await Promise.all([1, 2, 3, 4, 5, 6].map(() => enable(owner)))
    const job = await newJob()
    const results = await Promise.all(racers.map((n) => claim(job.id, n.credential)))
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409])
    const winner = racers[results.findIndex((r) => r.status === 200)]
    const row = await jobRow(job.id)
    expect(row.status).toBe("running")
    expect(row.node_id).toBe(winner.nodeId)
    expect(row.lease_generation).toBe(1)
  })

  it("claim returns the job, the lease generation, a 120 s lease and the profile (level, Liaison tools)", async () => {
    const n = await enable(owner)
    const job = await newJob({ tokenBudget: 50_000, hardTokenLimit: 200_000 })
    const res = await claim(job.id, n.credential)
    expect(res.status).toBe(200)
    const d = await data(res)
    expect(d.job).toMatchObject({
      id: job.id,
      agentId,
      threadId,
      // The node's confirmation dialog names the agent (walk N2: it said "This agent").
      agentName: "Fixer",
      prompt: "Summarise the open bugs",
      source: "chat",
      tokenBudget: 50_000,
      hardTokenLimit: 200_000,
    })
    expect(d.leaseGeneration).toBe(1)
    expect(d.leaseSeconds).toBe(120)
    const ms = new Date(d.leaseExpiresAt).getTime() - Date.now()
    expect(ms).toBeGreaterThan(110_000)
    expect(ms).toBeLessThanOrEqual(121_000)
    // S20: no stored profile reads as Strict with Liaison tools; no template, no hash.
    expect(d.profile).toEqual({ level: "strict", liaisonTools: true })
    expect(d.profileHash).toBeUndefined()
  })

  it("claim and start open the agent's taint set, so a set missing at the result is a lost one (fix8 M2)", async () => {
    const key = mcpTurnTaintKey(owner.orgId, agentId)
    const n = await enable(owner)
    const job = await newJob()
    await redis.del(key)
    const d = await data(await claim(job.id, n.credential))
    expect(await redis.get(key)).toBe("[]")
    await redis.del(key)
    const started = await call(
      `/api/nodes/jobs/${job.id}/started`,
      "POST",
      owner,
      { leaseGeneration: d.leaseGeneration },
      n.credential,
    )
    expect(started.status).toBe(200)
    expect(await redis.get(key)).toBe("[]")
    await redis.del(key)
  })

  it("refuses a claim by another user's credential, and of another owner's job", async () => {
    const mine = await enable(owner)
    const theirs = await enable(other)
    const job = await newJob()
    // Their session presenting my credential.
    expect((await claim(job.id, mine.credential, other)).status).toBe(403)
    // Their own node claiming my job.
    expect((await claim(job.id, theirs.credential, other)).status).toBe(404)
    expect((await jobRow(job.id)).status).toBe("queued")
  })

  // A25's one running job per node became the node's live cap (P3, L2, D35):
  // still enforced server side, here at a cap of one.
  it("enforces the node's live cap server side (A25, D35)", async () => {
    const n = await enable(owner)
    await sql`UPDATE kernel.nodes SET max_live_sessions = 1, max_live_background = 1
               WHERE id = ${n.nodeId}`
    const a = await newJob()
    const b = await newJob()
    expect((await claim(a.id, n.credential)).status).toBe(200)
    const second = await claim(b.id, n.credential)
    expect(second.status).toBe(409)
    expect((await jobRow(b.id)).status).toBe("queued")
  })

  it("re-checks the owner's access to the agent at claim (A27): an archived agent is refused", async () => {
    const n = await enable(owner)
    const job = await newJob()
    await sql`UPDATE kernel.agents SET archived_at = now() WHERE id = ${agentId}`
    const res = await claim(job.id, n.credential)
    expect(res.status).toBe(403)
    const row = await jobRow(job.id)
    expect(row.status).toBe("refused")
    expect(row.error_code).toBe("access")
  })

  it("re-runs the routine pre-checks at claim (A23): scope drift refuses the job", async () => {
    const n = await enable(owner)
    const [routine] = await sql<{ id: string }[]>`INSERT INTO kernel.routines
      (org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone,
       prompt, scopes, created_by_actor_type)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${`r-${crypto.randomUUID()}`}, 'd',
              'recurring', '0 9 * * *', 'UTC', 'p', '{kernel:threads:read}', 'user') RETURNING id`
    const job = await newJob({ source: "routine", routineId: routine.id })
    // The routine now needs a scope its owner does not hold.
    await sql`UPDATE kernel.routines SET scopes = '{nodetest:secret:write}' WHERE id = ${routine.id}`
    const res = await claim(job.id, n.credential)
    expect(res.status).toBe(403)
    const row = await jobRow(job.id)
    expect(row.status).toBe("refused")
    expect(row.error_code).toBe("scope_mismatch")
    // A51: no credit pre-check at claim (claim-precheck.test.ts).
  })

  it("claim binds the job's MCP connection only when it is the owner's, for the job's agent (T2b)", async () => {
    const n = await enable(owner)
    const { createMcpConnection } = await import("~/modules/mcp/connection-service")
    const mine = await createMcpConnection({
      orgId: owner.orgId,
      userId: owner.userId,
      clientId: "liaison-node",
      label: "node",
      agentId,
    })
    const unbound = await createMcpConnection({
      orgId: owner.orgId,
      userId: owner.userId,
      clientId: "liaison-node",
      label: "legacy",
    })
    const job = await newJob()
    const bad = await claim(job.id, n.credential, owner, { mcpConnectionId: unbound.connection.id })
    expect(bad.status).toBe(422)
    expect((await jobRow(job.id)).status).toBe("queued")
    const ok = await claim(job.id, n.credential, owner, { mcpConnectionId: mine.connection.id })
    expect(ok.status).toBe(200)
    const [row] = await sql<{ mcp_connection_id: string }[]>`
      SELECT mcp_connection_id FROM kernel.node_jobs WHERE id = ${job.id}`
    expect(row.mcp_connection_id).toBe(mine.connection.id)
    await sql`DELETE FROM kernel.mcp_connections WHERE id IN (${mine.connection.id}, ${unbound.connection.id})`
  })

  // ── heartbeat, fencing, result ───────────────────────────────────────────

  it("heartbeat extends the lease; a stale generation gets 409", async () => {
    const n = await enable(owner)
    const job = await newJob()
    const d = await data(await claim(job.id, n.credential))
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() + interval '5 seconds' WHERE id = ${job.id}`
    const hb = await call(
      `/api/nodes/jobs/${job.id}/heartbeat`,
      "POST",
      owner,
      { leaseGeneration: d.leaseGeneration },
      n.credential,
    )
    expect(hb.status).toBe(200)
    const [row] = await sql<Array<{ lease_expires_at: Date }>>`
      SELECT lease_expires_at FROM kernel.node_jobs WHERE id = ${job.id}`
    expect(new Date(row.lease_expires_at).getTime() - Date.now()).toBeGreaterThan(100_000)
    // The lease lapses before start and another claim takes generation 2: the
    // node still holding generation 1 is told to stop.
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${job.id}`
    const again = await data(await claim(job.id, n.credential))
    expect(again.leaseGeneration).toBe(d.leaseGeneration + 1)
    const stale = await call(
      `/api/nodes/jobs/${job.id}/heartbeat`,
      "POST",
      owner,
      { leaseGeneration: d.leaseGeneration },
      n.credential,
    )
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("stale_lease")
  })

  it("a stale generation result is rejected; the current one lands, idempotently", async () => {
    const n = await enable(owner)
    const job = await newJob()
    const first = await data(await claim(job.id, n.credential))
    // The lease expires before the run started: back to queued, claimed again.
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${job.id}`
    await sweepNodeLeases()
    expect((await jobRow(job.id)).status).toBe("queued")
    const second = await data(await claim(job.id, n.credential))
    expect(second.leaseGeneration).toBe(first.leaseGeneration + 1)
    const result = (gen: number) =>
      call(
        `/api/nodes/jobs/${job.id}/result`,
        "POST",
        owner,
        { leaseGeneration: gen, text: "3 open bugs, 1 regression." },
        n.credential,
      )
    expect((await result(first.leaseGeneration)).status).toBe(409)
    const ok = await result(second.leaseGeneration)
    expect(ok.status).toBe(201)
    const okData = await data(ok)
    // Replayed (a retry after a lost response): same message, no second row.
    const again = await result(second.leaseGeneration)
    expect(again.status).toBe(200)
    expect((await data(again)).messageId).toBe(okData.messageId)
    const rows =
      await sql`SELECT id FROM kernel.messages WHERE thread_id = ${threadId} AND author_type = 'agent'`
    expect(rows).toHaveLength(1)
    const row = await jobRow(job.id)
    expect(row.status).toBe("done")
    expect(row.result_message_id).toBe(okData.messageId)
  })

  it("the result lands through persistAgentTurn with runLocation node, refusals and usage", async () => {
    const n = await enable(owner)
    const job = await newJob({ sourceRequiredScopes: ["kernel:contacts:read"] })
    const d = await data(await claim(job.id, n.credential))
    const res = await call(
      `/api/nodes/jobs/${job.id}/result`,
      "POST",
      owner,
      {
        leaseGeneration: d.leaseGeneration,
        text: "Done.",
        refusals: [{ tool: "Bash", reason: "outside the profile", detail: "git push origin main" }],
        usage: { inputTokens: 1200, outputTokens: 300 },
      },
      n.credential,
    )
    expect(res.status).toBe(201)
    const { messageId } = await data(res)
    const [msg] = await sql<
      Array<{
        metadata: Record<string, unknown>
        required_scopes: string[]
        author_agent_id: string
      }>
    >`SELECT metadata, required_scopes, author_agent_id FROM kernel.messages WHERE id = ${messageId}`
    expect(msg.author_agent_id).toBe(agentId)
    expect(msg.metadata).toMatchObject({
      runLocation: "node",
      nodeJobId: job.id,
      nodeId: n.nodeId,
      usage: { inputTokens: 1200, outputTokens: 300 },
    })
    // A18: what the job could read (its taint, its definition and conversation)
    // UNION the source scopes; never the owner's whole effective scope.
    expect(msg.required_scopes).toContain("kernel:contacts:read")
    expect(msg.required_scopes).not.toContain("*")
    const [stored] = await sql<Array<{ refusals: unknown[] }>>`
      SELECT refusals FROM kernel.node_jobs WHERE id = ${job.id}`
    expect(stored.refusals).toEqual([
      { tool: "Bash", reason: "outside the profile", detail: "git push origin main" },
    ])
  })

  it("an agent_tag result posts the answer itself back to the asking thread (D22)", async () => {
    const n = await enable(owner)
    const askingThread = await minimal.thread(owner.orgId, other.userId)
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${askingThread}, ${owner.userId}, ${owner.orgId}, 'member')`
    const job = await newJob({
      source: "agent_tag",
      requesterUserId: other.userId,
      replyThreadId: askingThread,
    })
    const d = await data(await claim(job.id, n.credential))
    const res = await call(
      `/api/nodes/jobs/${job.id}/result`,
      "POST",
      owner,
      { leaseGeneration: d.leaseGeneration, text: "PR https://example.test/pr/1 for bug 42" },
      n.credential,
    )
    expect(res.status).toBe(201)
    const { messageId } = await data(res)
    const links = await sql<Array<{ content: string; metadata: Record<string, unknown> }>>`
      SELECT content, metadata FROM kernel.messages WHERE thread_id = ${askingThread}`
    expect(links).toHaveLength(1)
    // D22 (walk 2026-10-12, N8): the asker is not the node owner and cannot
    // open the owner's thread with the agent, so a link alone never reached
    // them. The answer itself lands here; the job thread is named only in the
    // metadata, which the web turns into a link for the owner alone.
    expect(links[0].content).toBe("PR https://example.test/pr/1 for bug 42")
    expect(links[0].content).not.toContain(threadId)
    expect(links[0].metadata).toMatchObject({
      nodeJobId: job.id,
      nodeResultMessageId: messageId,
      nodeResultThreadId: threadId,
      nodeOwnerUserId: owner.userId,
    })
  })

  it("the answer back is top level, never folded under the agents' exchange", async () => {
    // Walk 2026-10-12 (N8): the link was written as `thread/<id>?message=...`,
    // an href the web sanitizer drops (a dead "open the result"), and it was
    // parented to the asking agent's question, so the web folded it inside
    // "N messages between agents" where the person who asked never saw it.
    const n = await enable(owner)
    const askingThread = await minimal.thread(owner.orgId, other.userId)
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${askingThread}, ${owner.userId}, ${owner.orgId}, 'member')`
    const [question] = await sql<Array<{ id: string }>>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${askingThread}, ${owner.orgId}, ${other.userId}, 'user', 'look up Quorrel', '{}')
      RETURNING id`
    const job = await newJob({
      source: "agent_tag",
      requesterUserId: other.userId,
      replyThreadId: askingThread,
      replyMessageId: question.id,
    })
    const d = await data(await claim(job.id, n.credential))
    const res = await call(
      `/api/nodes/jobs/${job.id}/result`,
      "POST",
      owner,
      { leaseGeneration: d.leaseGeneration, text: "Quorrel makes audio interfaces." },
      n.credential,
    )
    expect(res.status).toBe(201)
    const links = await sql<Array<{ content: string; parent_message_id: string | null }>>`
      SELECT content, parent_message_id FROM kernel.messages
      WHERE thread_id = ${askingThread} AND id <> ${question.id}`
    expect(links).toHaveLength(1)
    expect(links[0].content).toBe("Quorrel makes audio interfaces.")
    expect(links[0].content).not.toContain("](thread/")
    expect(links[0].parent_message_id).toBeNull()
  })

  it("asked in the job thread itself, the answer is posted once, not again as an answer back (D22)", async () => {
    const n = await enable(owner)
    const job = await newJob({
      source: "agent_tag",
      requesterUserId: owner.userId,
      replyThreadId: threadId,
    })
    const d = await data(await claim(job.id, n.credential))
    const res = await call(
      `/api/nodes/jobs/${job.id}/result`,
      "POST",
      owner,
      { leaseGeneration: d.leaseGeneration, text: "Solid State Logic makes mixing consoles." },
      n.credential,
    )
    expect(res.status).toBe(201)
    const rows = await sql<Array<{ content: string }>>`
      SELECT content FROM kernel.messages WHERE thread_id = ${threadId}`
    expect(rows.map((r) => r.content)).toEqual(["Solid State Logic makes mixing consoles."])
  })

  it("posts a plain notice, never the answer nor a dead link, when a reader of the asking thread may not see it (D22)", async () => {
    // The answer is tainted with a read scope the owner holds and the asker
    // lacks: the asking thread gets a notice naming why and who can share it.
    const asker = await minimal.session(owner.orgId)
    await minimal.revokeRole(asker.userId, "member")
    const n = await enable(owner)
    const askingThread = await minimal.thread(owner.orgId, asker.userId)
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${askingThread}, ${owner.userId}, ${owner.orgId}, 'member')`
    const job = await newJob({
      source: "agent_tag",
      requesterUserId: asker.userId,
      replyThreadId: askingThread,
      sourceRequiredScopes: ["kernel:contacts:read"],
    })
    const d = await data(await claim(job.id, n.credential))
    const res = await call(
      `/api/nodes/jobs/${job.id}/result`,
      "POST",
      owner,
      { leaseGeneration: d.leaseGeneration, text: "The audit log shows 3 secret things." },
      n.credential,
    )
    expect(res.status).toBe(201)
    const { messageId } = await data(res)
    const [result] = await sql<Array<{ required_scopes: string[] }>>`
      SELECT required_scopes FROM kernel.messages WHERE id = ${messageId}`
    expect(result.required_scopes).toContain("kernel:contacts:read")
    const [ownerRow] = await sql<Array<{ name: string }>>`
      SELECT name FROM kernel.users WHERE id = ${owner.userId}`
    const rows = await sql<
      Array<{ content: string; required_scopes: string[]; metadata: Record<string, unknown> }>
    >`SELECT content, required_scopes, metadata FROM kernel.messages WHERE thread_id = ${askingThread}`
    expect(rows).toHaveLength(1)
    const notice = rows[0]
    expect(notice.content).not.toContain("secret things")
    expect(notice.content).not.toContain("thread:")
    expect(notice.content).toContain(`Answered on ${ownerRow.name}'s computer.`)
    expect(notice.content).toContain("can't be shown in this conversation because")
    expect(notice.content).toContain("kernel:contacts:read")
    expect(notice.content).toContain(`ask ${ownerRow.name} to share it`)
    // Readable by everyone in the conversation: it quotes nothing of the answer.
    expect(notice.required_scopes).toEqual([])
    expect(notice.metadata).toMatchObject({
      nodeJobId: job.id,
      nodeAnswerWithheld: true,
      nodeResultThreadId: threadId,
      nodeOwnerUserId: owner.userId,
    })
  })

  // ── lease expiry ─────────────────────────────────────────────────────────

  it("expiry before start requeues; expiry after start interrupts and notifies the owner (A20)", async () => {
    const n = await enable(owner)
    const early = await newJob()
    await claim(early.id, n.credential)
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${early.id}`
    const first = await sweepNodeLeases()
    expect(first.requeued).toBe(1)
    const e = await jobRow(early.id)
    expect(e.status).toBe("queued")
    expect(e.node_id).toBeNull()

    const late = await newJob()
    const d = await data(await claim(late.id, n.credential))
    const started = await call(
      `/api/nodes/jobs/${late.id}/started`,
      "POST",
      owner,
      { leaseGeneration: d.leaseGeneration },
      n.credential,
    )
    expect(started.status).toBe(200)
    await sql`UPDATE kernel.node_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${late.id}`
    const second = await sweepNodeLeases()
    expect(second.interrupted).toBe(1)
    expect((await jobRow(late.id)).status).toBe("interrupted")
    const events = await sql<Array<{ payload: Record<string, any> }>>`
      SELECT payload FROM kernel.pending_events
       WHERE org_id = ${owner.orgId} AND payload->>'entity' = 'agent_notification'`
    const mine = events.filter((e) => e.payload.data?.nodeJobId === late.id)
    expect(mine).toHaveLength(1)
    expect(mine[0].payload.data.targetUserIds).toEqual([owner.userId])
    expect(mine[0].payload.data.actions).toEqual(["rerun", "discard"])
    // A late result for the interrupted run is refused: side effects are never
    // silently repeated or silently accepted.
    const lateResult = await call(
      `/api/nodes/jobs/${late.id}/result`,
      "POST",
      owner,
      { leaseGeneration: d.leaseGeneration, text: "late" },
      n.credential,
    )
    expect(lateResult.status).toBe(409)
  })

  it("re-run puts an interrupted job back in the queue; discard cancels it", async () => {
    const n = await enable(owner)
    const a = await newJob()
    const b = await newJob()
    for (const j of [a, b]) {
      await sql`UPDATE kernel.node_jobs SET status = 'interrupted', node_id = ${n.nodeId},
        started_at = now(), lease_generation = 1 WHERE id = ${j.id}`
    }
    expect((await call(`/api/nodes/jobs/${a.id}/rerun`, "POST", owner)).status).toBe(200)
    expect((await jobRow(a.id)).status).toBe("queued")
    expect((await call(`/api/nodes/jobs/${b.id}/discard`, "POST", owner)).status).toBe(200)
    expect((await jobRow(b.id)).status).toBe("cancelled")
    // Not someone else's to decide.
    expect((await call(`/api/nodes/jobs/${a.id}/discard`, "POST", other)).status).toBe(404)
    // A job the node refused because its level was not confirmed there yet
    // is re-run once the owner confirms it (walk N12, D24).
    const c = await newJob()
    await sql`UPDATE kernel.node_jobs SET status = 'refused', error_code = 'level_unconfirmed',
      node_id = ${n.nodeId} WHERE id = ${c.id}`
    expect((await call(`/api/nodes/jobs/${c.id}/rerun`, "POST", owner)).status).toBe(200)
    expect((await jobRow(c.id)).status).toBe("queued")
  })

  it("/fail with repo_settings_unsafe is a refusal under that code (walk N15)", async () => {
    const n = await enable(owner)
    const a = await newJob()
    const da = await data(await claim(a.id, n.credential))
    const res = await call(
      `/api/nodes/jobs/${a.id}/fail`,
      "POST",
      owner,
      {
        leaseGeneration: da.leaseGeneration,
        error: "The job was not started: repo_settings_unsafe: .claude/settings.json:env.",
        code: "repo_settings_unsafe",
      },
      n.credential,
    )
    expect(res.status).toBe(200)
    expect(await jobRow(a.id)).toMatchObject({
      status: "refused",
      error_code: "repo_settings_unsafe",
    })
  })

  it("/fail records the error; level_unconfirmed is a refusal; profile_unconfirmed is gone (D24)", async () => {
    const n = await enable(owner)
    const a = await newJob()
    const da = await data(await claim(a.id, n.credential))
    const fa = await call(
      `/api/nodes/jobs/${a.id}/fail`,
      "POST",
      owner,
      {
        leaseGeneration: da.leaseGeneration,
        error: "Claude sign-in expired",
        code: "auth_expired",
      },
      n.credential,
    )
    expect(fa.status).toBe(200)
    expect(await jobRow(a.id)).toMatchObject({ status: "failed", error_code: "auth_expired" })
    const b = await newJob()
    const db = await data(await claim(b.id, n.credential))
    await call(
      `/api/nodes/jobs/${b.id}/fail`,
      "POST",
      owner,
      {
        leaseGeneration: db.leaseGeneration,
        error: "the level is above this computer's pin",
        code: "level_unconfirmed",
      },
      n.credential,
    )
    expect(await jobRow(b.id)).toMatchObject({
      status: "refused",
      error_code: "level_unconfirmed",
    })
    // The hash-pin refusal left with the hash pin: a node may not send it.
    const c = await newJob()
    const dc = await data(await claim(c.id, n.credential))
    const old = await call(
      `/api/nodes/jobs/${c.id}/fail`,
      "POST",
      owner,
      {
        leaseGeneration: dc.leaseGeneration,
        error: "profile changed",
        code: "profile_unconfirmed",
      },
      n.credential,
    )
    expect(old.status).toBe(400)
  })

  // ── profiles ─────────────────────────────────────────────────────────────

  it("profile CRUD: the claim carries the stored profile and follows its changes", async () => {
    // Saved before any node is enabled: no node asks for a confirmation (D42).
    const put = await call(`/api/nodes/me/profiles/${agentId}`, "PUT", owner, {
      level: "standard",
      liaisonTools: false,
    })
    expect(put.status).toBe(200)
    const n = await enable(owner)
    const listed = await data(await call("/api/nodes/me/profiles", "GET", owner))
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      agentId,
      agentName: "Fixer",
      level: "standard",
      liaisonTools: false,
    })
    expect(listed[0].template).toBeUndefined()
    expect(listed[0].hash).toBeUndefined()
    const job = await newJob()
    const d = await data(await claim(job.id, n.credential))
    expect(d.profile).toEqual({ level: "standard", liaisonTools: false })
    await call(`/api/nodes/me/profiles/${agentId}`, "PUT", owner, {
      level: "strict",
      liaisonTools: true,
    })
    const after = await data(await call("/api/nodes/me/profiles", "GET", owner))
    expect(after[0]).toMatchObject({ level: "strict", liaisonTools: true })
    const n2 = await enable(owner)
    const next = await newJob()
    expect((await data(await claim(next.id, n2.credential))).profile).toEqual({
      level: "strict",
      liaisonTools: true,
    })
    // Another user cannot read or write it.
    const theirs = await data(await call("/api/nodes/me/profiles", "GET", other))
    expect(theirs).toHaveLength(0)
    expect((await call(`/api/nodes/me/profiles/${agentId}`, "DELETE", owner)).status).toBe(200)
    expect(await data(await call("/api/nodes/me/profiles", "GET", owner))).toHaveLength(0)
  })

  it("claim names the agent's model, so the node can run the job on it (walk: Haiku)", async () => {
    const n = await enable(owner)
    await sql`UPDATE kernel.agents SET model_preference = 'claude-haiku-4-5' WHERE id = ${agentId}`
    try {
      const job = await newJob()
      const d = await data(await claim(job.id, n.credential))
      expect(d.job.agentModel).toBe("claude-haiku-4-5")
    } finally {
      await sql`UPDATE kernel.agents SET model_preference = NULL WHERE id = ${agentId}`
    }
    const auto = await newJob()
    const n2 = await enable(owner)
    expect((await data(await claim(auto.id, n2.credential))).job.agentModel).toBeNull()
    // A routine's own model wins over its agent's.
    const [routine] = await sql<{ id: string }[]>`INSERT INTO kernel.routines
      (org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone,
       prompt, scopes, created_by_actor_type, agent_model_id)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${`r-${crypto.randomUUID()}`}, 'd',
              'recurring', '0 9 * * *', 'UTC', 'p', '{}', 'user', 'claude-haiku-4-5') RETURNING id`
    const tick = await newJob({ source: "routine", routineId: routine.id, prompt: "tick" })
    const n3 = await enable(owner)
    expect((await data(await claim(tick.id, n3.credential))).job.agentModel).toBe(
      "claude-haiku-4-5",
    )
  })

  it("the result records the model the node ran the job on", async () => {
    const n = await enable(owner)
    const job = await newJob()
    const d = await data(await claim(job.id, n.credential))
    const res = await call(
      `/api/nodes/jobs/${job.id}/result`,
      "POST",
      owner,
      { leaseGeneration: d.leaseGeneration, text: "Done.", modelId: "claude-haiku-4-5-20251001" },
      n.credential,
    )
    expect(res.status).toBe(201)
    const { messageId } = await data(res)
    const [msg] = await sql<Array<{ metadata: Record<string, unknown> }>>`
      SELECT metadata FROM kernel.messages WHERE id = ${messageId}`
    expect(msg.metadata.modelId).toBe("claude-haiku-4-5-20251001")
  })

  it("D18: a profile carries its guardrail level, the suggested level for the agent's model and the risk note", async () => {
    await sql`UPDATE kernel.agents SET model_preference = 'claude-opus-5-5' WHERE id = ${agentId}`
    try {
      const put = await call(`/api/nodes/me/profiles/${agentId}`, "PUT", owner, {
        level: "standard",
        liaisonTools: true,
      })
      expect(put.status).toBe(200)
      const body = await data(put)
      expect(body.suggestedGuardrail).toBe("standard")
      expect(body.riskNote).toContain("Untrusted input")
      expect(body.riskNote).toContain("recommended on cheap models")
      const [listed] = await data(await call("/api/nodes/me/profiles", "GET", owner))
      expect(listed).toMatchObject({ level: "standard", liaisonTools: true })
      expect(listed.suggestedGuardrail).toBe("standard")
      // L18: the cloud agent's model is not the node's; the list does not carry it.
      expect(listed.agentModel).toBeUndefined()
      // S20: an unknown field (the old template and config) or level is refused,
      // never stored and silently ignored.
      for (const bad of [
        { level: "standard", liaisonTools: true, template: "custom" },
        { level: "standard", liaisonTools: true, config: { repos: [] } },
        { level: "lax", liaisonTools: true },
        { level: "standard" },
      ]) {
        const res = await call(`/api/nodes/me/profiles/${agentId}`, "PUT", owner, bad)
        expect(res.status).toBe(400)
      }
      const [kept] = await data(await call("/api/nodes/me/profiles", "GET", owner))
      expect(kept).toMatchObject({ level: "standard", liaisonTools: true })
    } finally {
      await sql`UPDATE kernel.agents SET model_preference = NULL WHERE id = ${agentId}`
    }
  })

  it("D24: Open is refused without the in-app confirmation of each node", async () => {
    const n = await enable(owner)
    const refused = await call(`/api/nodes/me/profiles/${agentId}`, "PUT", owner, {
      level: "open",
      liaisonTools: true,
    })
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as any).error).toMatchObject({
      code: "confirmation_required",
      nodeIds: [n.nodeId],
    })
    expect(await data(await call("/api/nodes/me/profiles", "GET", owner))).toHaveLength(0)
    // The old flag is no way around it.
    const flagged = await call(`/api/nodes/me/profiles/${agentId}`, "PUT", owner, {
      level: "open",
      liaisonTools: true,
      confirmOpen: true,
    })
    expect(flagged.status).toBe(400)
    const minted = await call("/api/me/node-level-confirmations", "POST", owner, {
      nodeId: n.nodeId,
      agentId,
      level: "open",
      purpose: "profile_raise",
    })
    expect(minted.status).toBe(201)
    const confirmed = await call(`/api/nodes/me/profiles/${agentId}`, "PUT", owner, {
      level: "open",
      liaisonTools: true,
      confirmationIds: [(await data(minted)).confirmationId],
    })
    expect(confirmed.status).toBe(200)
    const [row] = await data(await call("/api/nodes/me/profiles", "GET", owner))
    expect(row).toMatchObject({ level: "open", liaisonTools: true })
  })

  it("refuses a profile for an agent the caller cannot run", async () => {
    const [theirAgent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@theirs-${crypto.randomUUID().slice(0, 8)}`}, 'Theirs',
              '[]'::jsonb, ${other.userId}) RETURNING id`
    const res = await call(`/api/nodes/me/profiles/${theirAgent.id}`, "PUT", owner, {
      level: "strict",
      liaisonTools: true,
    })
    expect(res.status).toBe(403)
    await sql`DELETE FROM kernel.agents WHERE id = ${theirAgent.id}`
  })
})
