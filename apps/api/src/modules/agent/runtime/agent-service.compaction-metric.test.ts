// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Compaction trigger metric: `getLastInputTokens` must reflect the size of the
// model's CONTEXT (the last step's input tokens), not the SUM of input tokens
// across every step of the previous run. The summed figure grows linearly with
// tool-call count (a 20-step run reads as 20x the real context), which made
// compaction fire on multi-step runs whose actual context was far below the
// window — burning an extra full-context generateText call per turn.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

const ORG_ID = "00000000-0000-0000-0000-000000cd0001"
const USER_ID = "00000000-0000-0000-0000-000000cd0002"
const THREAD_ID = "00000000-0000-0000-0000-000000cd0003"

/** Two-step run: the summed input is 260k, but the LAST step's context was 160k. */
function fakeTwoStepStreamText() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "step one" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 100000, outputTokens: 10 },
        finishReason: "tool-calls",
      }
      yield { type: "text-delta", text: " step two" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 160000, outputTokens: 20 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

// The speaking agent: an agent-authored row names it (0080).
const AGENT_ID = "00000000-0000-0000-0000-00000000cc90"

describe("compaction metric — per-step last input tokens", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'CompactMetricOrg', 'compact-metric-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'compactmetric@test.com', 'Compact Metric')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', '@compactmetric', 'Test agent', ${USER_ID}, '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'compact-metric-chat', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '0', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', 'claude-haiku-4-5-compact-metric', 'Claude Haiku CompactMetric', '1.00', '5.00', 200000, true, 'starter')`
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    // This file runs a real agent turn, which calls ensureAppsForOrg(ORG_ID) and
    // registers every bundled app + its app-shipped skills into the process-global
    // registries under this org. Drop them so a later file asserting an empty org
    // does not read our registrations.
    resetOrgRuntimeForTest(ORG_ID)
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = 'claude-haiku-4-5-compact-metric'`
    await releaseTestLock()
  })

  describe("getLastInputTokens", () => {
    it("prefers usage.lastStepInputTokens over the summed usage.inputTokens", async () => {
      const { getLastInputTokens } = await import("./agent-service")
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, required_scopes)
        VALUES ('00000000-0000-0000-0000-cccccccccc01', ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'agent', ${AGENT_ID}, 'multi-step reply',
                '{"usage":{"inputTokens":3494740,"outputTokens":10112,"lastStepInputTokens":166416},"stepCount":21}'::jsonb, '{}')`
      try {
        expect(await getLastInputTokens(THREAD_ID, ORG_ID)).toBe(166416)
      } finally {
        await sql`DELETE FROM kernel.messages WHERE id = '00000000-0000-0000-0000-cccccccccc01'`
      }
    })

    it("legacy rows without lastStepInputTokens: approximates via inputTokens / stepCount", async () => {
      const { getLastInputTokens } = await import("./agent-service")
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, required_scopes)
        VALUES ('00000000-0000-0000-0000-cccccccccc02', ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'agent', ${AGENT_ID}, 'legacy multi-step reply',
                '{"usage":{"inputTokens":3000000,"outputTokens":5000},"stepCount":20}'::jsonb, '{}')`
      try {
        expect(await getLastInputTokens(THREAD_ID, ORG_ID)).toBe(150000)
      } finally {
        await sql`DELETE FROM kernel.messages WHERE id = '00000000-0000-0000-0000-cccccccccc02'`
      }
    })

    it("legacy rows without stepCount fall back to the raw inputTokens", async () => {
      const { getLastInputTokens } = await import("./agent-service")
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, required_scopes)
        VALUES ('00000000-0000-0000-0000-cccccccccc03', ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'agent', ${AGENT_ID}, 'legacy single-step reply',
                '{"usage":{"inputTokens":150000,"outputTokens":1000}}'::jsonb, '{}')`
      try {
        expect(await getLastInputTokens(THREAD_ID, ORG_ID)).toBe(150000)
      } finally {
        await sql`DELETE FROM kernel.messages WHERE id = '00000000-0000-0000-0000-cccccccccc03'`
      }
    })
  })

  it("invokeAgentForThread persists usage.lastStepInputTokens = the FINAL step's input tokens", async () => {
    AgentServiceTestAccess.setStreamText(fakeTwoStepStreamText as never)
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      // Persist the triggering user message the way the thread route would.
      const msgId = "00000000-0000-0000-0000-cccccccccc10"
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${msgId}, ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'user', 'run two steps', '{}')`

      const { invokeAgentForThread } = await import("./agent-service")
      await invokeAgentForThread(
        THREAD_ID,
        msgId,
        { userId: USER_ID, orgId: ORG_ID, scopes: ["*"], dimensionGrants: {} },
        ORG_ID,
      )

      const msgs = await sql`
        SELECT metadata FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
        ORDER BY created_at DESC LIMIT 1
      `
      expect(msgs.length).toBeGreaterThanOrEqual(1)
      const meta = msgs[0].metadata as any
      // Billing keeps the true sum; the compaction metric keeps the real context size.
      expect(meta.usage.inputTokens).toBe(260000)
      expect(meta.usage.lastStepInputTokens).toBe(160000)
    } finally {
      AgentServiceTestAccess.setStreamText()
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })
})
