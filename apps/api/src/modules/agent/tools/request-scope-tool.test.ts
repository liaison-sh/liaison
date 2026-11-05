// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { ActorContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { handleRequestScope } from "~/modules/agent/tools/scope-request-tools"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-0000-0000-0000008c0001"
const AGENT_USER = "00000000-0000-0000-0000-0000008c0011"

describe("request_scope kernel tool", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES
      (${ORG}, 'ReqScopeOrg', 'req-scope-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash) VALUES
      (${AGENT_USER}, ${ORG}, 'agent-rs@test.com', 'Agent RS', 'x') ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.scope_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("names the ACTING AGENT through the real in-turn tool bridge, not the human", async () => {
    // The admin row read "App Review [Agent]" for a request Support Desk
    // raised, and `kernel.scope_requests.agent_id` was null on the only pending
    // row. The direct-handler test below could never have caught it: the
    // identity is read off the live run frame, which only the bridge opens.
    const AGENT = "00000000-0000-0000-0000-0000008c0021"
    const THREAD = "00000000-0000-0000-0000-0000008c0031"
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${AGENT}, ${ORG}, 'role', '@rs-support', 'Support Desk', '["*"]'::jsonb, 'You help.')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'rs-thread', 'agent_chat', ${AGENT_USER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD}, ${AGENT_USER}, ${ORG})`
    await registerKernelAgentTools(ORG)
    const actor: ActorContext = {
      actorType: "user",
      userId: AGENT_USER,
      orgId: ORG,
      scopes: ["*"],
      dimensionGrants: {},
    }
    const runFrame = {
      runId: "run-rs",
      parentRunId: null,
      rootRunId: "run-rs",
      nestingDepth: 0,
      agentId: AGENT,
      effectiveScope: ["*"],
      turnScopeAccumulator: createTurnScopeAccumulator(),
    }
    const tools = buildToolSet(
      ORG,
      actor,
      THREAD,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      runFrame as never,
    )
    const result = (await tools.kernel__request_scope.execute(
      { scopes: ["ads:insights:read"], reason: "the team wants last week's spend in the digest" },
      {},
    )) as { requestId?: string }
    expect(result.requestId).toBeTruthy()
    const requestId = result.requestId as string
    const rows = await sql`SELECT agent_id, requested_by, requested_by_type, originating_thread_id
      FROM kernel.scope_requests WHERE id = ${requestId}`
    expect(rows[0].agent_id).toBe(AGENT)
    // The human stays the row's identity for RLS; the agent is the speaker.
    expect(rows[0].requested_by).toBe(AGENT_USER)
    expect(rows[0].requested_by_type).toBe("agent")
    expect(rows[0].originating_thread_id).toBe(THREAD)
    await sql`DELETE FROM kernel.scope_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${THREAD}`
    await sql`DELETE FROM kernel.threads WHERE id = ${THREAD}`
    await sql`DELETE FROM kernel.agents WHERE id = ${AGENT}`
  })

  it("request_scope creates a pending agent-typed scope_request", async () => {
    const res = await withRlsContext(
      {
        actorType: "user",
        userId: AGENT_USER,
        orgId: ORG,
        scopes: ["kernel:threads:read"],
        dimensionGrants: {},
      },
      (db) =>
        handleRequestScope(
          { scopes: ["mail:conversations:write"], reason: "Reply to the customer" },
          {
            userId: AGENT_USER,
            orgId: ORG,
            agentExecutionThreadId: undefined,
            scopes: ["kernel:threads:read"],
            db,
          },
        ),
    )
    expect(res.requested).toBe(true)
    expect(res.requestId).toBeTruthy()

    const rows =
      await sql`SELECT requested_by_type, requested_scopes, status FROM kernel.scope_requests WHERE id = ${res.requestId}`
    expect(rows[0].requested_by_type).toBe("agent")
    expect(rows[0].requested_scopes).toEqual(["mail:conversations:write"])
    expect(rows[0].status).toBe("pending")
  })
})
