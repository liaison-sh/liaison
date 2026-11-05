// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { ANTHROPIC_BUDGET_TOKENS } from "~/modules/agent/providers/reasoning"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// A turn whose model Auto picked runs at reasoning High, sent explicitly; an
// explicitly picked model keeps the level asked for (resolveTurnReasoningLevel).

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

const ORG_ID = "00000000-0000-0000-0000-000000ac7a01"
const USER_ID = "00000000-0000-0000-0000-000000ac7a02"
const THREAD_ID = "00000000-0000-0000-0000-000000ac7a03"
const MODEL_ID = "claude-haiku-4-5-autoreason"

const sent: Array<{ providerOptions?: unknown }> = []

function capturingStreamText(args: { providerOptions?: unknown }) {
  sent.push({ providerOptions: args.providerOptions })
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "ok" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

const actor = {
  actorType: "user" as const,
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

async function turn(params: { modelId?: string; reasoningLevel?: "off" | "high" }) {
  const { runAgentChat } = await import("./agent-service")
  sent.length = 0
  const result = await runAgentChat({
    threadId: THREAD_ID,
    content: "reasoning?",
    actor,
    orgId: ORG_ID,
    ...params,
  })
  await result.finalize({
    usage: { promptTokens: 1, completionTokens: 1 },
    finishReason: "stop",
    text: "ok",
    steps: [],
  })
  expect(sent.length).toBe(1)
  return sent[0]?.providerOptions
}

describe("agent-service: Auto turns run at reasoning High", () => {
  beforeAll(async () => {
    await acquireTestLock()
    AgentServiceTestAccess.setStreamText(capturingStreamText as never)
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${ORG_ID}, 'AutoReasonOrg', 'auto-reason-org',
      ${JSON.stringify({ ai: { models: { autoModelKey: MODEL_ID } } })}::jsonb)`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'autoreason@test.com', 'Auto Reason')`
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${ORG_ID}, 'personal', '@autoreason', 'Test agent', ${USER_ID}, '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'auto-reason-chat', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '0', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku AutoReason', '1.00', '5.00', 200000, true, 'starter')`
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  const high = {
    anthropic: {
      thinking: { type: "enabled", budgetTokens: ANTHROPIC_BUDGET_TOKENS.high },
      sendReasoning: true,
    },
  }

  it("an Auto turn (no model picked) sends reasoning High", async () => {
    expect(await turn({})).toEqual(high)
  })

  it("an Auto turn asked for Off still sends High", async () => {
    expect(await turn({ reasoningLevel: "off" })).toEqual(high)
  })

  it("an explicitly picked model asked for Off stays Off", async () => {
    expect(await turn({ modelId: MODEL_ID, reasoningLevel: "off" })).toEqual({
      anthropic: { thinking: { type: "disabled" } },
    })
  })

  it("an explicitly picked model with no level runs at its default (Off)", async () => {
    expect(await turn({ modelId: MODEL_ID })).toEqual({
      anthropic: { thinking: { type: "disabled" } },
    })
  })
})
