// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S17 / A34: a spawn_agent sub-run started inside a routine run counts toward
// the routine's hard token limit. The sub-run is a job-queue run (possibly in
// another worker), so the count crosses through the job payload and the
// shared counter: its steps add to the parent's account, and a sub-run still
// queued when the limit is already spent never makes a model call.
//
// The real worker and the real Anthropic provider, answered from canned SSE at
// the fetch layer. Each sub-run step costs 300 tokens (100 input + 150 cache
// read + 50 output).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { creditBalances, threads as kernelThreads, modelPricing } from "~/db/schema/kernel"
import {
  addSharedTokens,
  type RunTokenAccount,
  refreshTokenAccount,
  sharedTokensUsed,
} from "~/modules/agent/runtime/run-token-limit"
import { spawnAgent } from "~/modules/agent/subruns/spawn-agent"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import { awaitSubRunResult } from "~/modules/agent/subruns/subrun-await"
import { startSubrunWorker } from "~/modules/agent/subruns/subrun-worker"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MODEL_ID = `claude-subrun-limit-${crypto.randomUUID().slice(0, 6)}`
const PAYLOAD = { draft: "d", confidence: 1 }
const ORIG_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const realFetch = globalThis.fetch
let modelCalls = 0

function finalizeResponse(): Response {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: `msg_sub_${modelCalls}`,
          type: "message",
          role: "assistant",
          model: MODEL_ID,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 150,
            output_tokens: 1,
          },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: `toolu_fin_${modelCalls}`,
          name: "finalize",
          input: {},
        },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(PAYLOAD) },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 50 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]
  return new Response(
    events.map(([ev, d]) => `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

describe("spawn_agent sub-runs and the routine's hard token limit (S17, A34)", () => {
  let orgId: string
  let userId: string
  let threadId: string
  let agentType: string
  let actor: UserContext

  async function spawnUnder(account: RunTokenAccount) {
    const handle = await spawnAgent({
      parentRun: { id: null, threadId, actor, nestingDepth: 0 },
      // The routine turn's frame, as the tool bridge captures it for spawn_agent.
      parentFrame: {
        taintScopes: [],
        tokenLimit: { accountId: account.id, hardTokenLimit: account.hardTokenLimit ?? 0 },
      },
      subagentType: agentType,
      description: "limit",
      prompt: "Investigate ticket T-1.",
      input: { ticketId: "T-1" },
      outputSchema: {
        type: "object",
        required: ["draft", "confidence"],
        properties: { draft: { type: "string" }, confidence: { type: "number" } },
      },
    })
    return awaitSubRunResult(handle.runId, orgId, { timeoutMs: 15_000, continueOnError: true })
  }

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-subrun-limit"
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
    actor = { actorType: "user", userId, orgId, scopes: [], dimensionGrants: {} }
    await withSystemDb("subrun-limit-seed", async (db) => {
      await db
        .insert(modelPricing)
        .values({
          provider: "anthropic",
          modelId: MODEL_ID,
          displayName: "Subrun limit test",
          inputCostPerM: "0.0000001",
          outputCostPerM: "0.0000001",
          contextWindow: 200000,
          autoEligible: true,
          tierMinimum: "starter",
        })
        .onConflictDoNothing()
      await db
        .insert(creditBalances)
        .values({ orgId, includedBalance: "10.00000000", purchasedBalance: "0", currency: "EUR" })
        .onConflictDoNothing()
    })
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!url.includes("api.anthropic.com")) return realFetch(input as never, init)
      modelCalls++
      return finalizeResponse()
    }) as typeof fetch
    agentType = `limit-${crypto.randomUUID().slice(0, 6)}`
    await createSubAgentDefinition({
      orgId,
      agentType,
      whenToUse: "test",
      scopeCeiling: [],
      creatorScopes: [],
      systemPrompt: "You investigate one ticket and report.",
      toolAllowlist: ["kernel:finalize"],
    })
    await startSubrunWorker()
    const [thread] = await withPrivilegedDb(orgId, "subrun-limit-thread", async (tx) =>
      tx
        .insert(kernelThreads)
        .values({
          orgId,
          handle: `sl-${crypto.randomUUID().slice(0, 8)}`,
          type: "thread",
          createdBy: userId,
        })
        .returning({ id: kernelThreads.id }),
    )
    threadId = thread!.id
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await withSystemDb("subrun-limit-cleanup", async (db) => {
      const { eq } = await import("drizzle-orm")
      await db.delete(modelPricing).where(eq(modelPricing.modelId, MODEL_ID))
    })
    await releaseTestLock()
  })

  it("a sub-run's tokens land in the parent run's account", async () => {
    const account: RunTokenAccount = {
      id: crypto.randomUUID(),
      tokenBudget: null,
      hardTokenLimit: 10_000,
      used: 0,
    }
    modelCalls = 0
    const result = await spawnUnder(account)
    expect(result.ok).toBe(true)
    // The finalize step (300) is counted. Without a limit reached the loop
    // also opens a next request, which the finalize abort cuts before any
    // usage comes back, so it adds nothing.
    expect(modelCalls).toBeGreaterThanOrEqual(1)
    expect(await sharedTokensUsed(account.id)).toBe(300)
    // The parent sees it the next time it reads its account.
    await refreshTokenAccount(account)
    expect(account.used).toBe(300)
  }, 30_000)

  it("a sub-run still queued once the limit is spent makes no model call", async () => {
    const account: RunTokenAccount = {
      id: crypto.randomUUID(),
      tokenBudget: null,
      hardTokenLimit: 500,
      used: 0,
    }
    await addSharedTokens(account.id, 600)
    modelCalls = 0
    const result = await spawnUnder(account)
    expect(modelCalls).toBe(0)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("hard_token_limit")
    expect(result.error?.message).toBe("Stopped at the hard limit of 500 tokens.")
  }, 30_000)

  it("a sub-run that crosses the limit mid-run stops before its next model call", async () => {
    const account: RunTokenAccount = {
      id: crypto.randomUUID(),
      tokenBudget: null,
      hardTokenLimit: 500,
      used: 0,
    }
    // 400 already spent by the parent: the sub-run's first step (300) crosses 500.
    await addSharedTokens(account.id, 400)
    modelCalls = 0
    const result = await spawnUnder(account)
    // The limit stops the loop before it opens another request.
    expect(modelCalls).toBe(1)
    expect(await sharedTokensUsed(account.id)).toBe(700)
    // Its first step already finalized, so its result stands; the parent is
    // the one that stops next (its turn checks the account before a call).
    expect(result.ok).toBe(true)
  }, 30_000)
})
