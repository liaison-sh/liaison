// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T08: a turn started by an AGENT nests; a turn started by a human stays
// flat.
//
// That asymmetry is the whole rendering rule. A human asked a question, so the
// answer belongs at the thread root where the room reads it. An agent asked
// another agent, so the exchange belongs under the message that triggered it,
// out of the room's main line. The nest is ONE level deep, always under the
// triggering message, never a chain that grows one link per reply.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { AgentServiceTestAccess, invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const CALLER = crypto.randomUUID()
const CALLEE = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

const actor = {
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {} as Record<string, string[]>,
}

function fakeStream() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "the answer" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 3, outputTokens: 2 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

async function seedTrigger(content: string, agentId?: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
    VALUES (${THREAD}, ${ORG}, ${USER}, ${agentId ? "agent" : "user"}, ${agentId ?? null},
            ${content}, '{}'::text[])
    RETURNING id`
  return row.id
}

async function parentsOfAgentReplies(since: string): Promise<Array<string | null>> {
  const rows = await sql<{ parent_message_id: string | null }[]>`
    SELECT parent_message_id FROM kernel.messages
    WHERE thread_id = ${THREAD} AND author_type = 'agent' AND id <> ${since}
      AND content = 'the answer'
    ORDER BY created_at ASC`
  return rows.map((r) => r.parent_message_id)
}

beforeAll(async () => {
  await acquireTestLock()
  AgentServiceTestAccess.setStreamText(fakeStream as never)
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Nesting Org', ${`p3b-t08-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`p3b-t08-${tag}@t.com`}, 'Nest User')`
  for (const [id, handle, name] of [
    [CALLER, `@p3b-t08-caller-${tag}`, "Caller"],
    [CALLEE, `@p3b-t08-callee-${tag}`, "Callee"],
  ]) {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${id}, ${ORG}, 'role', ${handle}, ${name}, '["*"]'::jsonb)`
  }
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${ORG}, '10.00000000', '5.00000000', 'EUR')`
  await sql`INSERT INTO kernel.model_pricing
      (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
    VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00', '5.00', 200000, true, 'starter')
    ON CONFLICT (provider, model_id) DO NOTHING`
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, agent_model_id, created_by)
    VALUES (${ORG}, ${`p3b-t08-${tag}`}, 'thread', 'claude-haiku-4-5', ${USER}) RETURNING id`
  THREAD = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${THREAD}, ${CALLEE}, ${ORG}, 'agent')`
})

afterAll(async () => {
  AgentServiceTestAccess.setStreamText()
  await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("where an agent turn's messages land", () => {
  it("a human triggered turn writes messages with a null parent", async () => {
    const trigger = await seedTrigger("a human question")
    await invokeAgentForThread(
      THREAD,
      trigger,
      actor,
      ORG,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      CALLEE,
    )
    const parents = await parentsOfAgentReplies(trigger)
    expect(parents.length).toBeGreaterThan(0)
    expect(parents.every((p) => p === null)).toBe(true)
  })

  it("an agent triggered turn writes every message parented to the triggering message", async () => {
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${THREAD}`
    const trigger = await seedTrigger("an agent question", CALLER)
    await invokeAgentForThread(
      THREAD,
      trigger,
      actor,
      ORG,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      CALLEE,
      { callerAgentId: CALLER, parentMessageId: trigger },
    )
    const parents = await parentsOfAgentReplies(trigger)
    expect(parents.length).toBeGreaterThan(0)
    expect(parents.every((p) => p === trigger)).toBe(true)
  })

  it("a two message agent turn parents both messages to the same triggering message, not to each other", async () => {
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${THREAD}`
    const trigger = await seedTrigger("an agent question asked twice", CALLER)
    for (let i = 0; i < 2; i++) {
      await invokeAgentForThread(
        THREAD,
        trigger,
        actor,
        ORG,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        CALLEE,
        { callerAgentId: CALLER, parentMessageId: trigger },
      )
    }
    const parents = await parentsOfAgentReplies(trigger)
    expect(parents.length).toBe(2)
    expect(parents).toEqual([trigger, trigger])
  })
})
