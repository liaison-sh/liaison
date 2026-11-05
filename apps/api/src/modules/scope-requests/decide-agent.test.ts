// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An admin asked a role agent to edit a pending draft; the tool was locked
// because the AGENT's ceiling lacked the scope, the agent filed a scope
// request, the admin approved it 20 seconds later, and the tool stayed locked:
// approving granted the scope to the admin (who already held it) and never
// touched the agent. The agent then kept saying its request was still
// awaiting approval, because nothing told the conversation it was decided.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import { randomUUID } from "node:crypto"

const enqueued: Array<{ jobName: string; payload: Record<string, unknown> }> = []
const realJobs = await import("~/infra/jobs/jobs")
const realJobsModule = { ...realJobs }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  enqueueAppJob: async (_app: string, jobName: string, payload: Record<string, unknown>) => {
    enqueued.push({ jobName, payload })
    return "job-id"
  },
}))
// mock.module outlives this file: put the real jobs module back for later files.
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})

const { app } = await import("~/app")
const { sql } = await import("~/db")
const { withPrivilegedDb } = await import("~/db/privileged")
const { withRlsContext } = await import("~/db/rls")
const { invalidateAuthCache } = await import("~/middleware/auth")
const { resolveTurnScope } = await import("~/modules/agent/runtime/agent-service")
const { turnToolScopes } = await import("~/modules/agent/scopes/effective-scope")
const { hasScope } = await import("~/modules/permissions/permissions")
const { createScopeRequest } = await import("~/modules/scope-requests/service")
const { acquireTestLock, releaseTestLock } = await import("~/tests/route-test-setup")

type Json = Record<string, any>

async function req(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  const res = await app.request(path, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as Json }
}

const SCOPE = "kernel:approvals:write"

describe("approving an agent's scope request reaches the agent", () => {
  let adminToken: string
  let adminId: string
  let orgId: string
  /** Holds the request-deciding scope and the scope itself, not agent administration. */
  let deciderToken: string

  beforeAll(async () => {
    await acquireTestLock()
    const tag = randomUUID().slice(0, 8)
    const boot = await req("/api/auth/register", {
      method: "POST",
      body: { email: `sra-admin-${tag}@test.com`, password: "TestPass123!", name: "Dana" },
    })
    adminToken = boot.body.data.accessToken
    const me = await req("/api/users/me", { token: adminToken })
    adminId = me.body.data.id
    orgId = me.body.data.orgId ?? me.body.data.org_id
    if (!orgId) {
      const [row] = await sql<{ org_id: string }[]>`
        SELECT org_id FROM kernel.users WHERE id = ${adminId}`
      orgId = row.org_id
    }

    const role = await req("/api/admin/roles", {
      method: "POST",
      token: adminToken,
      body: { name: `sra-decider-${tag}` },
    })
    for (const scope of ["kernel:scope_requests:admin", SCOPE]) {
      await req(`/api/admin/roles/${role.body.data.id}/scopes`, {
        method: "POST",
        token: adminToken,
        body: { scope },
      })
    }
    const invite = await req("/api/admin/invites", {
      method: "POST",
      token: adminToken,
      body: { email: `sra-decider-${tag}@test.com`, roleId: role.body.data.id },
    })
    const reg = await req("/api/auth/register", {
      method: "POST",
      body: { inviteToken: invite.body.data.inviteToken, password: "TestPass123!", name: "Lee" },
    })
    deciderToken = reg.body.data.accessToken
    invalidateAuthCache()
    // The first registration of a process boots the org (bundled apps and
    // all), which on a loaded machine outlasts the default hook budget.
  }, 180_000)

  afterAll(releaseTestLock)

  /** A role agent lacking SCOPE, a conversation with it, and its pending request. */
  async function agentAsks(scopes: string[] = [SCOPE]) {
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${orgId}, 'role', ${`@desk-${randomUUID().slice(0, 8)}`}, 'Support Desk',
              ${JSON.stringify(["kernel:threads:read", "kernel:approvals:read"])}::jsonb)
      RETURNING id`
    const [thread] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, created_by)
      VALUES (${orgId}, ${`desk-${randomUUID()}`}, ${adminId})
      RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, participant_type)
      VALUES (${thread.id}, ${adminId}, ${orgId}, 'user')`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${thread.id}, ${agent.id}, ${orgId}, 'agent')`
    const adminScopes = (
      await withPrivilegedDb(orgId, "test-admin-scopes", async (tx) => {
        const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
        return loadEffectivePermissions(tx, adminId, orgId)
      })
    ).scopes
    const request = await withRlsContext(
      { actorType: "user", userId: adminId, orgId, scopes: adminScopes, dimensionGrants: {} },
      (tx) =>
        createScopeRequest(tx, {
          orgId,
          requestedBy: adminId,
          requestedByType: "agent",
          agentId: agent.id,
          requestedScopes: scopes,
          originatingThreadId: thread.id,
        }),
    )
    return { agentId: agent.id, threadId: thread.id, requestId: request.id, adminScopes }
  }

  async function ceilingOf(agentId: string): Promise<string[]> {
    const [row] = await sql<{ scope_ceiling: string[] }[]>`
      SELECT scope_ceiling FROM kernel.agents WHERE id = ${agentId}`
    return row.scope_ceiling
  }

  async function decisionLines(threadId: string) {
    return sql<{ id: string; content: string; metadata: Json }[]>`
      SELECT id, content, metadata FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'system'
        AND metadata->>'type' = 'scope-request-decision'`
  }

  it("widens the agent's ceiling, not the admin's grants, and the next turn has the tool", async () => {
    const { agentId, threadId, requestId, adminScopes } = await agentAsks()
    enqueued.length = 0

    // Before: the turn's tool scope lacks it, which is what tool_search reads.
    const before = await withPrivilegedDb(orgId, "test-turn-scope", (tx) =>
      resolveTurnScope(
        tx,
        orgId,
        threadId,
        { userId: adminId, scopes: adminScopes },
        undefined,
        agentId,
      ),
    )
    expect(hasScope(SCOPE, turnToolScopes(adminScopes, before ?? undefined))).toBe(false)

    const dec = await req(`/api/scope-requests/${requestId}/decide`, {
      method: "POST",
      token: adminToken,
      body: { decision: "approve" },
    })
    expect(dec.status).toBe(200)
    expect(dec.body.data.agentGrantedScopes).toEqual([SCOPE])
    expect(dec.body.data.userGrantedScopes).toEqual([])

    expect(await ceilingOf(agentId)).toContain(SCOPE)
    const direct = await sql`
      SELECT 1 FROM kernel.user_scope_grants WHERE user_id = ${adminId} AND scope = ${SCOPE}`
    expect(direct.length).toBe(0)

    const after = await withPrivilegedDb(orgId, "test-turn-scope", (tx) =>
      resolveTurnScope(
        tx,
        orgId,
        threadId,
        { userId: adminId, scopes: adminScopes },
        undefined,
        agentId,
      ),
    )
    expect(hasScope(SCOPE, turnToolScopes(adminScopes, after ?? undefined))).toBe(true)

    // The conversation hears it, and the agent that asked takes the next turn.
    const lines = await decisionLines(threadId)
    expect(lines.length).toBe(1)
    expect(lines[0].metadata.decision).toBe("approved")
    expect(lines[0].metadata.scopeRequestId).toBe(requestId)
    expect(lines[0].content).toContain("Support Desk can now")
    expect(lines[0].content).toContain(SCOPE)
    expect(enqueued).toEqual([
      {
        jobName: "scope-request-decision-turn",
        payload: {
          orgId,
          threadId,
          messageId: lines[0].id,
          requesterId: adminId,
          agentId,
          scopeRequestId: requestId,
        },
      },
    ])
  })

  it("refuses an approver who may not administer agents, and changes nothing", async () => {
    const { agentId, threadId, requestId } = await agentAsks()
    enqueued.length = 0
    const dec = await req(`/api/scope-requests/${requestId}/decide`, {
      method: "POST",
      token: deciderToken,
      body: { decision: "approve" },
    })
    expect(dec.status).toBe(403)
    expect(dec.body.error.message).toContain("kernel:agents:admin")
    expect(await ceilingOf(agentId)).not.toContain(SCOPE)
    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM kernel.scope_requests WHERE id = ${requestId}`
    expect(row.status).toBe("pending")
    expect((await decisionLines(threadId)).length).toBe(0)
    expect(enqueued.length).toBe(0)
    // Still pending, it would cover (and so absorb) the next test's identical ask.
    await sql`UPDATE kernel.scope_requests SET status = 'cancelled' WHERE id = ${requestId}`
  })

  it("never puts an organization-administration scope in a role agent's ceiling", async () => {
    const { agentId, requestId } = await agentAsks(["kernel:users:admin"])
    const dec = await req(`/api/scope-requests/${requestId}/decide`, {
      method: "POST",
      token: adminToken,
      body: { decision: "approve" },
    })
    expect(dec.status).toBe(422)
    expect(await ceilingOf(agentId)).not.toContain("kernel:users:admin")
  })

  it("a denial is told to the conversation too, and the agent answers it", async () => {
    const { agentId, threadId, requestId } = await agentAsks()
    enqueued.length = 0
    const dec = await req(`/api/scope-requests/${requestId}/decide`, {
      method: "POST",
      token: adminToken,
      body: { decision: "deny", reason: "not this week" },
    })
    expect(dec.status).toBe(200)
    expect(await ceilingOf(agentId)).not.toContain(SCOPE)
    const lines = await decisionLines(threadId)
    expect(lines.length).toBe(1)
    expect(lines[0].metadata.decision).toBe("denied")
    expect(lines[0].content).toContain("not this week")
    expect(lines[0].content).toContain("Support Desk still cannot")
    expect(enqueued.map((e) => e.jobName)).toEqual(["scope-request-decision-turn"])
  })
})
