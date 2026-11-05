// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T07 (P4's seam): `onSessionWaiting` fires after commit, once per
// transition of a session's open requests from none to some, from node
// ingest and from server appends, never for a re-sent batch; a throwing
// listener never fails ingest.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { NodeSessionEventIn } from "@liaison/shared"
import { app } from "~/app"
import { sql } from "~/db"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import type { NodeSessionRow } from "./store"
import {
  fireSessionStatus,
  onSessionStatus,
  onSessionWaiting,
  type SessionStatusChange,
  type SessionWaitingRequest,
} from "./waiting-hook"

describe("the waiting hook (P3-T07)", () => {
  let owner: minimal.Session
  let agentId: string
  let node: { nodeId: string; credential: string }
  let jobId: string
  let sessionId: string
  let fired: Array<{ row: NodeSessionRow; request: SessionWaitingRequest }>
  let off: Array<() => void>

  const call = (p: string, method: string, body?: unknown, cred?: string) =>
    app.request(p, {
      method,
      headers: {
        Authorization: `Bearer ${owner.bearer}`,
        ...(cred ? { "X-Node-Credential": cred } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const json = async (res: Response) => (await res.json()) as any
  const at = () => new Date().toISOString()

  const post = (batchNo: number, events: NodeSessionEventIn[]) =>
    call(
      `/api/node/sessions/${sessionId}/events`,
      "POST",
      { jobId, leaseGeneration: 1, batchNo, events },
      node.credential,
    )
  const permission = (requestId: string, tool = "Write"): NodeSessionEventIn => ({
    at: at(),
    type: "permission_request",
    payload: { requestId, tool, input: { file_path: "/tmp/x" }, reason: "outside" },
  })
  const decision = (requestId: string): NodeSessionEventIn => ({
    at: at(),
    type: "decision",
    payload: { requestId, outcome: "allow", by: "owner" },
  })

  beforeAll(async () => {
    await acquireTestLock()
    owner = await minimal.session((await createTestOrg()).id)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@wh-${crypto.randomUUID().slice(0, 8)}`}, 'Fixer',
              '["kernel:threads:read"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
  })

  beforeEach(async () => {
    fired = []
    off = [onSessionWaiting((row, request) => void fired.push({ row, request }))]
    const res = await call("/api/nodes", "POST", { deviceId: `d.${crypto.randomUUID()}` })
    const d = (await json(res)).data
    node = { nodeId: d.node.id, credential: d.credential }
    const [job] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_jobs
        (org_id, owner_user_id, agent_id, node_id, source, prompt, status, lease_holder,
         lease_generation, lease_expires_at, started_at)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${node.nodeId}, 'app', 'Fix it',
              'running', ${node.nodeId}, 1, now() + interval '2 minutes', now())
      RETURNING id`
    jobId = job.id
    const [session] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_sessions
        (org_id, owner_user_id, node_id, job_id, agent_id, source, config_kind, title, prompt,
         model, level, status, started_at)
      VALUES (${owner.orgId}, ${owner.userId}, ${node.nodeId}, ${jobId}, ${agentId}, 'app',
              'owner', 'Fix it', 'Fix it', 'claude-haiku-4-5', 'strict', 'running', now())
      RETURNING id`
    sessionId = session.id
  })

  afterEach(async () => {
    for (const f of off) f()
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
  })

  afterAll(async () => {
    if (owner) await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    await releaseTestLock()
  })

  it("fires once for the first permission_request, not for a second one while waiting, not for a re-sent batch, and again after a decision brought the count to 0 and a new request came", async () => {
    const first = [
      { at: at(), type: "assistant_text", payload: { text: "writing" } } as NodeSessionEventIn,
      permission("r1"),
    ]
    expect((await post(1, first)).status).toBe(200)
    expect(fired).toHaveLength(1)
    expect(fired[0].row).toMatchObject({
      id: sessionId,
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      title: "Fix it",
      status: "waiting",
      pendingCount: 1,
    })
    expect(fired[0].request).toEqual({
      requestId: "r1",
      eventSeq: 2,
      type: "permission_request",
      tool: "Write",
    })

    // The same batch again: a replay, nothing fires.
    expect((await post(1, first)).status).toBe(200)
    // A second request while one is open: still waiting, nothing fires.
    expect((await post(2, [permission("r2", "Bash")])).status).toBe(200)
    expect(fired).toHaveLength(1)

    // Both decided: back to 0; a new question fires again.
    expect((await post(3, [decision("r1"), decision("r2")])).status).toBe(200)
    expect(fired).toHaveLength(1)
    const question: NodeSessionEventIn = {
      at: at(),
      type: "question",
      payload: { requestId: "q1", questions: [{ question: "A or B?" }] },
    }
    expect((await post(4, [question])).status).toBe(200)
    expect(fired).toHaveLength(2)
    expect(fired[1].request).toMatchObject({ requestId: "q1", type: "question", tool: null })
  })

  it("a throwing listener does not fail ingest, and the others still hear it", async () => {
    off.push(
      onSessionWaiting(() => {
        throw new Error("push down")
      }),
    )
    off.push(onSessionWaiting(async () => Promise.reject(new Error("async push down"))))
    const res = await post(1, [permission("r1")])
    expect(res.status).toBe(200)
    expect(fired).toHaveLength(1)
    const [row] = await sql<Array<{ status: string }>>`
      SELECT status FROM kernel.node_sessions WHERE id = ${sessionId}`
    expect(row.status).toBe("waiting")
  })

  it("an unsubscribed listener hears nothing", async () => {
    for (const f of off.splice(0)) f()
    expect((await post(1, [permission("r1")])).status).toBe(200)
    expect(fired).toHaveLength(0)
  })

  it("fireSessionStatus calls listeners and swallows their errors", async () => {
    const heard: SessionStatusChange[] = []
    off.push(
      onSessionStatus(() => {
        throw new Error("notify down")
      }),
    )
    off.push(onSessionStatus(async () => Promise.reject(new Error("async notify down"))))
    off.push(onSessionStatus((_row, change) => void heard.push(change)))
    const [row] = await sql<
      NodeSessionRow[]
    >`SELECT * FROM kernel.node_sessions WHERE id = ${sessionId}`
    await expect(
      fireSessionStatus(row, { from: "running", to: "done", cause: "node" }),
    ).resolves.toBeUndefined()
    expect(heard).toEqual([{ from: "running", to: "done", cause: "node" }])
  })

  it("S12: a node batch that opens a permission request fires fireSessionStatus once with to waiting", async () => {
    const heard: Array<{ row: NodeSessionRow; change: SessionStatusChange }> = []
    off.push(onSessionStatus((row, change) => void heard.push({ row, change })))
    const first = [permission("r1")]
    expect((await post(1, first)).status).toBe(200)
    // A re-send and a second request while waiting fire nothing more.
    expect((await post(1, first)).status).toBe(200)
    expect((await post(2, [permission("r2", "Bash")])).status).toBe(200)
    expect(heard).toHaveLength(1)
    expect(heard[0].row.id).toBe(sessionId)
    expect(heard[0].change).toMatchObject({
      from: "running",
      to: "waiting",
      cause: "node",
      becameWaiting: { requestId: "r1", type: "permission_request", tool: "Write" },
    })
  })
})
