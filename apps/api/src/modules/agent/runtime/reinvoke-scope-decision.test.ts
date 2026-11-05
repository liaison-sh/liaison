// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The turn a decided scope request hands back to the agent that asked: one
// background turn, AS that agent, answering the decision line, and never a
// second one once the agent has spoken since.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import { randomUUID } from "node:crypto"

const invocations: unknown[][] = []
const realAgentService = await import("~/modules/agent/runtime/agent-service")
const realAgentServiceModule = { ...realAgentService }
mock.module("~/modules/agent/runtime/agent-service", () => ({
  ...realAgentServiceModule,
  invokeAgentForThread: async (...args: unknown[]) => {
    invocations.push(args)
    return { finishReason: "stop" }
  },
}))
afterAll(() => {
  mock.module("~/modules/agent/runtime/agent-service", () => realAgentServiceModule)
})

const { sql } = await import("~/db")
const { runScopeDecisionTurn } = await import("~/modules/agent/runtime/reinvoke")

const ORG = randomUUID()
const USER = randomUUID()
const AGENT = randomUUID()
const THREAD = randomUUID()

describe("runScopeDecisionTurn", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'ScopeTurnOrg', ${`scope-turn-${ORG.slice(0, 8)}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER}, ${ORG}, ${`st-${USER.slice(0, 8)}@test.com`}, 'Dana', 'x')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'role', '@st-desk', 'Support Desk', '[]'::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${THREAD}, ${ORG}, ${`st-${THREAD}`}, ${USER})`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  async function decisionLine(): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (org_id, thread_id, author_id, author_type, content, metadata, required_scopes)
      VALUES (${ORG}, ${THREAD}, ${USER}, 'system', 'Access request approved by Dana.',
              ${JSON.stringify({ type: "scope-request-decision", decision: "approved" })}::jsonb,
              '{}')
      RETURNING id`
    return row.id
  }

  it("starts one background turn as the agent that asked, off the decision line", async () => {
    invocations.length = 0
    const messageId = await decisionLine()
    await runScopeDecisionTurn({
      orgId: ORG,
      threadId: THREAD,
      messageId,
      requesterId: USER,
      agentId: AGENT,
    })
    expect(invocations.length).toBe(1)
    const [threadId, triggerId, actor, orgId, background, , , , anchor, actingAgentId] =
      invocations[0] as [string, string, { userId: string }, string, boolean, ...unknown[]]
    expect(threadId).toBe(THREAD)
    expect(triggerId).toBe(messageId)
    expect(actor.userId).toBe(USER)
    expect(orgId).toBe(ORG)
    expect(background).toBe(true)
    expect(anchor).toBe(false)
    expect(actingAgentId).toBe(AGENT)
  })

  it("does not speak again once the agent has answered since the line", async () => {
    invocations.length = 0
    const messageId = await decisionLine()
    await sql`INSERT INTO kernel.messages (org_id, thread_id, author_id, author_type, author_agent_id, content, required_scopes, created_at)
      VALUES (${ORG}, ${THREAD}, ${USER}, 'agent', ${AGENT}, 'I can now edit the draft. Shall I?', '{}',
              now() + interval '1 second')`
    await runScopeDecisionTurn({
      orgId: ORG,
      threadId: THREAD,
      messageId,
      requesterId: USER,
      agentId: AGENT,
    })
    expect(invocations.length).toBe(0)
  })

  it("leaves it to the person's own turn when they wrote after the line", async () => {
    invocations.length = 0
    // The previous case's agent reply is dated ahead: clear it, so only the
    // person's message can answer this line.
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${THREAD}`
    const messageId = await decisionLine()
    await sql`INSERT INTO kernel.messages (org_id, thread_id, author_id, author_type, content, required_scopes, created_at)
      VALUES (${ORG}, ${THREAD}, ${USER}, 'user', 'ok go ahead', '{}', now() + interval '2 seconds')`
    await runScopeDecisionTurn({
      orgId: ORG,
      threadId: THREAD,
      messageId,
      requesterId: USER,
      agentId: AGENT,
    })
    expect(invocations.length).toBe(0)
  })
})
