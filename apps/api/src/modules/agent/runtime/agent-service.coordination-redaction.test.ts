// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-FX3: the callee's own ANSWER row, in a coordination exchange, is read by
// a person the moment the nested exchange is expanded.
//
// The relay scrub covers what `agents_ask` hands back to the caller; it never
// touched the row the callee persisted, so the machine name was still sitting
// in the thread under "2 messages between agents". The content is scrubbed at
// WRITE time, and the unscrubbed text is kept in the message metadata under a
// key no surface renders, so the audit keeps exactly what the agent said.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { sql } from "~/db"
import {
  AgentServiceTestAccess,
  COORDINATION_RAW_CONTENT_KEY,
  invokeAgentForThread,
} from "~/modules/agent/runtime/agent-service"
import { toolRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const CALLER = crypto.randomUUID()
const CALLEE = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

const LEAK = "I do not have the ledger__invoice_total tool available in this conversation"
const SCRUBBED = "I do not have the a tool tool available in this conversation"

const actor = {
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {} as Record<string, string[]>,
}

function fakeStream() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: LEAK }
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

async function answerRows(): Promise<
  Array<{ content: string; metadata: Record<string, unknown> | null }>
> {
  const rows = await sql<Array<{ content: string; metadata: Record<string, unknown> | null }>>`
    SELECT content, metadata FROM kernel.messages
    WHERE thread_id = ${THREAD} AND author_type = 'agent' AND author_agent_id = ${CALLEE}
    ORDER BY created_at ASC`
  return rows
}

beforeAll(async () => {
  await acquireTestLock()
  AgentServiceTestAccess.setStreamText(fakeStream as never)
  toolRegistry.set([ORG, "ledger", "invoice_total"], {
    appName: "ledger",
    name: "invoice_total",
    description: "a fixture tool",
    requiredScopes: ["kernel"],
    params: z.object({}),
    handler: async () => ({}),
    readOnly: true,
  })
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Redaction Org', ${`p3b-fx3-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`p3b-fx3-${tag}@t.com`}, 'Redaction User')`
  for (const [id, handle, name] of [
    [CALLER, `@p3b-fx3-caller-${tag}`, "Caller"],
    [CALLEE, `@p3b-fx3-callee-${tag}`, "Callee"],
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
    VALUES (${ORG}, ${`p3b-fx3-${tag}`}, 'thread', 'claude-haiku-4-5', ${USER}) RETURNING id`
  THREAD = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${THREAD}, ${CALLEE}, ${ORG}, 'agent')`
})

afterAll(async () => {
  AgentServiceTestAccess.setStreamText()
  toolRegistry.deleteByPrefix([ORG])
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

describe("what a coordination answer row says to a person", () => {
  it("scrubs a registered tool identifier out of the persisted answer and keeps the original in metadata", async () => {
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
    const rows = await answerRows()
    expect(rows.length).toBe(1)
    expect(rows[0].content).toBe(SCRUBBED)
    expect(rows[0].content).not.toContain("ledger__invoice_total")
    // The audit keeps what the agent actually said, off every rendered path.
    expect(rows[0].metadata?.[COORDINATION_RAW_CONTENT_KEY]).toBe(LEAK)
  })

  it("leaves a human facing turn's own words alone", async () => {
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${THREAD}`
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
    const rows = await answerRows()
    expect(rows.length).toBe(1)
    expect(rows[0].content).toBe(LEAK)
    expect(rows[0].metadata?.[COORDINATION_RAW_CONTENT_KEY]).toBeUndefined()
  })
})
