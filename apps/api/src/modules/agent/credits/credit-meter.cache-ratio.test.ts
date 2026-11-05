// SPDX-License-Identifier: FSL-1.1-ALv2
// P4c-T48: every turn logs the provider's prompt-cache numbers where the
// provider's usage already lands, so the observed ratio and the billed cost can
// never come from two different accountings of the same turn.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import {
  cacheHitRatio,
  creditMeterLogger,
  finalizeUsage,
} from "~/modules/agent/credits/credit-meter"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"

const ORG_ID = crypto.randomUUID()
const USER_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)

const model = {
  provider: "anthropic",
  modelId: "claude-test-1",
  inputCostPerM: "3",
  outputCostPerM: "15",
}

describe("cacheHitRatio", () => {
  it("counts cache reads inside inputTokens for anthropic too", () => {
    // The AI SDK reports Anthropic's inputTokens as the whole prompt
    // (uncached + writes + reads): 900 of a 1000 token prompt.
    expect(cacheHitRatio("anthropic", 1000, 900)).toBeCloseTo(0.9, 10)
  })

  it("counts cache reads inside inputTokens for the subset providers", () => {
    expect(cacheHitRatio("google", 1000, 900)).toBeCloseTo(0.9, 10)
    expect(cacheHitRatio("openai", 1000, 250)).toBeCloseTo(0.25, 10)
  })

  it("is 0, never NaN, for a turn that sent no prompt", () => {
    expect(cacheHitRatio("google", 0, 0)).toBe(0)
  })
})

describe("finalizeUsage telemetry", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'CacheRatioOrg', ${`cache-ratio-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_ID}, ${ORG_ID}, ${`cache-ratio-${tag}@test.com`}, 'Ratio', 'x')`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("a turn logs cache_hit_ratio from the provider usage", async () => {
    const infoSpy = spyOn(creditMeterLogger, "info")
    try {
      await finalizeUsage(ORG_ID, {
        model,
        inputTokens: 1000,
        outputTokens: 40,
        cachedInputTokens: 900,
        cacheWriteTokens: 50,
        keySource: "byok",
        userId: USER_ID,
      })
      const lines = infoSpy.mock.calls.filter((c) => c[1] === "cache_hit_ratio")
      expect(lines).toHaveLength(1)
      const payload = lines[0]?.[0] as Record<string, unknown>
      expect(payload.orgId).toBe(ORG_ID)
      expect(payload.cacheReadTokens).toBe(900)
      expect(payload.cacheWriteTokens).toBe(50)
      expect(payload.ratio).toBeCloseTo(0.9, 10)
    } finally {
      infoSpy.mockRestore()
    }
  })
})

// G1 (P4c-T28 gap): agent-service.ts must accumulate the Anthropic cache
// creation (write) count from providerMetadata and hand it to finalizeUsage,
// exactly like it already does for cachedInputTokens (cache reads). This
// drives a REAL turn through invokeAgentForThread with a fake provider stream
// so the accumulation code itself is exercised, not just finalizeUsage.
describe("G1: agent-service surfaces the provider's cache write tokens", () => {
  const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
  const G1_ORG_ID = crypto.randomUUID()
  const G1_USER_ID = crypto.randomUUID()
  const G1_AGENT_ID = crypto.randomUUID()
  const G1_THREAD_ID = crypto.randomUUID()
  const g1Tag = G1_ORG_ID.slice(0, 8)

  function fakeCacheWriteStreamText() {
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", text: "cached reply" }
        yield {
          type: "finish-step",
          // AI SDK 7's LanguageModelUsage: cache reads and writes in
          // inputTokenDetails (the provider's cache_creation_input_tokens).
          usage: {
            inputTokens: 500,
            outputTokens: 20,
            inputTokenDetails: { cacheReadTokens: 50, cacheWriteTokens: 777 },
          },
          finishReason: "stop",
        }
        yield { type: "finish", finishReason: "stop" }
      })(),
    } as never
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${G1_ORG_ID}, 'CacheWriteOrg', ${`cache-write-${g1Tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${G1_USER_ID}, ${G1_ORG_ID}, ${`cache-write-${g1Tag}@test.com`}, 'CacheWrite', 'x')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${G1_AGENT_ID}, ${G1_ORG_ID}, 'personal', '@cachewrite', 'CacheWrite Agent', ${G1_USER_ID}, '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${G1_THREAD_ID}, ${G1_ORG_ID}, ${`cache-write-${g1Tag}`}, 'agent_chat', ${G1_USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${G1_THREAD_ID}, ${G1_USER_ID}, ${G1_ORG_ID})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${G1_ORG_ID}, '10.00000000', '0', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${`claude-haiku-4-5-cache-write-${g1Tag}`}, 'Claude Haiku CacheWrite', '1.00', '5.00', 200000, true, 'starter')`
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    await sql`DELETE FROM kernel.messages WHERE org_id = ${G1_ORG_ID}`
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${G1_ORG_ID}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${G1_ORG_ID}`
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${`claude-haiku-4-5-cache-write-${g1Tag}`}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${G1_THREAD_ID}`
    await sql`DELETE FROM kernel.threads WHERE id = ${G1_THREAD_ID}`
    await sql`DELETE FROM kernel.agents WHERE id = ${G1_AGENT_ID}`
    await sql`DELETE FROM kernel.users WHERE id = ${G1_USER_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${G1_ORG_ID}`
  })

  it("a turn logs cache_hit_ratio with the provider's cache write tokens", async () => {
    AgentServiceTestAccess.setStreamText(fakeCacheWriteStreamText as never)
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    const infoSpy = spyOn(creditMeterLogger, "info")
    try {
      const msgId = crypto.randomUUID()
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${msgId}, ${G1_THREAD_ID}, ${G1_ORG_ID}, ${G1_USER_ID}, 'user', 'trigger a cache write', '{}')`

      const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
      await invokeAgentForThread(
        G1_THREAD_ID,
        msgId,
        { userId: G1_USER_ID, orgId: G1_ORG_ID, scopes: ["*"], dimensionGrants: {} },
        G1_ORG_ID,
      )

      const lines = infoSpy.mock.calls.filter((c) => c[1] === "cache_hit_ratio")
      expect(lines.length).toBeGreaterThanOrEqual(1)
      const payload = lines[lines.length - 1]?.[0] as Record<string, unknown>
      expect(payload.orgId).toBe(G1_ORG_ID)
      // The fake provider's finish-step chunk carried cacheWriteTokens: 777 —
      // agent-service.ts must have read THAT field (not cacheReadTokens, the
      // cache READ count) and handed it to finalizeUsage as cacheWriteTokens.
      expect(payload.cacheWriteTokens).toBe(777)
    } finally {
      infoSpy.mockRestore()
      AgentServiceTestAccess.setStreamText()
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })
})
