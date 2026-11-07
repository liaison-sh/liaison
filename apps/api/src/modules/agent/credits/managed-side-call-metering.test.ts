// SPDX-License-Identifier: FSL-1.1-ALv2
//
// On a managed cell EVERY model call made for an org is metered to that org's
// allowance, not only its turns: the side calls outside the loop (the memory
// flush of a consolidation, checkpoint briefs, fact extraction and episode
// summaries, auto-titles, web extraction) each write one billed `usage` row at
// what OpenRouter reported. These calls spend on the cell's key, so one that
// wrote nothing would leave the usage report below what the provider bills. A self-hosted instance has no credits and keeps
// these calls unrecorded, as before.
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Restore the demo-only early return in `meterSideCall`: the checkpoint-style
//    call, the auto-title and the extraction write no row.
//  * Drop the `credit` runCompaction/defaultFlush hand to `runMemoryFlush`, or
//    meter only a visitor's flush there: the consolidation flush writes no row.
//  * Meter auto-title or extraction outside `preCheck`: a past-due org's call
//    reaches the stub.
//  * Drop the managed gate in `meterSideCall`: the self-hosted flush writes a row.
//  * Build a side call's model from the bare Auto selection ({ provider,
//    modelId }) instead of its resolved ModelInfo: the request carries the
//    org's model key (`openrouter/acme/...`) instead of the upstream id, which
//    OpenRouter refuses as "not a valid model ID" (the auto-title stayed
//    untitled on every self-hosted OpenRouter workspace).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { generateText } from "ai"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { agents } from "~/db/schema/kernel/agents"
import { threads } from "~/db/schema/kernel/threads"
import { _setEdition } from "~/lib/edition"
import { redis } from "~/lib/redis"
import { meterSideCall, preCheck } from "~/modules/agent/credits/credit-meter"
import { flushRegion, type RegionMessage } from "~/modules/agent/memory/consolidation"
import { resolveSideCallModel } from "~/modules/agent/providers/side-call-model"
import { autoTitleAgentChat } from "~/modules/agent/runtime/auto-title"
import { runSandboxedExtraction } from "~/modules/agent/tools/web-tools"
import { clearOrgBillingStatusCache } from "~/modules/cloud/billing-status"
import { clearTestCreditPricing, setTestCreditPricing } from "~/tests/helpers/credit-pricing"
import {
  cleanupManagedOrg,
  type ManagedOpenRouterStub,
  STUB_ANSWER,
  STUB_CALL_COST_USD,
  seedManagedOrg,
  setManagedOrgStatus,
  startManagedOpenRouterStub,
} from "~/tests/helpers/managed-openrouter"

const ORG = "00000000-0000-4000-8000-0000005d0001"
const USER = "00000000-0000-4000-8000-0000005d0002"
const CELL_KEY = "sk-or-test-cell-key-side-calls"
const MODEL_KEY = "openrouter/acme/side-call-model"
const ENV_VARS = ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "LIAISON_OFFLINE_SIDE_CALLS"]
const savedEnv: Record<string, string | undefined> = {}
let stub: ManagedOpenRouterStub

/** The org's one added OpenRouter model, its Auto: what side calls pick. */
const ADDED_MODEL = {
  key: MODEL_KEY,
  provider: "openrouter",
  upstreamId: "acme/side-call-model",
  displayName: "Side call model",
  contextWindow: 200000,
  inputCostPerM: "0.1",
  outputCostPerM: "0.4",
  tools: true,
  reasoningEfforts: [],
  canDisableReasoning: true,
  enabled: true,
  addedAt: "2026-11-01T00:00:00.000Z",
}

async function usageRows() {
  return sql<
    {
      type: string
      model: string
      raw_cost_usd: string | null
      user_id: string | null
      amount: string
    }[]
  >`
    SELECT type, model, raw_cost_usd, user_id, amount FROM kernel.credit_transactions
     WHERE org_id = ${ORG} ORDER BY created_at`
}

function expectOneBilledRow(rows: Awaited<ReturnType<typeof usageRows>>) {
  expect(rows).toHaveLength(1)
  expect(rows[0].type).toBe("usage")
  expect(rows[0].model).toBe(MODEL_KEY)
  expect(Number(rows[0].raw_cost_usd)).toBeCloseTo(STUB_CALL_COST_USD, 8)
  expect(Number(rows[0].amount)).toBeLessThan(0)
  // No acting user: billed to a real org user, never the system sentinel.
  expect(rows[0].user_id).toBe(USER)
}

function region(): RegionMessage[] {
  return [
    {
      id: crypto.randomUUID(),
      content: "Remember: the Tuesday pickup window moved to 16:00.",
      createdAt: new Date(),
      requiredScopes: [],
      disclosureList: null,
      authorType: "user",
      authorId: null,
    },
    {
      id: crypto.randomUUID(),
      content: "Noted.",
      createdAt: new Date(),
      requiredScopes: [],
      disclosureList: null,
      authorType: "agent",
      authorId: null,
    },
  ]
}

/** An empty agent conversation for the title and memory paths to read. */
async function seedAgentChat(threadId: string, handlePrefix: string): Promise<void> {
  await withSystemDb("seed-meter-thread", (db) =>
    db.insert(threads).values({
      id: threadId,
      orgId: ORG,
      type: "agent_chat",
      createdBy: USER,
      handle: `${handlePrefix}-${threadId.slice(0, 8)}`,
    }),
  )
}

async function withRoleAgent(run: (agentId: string, threadId: string) => Promise<void>) {
  const agentId = crypto.randomUUID()
  const threadId = crypto.randomUUID()
  await withSystemDb("seed-meter-agent", (db) =>
    db.insert(agents).values({
      id: agentId,
      orgId: ORG,
      kind: "role",
      handle: `meter${agentId.slice(0, 8)}`,
      displayName: "Meter",
      scopeCeiling: ["*"],
    }),
  )
  try {
    await run(agentId, threadId)
  } finally {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG} AND agent_id = ${agentId}`
    await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
  }
}

beforeAll(async () => {
  for (const k of ENV_VARS) savedEnv[k] = process.env[k]
  stub = startManagedOpenRouterStub()
  process.env.OPENROUTER_BASE_URL = stub.baseUrl
  process.env.OPENROUTER_API_KEY = CELL_KEY
  delete process.env.LIAISON_OFFLINE_SIDE_CALLS
  await seedManagedOrg({ orgId: ORG, userId: USER })
  const models = JSON.stringify({ added: [ADDED_MODEL], autoModelKey: MODEL_KEY })
  await sql`UPDATE kernel.organizations
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{ai}', jsonb_build_object('models', ${models}::jsonb))
     WHERE id = ${ORG}`
  await setTestCreditPricing()
})

afterAll(async () => {
  stub.stop()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  _setEdition(null)
  await clearTestCreditPricing()
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await cleanupManagedOrg(ORG)
})

beforeEach(async () => {
  stub.requests.length = 0
  clearOrgBillingStatusCache()
  await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG}`
  await setManagedOrgStatus(ORG, "active")
})

afterEach(() => {
  _setEdition(null)
  clearOrgBillingStatusCache()
})

describe("managed edition: side calls debit the org", () => {
  beforeEach(() => _setEdition("managed"))

  test("a consolidation memory flush writes one billed usage row at the reported cost", async () => {
    await withRoleAgent(async (agentId, threadId) => {
      const result = await flushRegion(
        { orgId: ORG, agentId, threadId, closeReason: "checkpoint" },
        region(),
      )
      expect(result.flushed).toBe(true)
      expect(stub.requests.filter((r) => r.path.endsWith("/chat/completions"))).toHaveLength(1)
      expect(stub.requests[0].authorization).toBe(`Bearer ${CELL_KEY}`)
      expectOneBilledRow(await usageRows())
    })
  })

  test("a side call that cannot be metered counts towards the deduction breaker", async () => {
    const credit = await preCheck(ORG, MODEL_KEY)
    expect(credit.allowed).toBe(true)
    if (!credit.allowed) return
    const key = `agent:credit-deduct-fail:${ORG}`
    await redis.del(key)
    // A usage object that cannot be read stands in for any fault inside the meter.
    const unreadable = {
      get inputTokens(): number {
        throw new Error("usage unreadable")
      },
    }
    let failures: string | null = null
    try {
      await meterSideCall(ORG, credit, unreadable)
      failures = await redis.get(key)
    } finally {
      await redis.del(key).catch(() => {})
    }
    expect(failures).toBe("1")
    expect(await usageRows()).toHaveLength(0)
  })

  test("a checkpoint-style side call is metered through meterSideCall", async () => {
    const credit = await preCheck(ORG, MODEL_KEY)
    expect(credit.allowed).toBe(true)
    if (!credit.allowed) return
    const result = await generateText({
      model: await resolveSideCallModel(credit),
      prompt: "Write the brief.",
    })
    expect(result.text).toBe(STUB_ANSWER)
    await meterSideCall(ORG, credit, result.usage, result.providerMetadata)
    expectOneBilledRow(await usageRows())
  })

  test("a call that produced no usage writes no row", async () => {
    const credit = await preCheck(ORG, MODEL_KEY)
    if (!credit.allowed) throw new Error("pre check refused")
    await meterSideCall(ORG, credit, null)
    expect(await usageRows()).toHaveLength(0)
  })

  test("an auto-title is metered", async () => {
    const threadId = crypto.randomUUID()
    await seedAgentChat(threadId, "meter")
    await autoTitleAgentChat({
      threadId,
      orgId: ORG,
      userMessage: "When is the Tuesday pickup?",
      agentReply: "At 16:00.",
    })
    expect(stub.requests).toHaveLength(1)
    expectOneBilledRow(await usageRows())
  })

  test("a web extraction is metered", async () => {
    const out = await runSandboxedExtraction({
      webContent: `Price list ${crypto.randomUUID()}: panel 120 EUR.`,
      extractionQuery: "the panel price",
      orgId: ORG,
    })
    expect(out).toContain(STUB_ANSWER)
    expect(stub.requests).toHaveLength(1)
    expectOneBilledRow(await usageRows())
  })

  test("past due: the auto-title and the extraction send nothing and write nothing", async () => {
    await setManagedOrgStatus(ORG, "past_due")
    clearOrgBillingStatusCache()
    const threadId = crypto.randomUUID()
    await seedAgentChat(threadId, "meter")
    await autoTitleAgentChat({
      threadId,
      orgId: ORG,
      userMessage: "When is the Tuesday pickup?",
      agentReply: "At 16:00.",
    })
    await runSandboxedExtraction({
      webContent: `Price list ${crypto.randomUUID()}: panel 120 EUR.`,
      extractionQuery: "the panel price",
      orgId: ORG,
    })
    expect(stub.requests).toHaveLength(0)
    expect(await usageRows()).toHaveLength(0)
  })
})

/** The model id each chat completion sent upstream. */
function sentModels(): unknown[] {
  return stub.requests
    .filter((r) => r.path.endsWith("/chat/completions"))
    .map((r) => (r.body as { model?: unknown } | null)?.model)
}

for (const edition of ["managed", "self_hosted"] as const) {
  describe(`${edition}: Auto on an OpenRouter key sends the upstream model id`, () => {
    beforeEach(() => _setEdition(edition))

    test("auto-title, web extraction and a memory flush each send the upstream id", async () => {
      const threadId = crypto.randomUUID()
      await seedAgentChat(threadId, "up")
      await autoTitleAgentChat({
        threadId,
        orgId: ORG,
        userMessage: "When is the Tuesday pickup?",
        agentReply: "At 16:00.",
      })
      const [titled] = await sql<{ title: string | null }[]>`
        SELECT title FROM kernel.threads WHERE id = ${threadId}`
      // The model's answer, not the heuristic of the first message.
      expect(titled.title).toBe(STUB_ANSWER)
      await runSandboxedExtraction({
        webContent: `Price list ${crypto.randomUUID()}: panel 120 EUR.`,
        extractionQuery: "the panel price",
        orgId: ORG,
      })
      await withRoleAgent(async (agentId, flushThreadId) => {
        await flushRegion(
          { orgId: ORG, agentId, threadId: flushThreadId, closeReason: "checkpoint" },
          region(),
        )
      })
      expect(sentModels()).toEqual([
        ADDED_MODEL.upstreamId,
        ADDED_MODEL.upstreamId,
        ADDED_MODEL.upstreamId,
      ])
    })
  })
}

describe("self-hosted: no credits, side calls stay unrecorded", () => {
  beforeEach(() => _setEdition("self_hosted"))

  // Self-hosted titles and extractions run exactly as before the meter: on the
  // org's key from resolveKey, with no pre check that could refuse them.
  test("a title and an extraction call the model on the org's key and write nothing", async () => {
    {
      const threadId = crypto.randomUUID()
      await seedAgentChat(threadId, "self")
      await autoTitleAgentChat({
        threadId,
        orgId: ORG,
        userMessage: "When is the Tuesday pickup?",
        agentReply: "At 16:00.",
      })
      const out = await runSandboxedExtraction({
        webContent: `Price list ${crypto.randomUUID()}: panel 120 EUR.`,
        extractionQuery: "the panel price",
        orgId: ORG,
      })
      expect(out).toContain(STUB_ANSWER)
      expect(stub.requests).toHaveLength(2)
      expect(await usageRows()).toHaveLength(0)
    }
  })

  test("a consolidation memory flush writes no usage row", async () => {
    await withRoleAgent(async (agentId, threadId) => {
      const result = await flushRegion(
        { orgId: ORG, agentId, threadId, closeReason: "checkpoint" },
        region(),
      )
      expect(result.flushed).toBe(true)
      expect(stub.requests).toHaveLength(1)
      expect(await usageRows()).toHaveLength(0)
    })
  })
})
