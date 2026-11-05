// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The request a sub-run sends to Anthropic carries the main loop's prompt-cache
// layout: one breakpoint on the stable system block (role prompt, skills,
// deferred catalog), none on the per-run input block, one on the dispatch
// prompt. Before, the system went out as one plain string with no breakpoint,
// so every step of every sub-run re-billed its whole prefix at the input rate.
// Real Anthropic provider, canned SSE at the fetch layer (no paid call).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { creditBalances, threads as kernelThreads, modelPricing } from "~/db/schema/kernel"
import { spawnAgent } from "~/modules/agent/subruns/spawn-agent"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import { awaitSubRunResult } from "~/modules/agent/subruns/subrun-await"
import { startSubrunWorker } from "~/modules/agent/subruns/subrun-worker"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Part = { type: string; text?: string; cache_control?: { type: string; ttl?: string } }
type Body = {
  cache_control?: unknown
  system: Part[]
  messages: Array<{ role: string; content: Part[] }>
}

const MODEL_ID = `claude-subrun-cache-${crypto.randomUUID().slice(0, 6)}`
const PAYLOAD = { draft: "d", confidence: 1 }
const ORIG_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const realFetch = globalThis.fetch
const bodies: Body[] = []

function finalizeResponse(): Response {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_sub",
          type: "message",
          role: "assistant",
          model: MODEL_ID,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
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
        content_block: { type: "tool_use", id: "toolu_fin", name: "finalize", input: {} },
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
        usage: { output_tokens: 5 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]
  return new Response(
    events.map(([ev, d]) => `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

describe("the Anthropic request a sub-run sends (prompt-cache layout)", () => {
  let orgId: string
  let userId: string

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-subrun-cache"
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
    await withSystemDb("subrun-cache-seed", async (db) => {
      await db
        .insert(modelPricing)
        .values({
          provider: "anthropic",
          modelId: MODEL_ID,
          displayName: "Subrun cache test",
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
      bodies.push(JSON.parse(String(init?.body)) as Body)
      return finalizeResponse()
    }) as typeof fetch
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await withSystemDb("subrun-cache-cleanup", async (db) => {
      const { eq } = await import("drizzle-orm")
      await db.delete(modelPricing).where(eq(modelPricing.modelId, MODEL_ID))
    })
    await releaseTestLock()
  })

  it("marks the stable system block and the dispatch prompt, not the per-run input", async () => {
    const agentType = `cache-${crypto.randomUUID().slice(0, 6)}`
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
    const [thread] = await withPrivilegedDb(orgId, "subrun-cache-thread", async (tx) =>
      tx
        .insert(kernelThreads)
        .values({
          orgId,
          handle: `sc-${crypto.randomUUID().slice(0, 8)}`,
          type: "thread",
          createdBy: userId,
        })
        .returning({ id: kernelThreads.id }),
    )
    const actor: UserContext = { actorType: "user", userId, orgId, scopes: [], dimensionGrants: {} }
    const handle = await spawnAgent({
      parentRun: { id: null, threadId: thread!.id, actor, nestingDepth: 0 },
      subagentType: agentType,
      description: "cache layout",
      prompt: "Investigate ticket T-1.",
      input: { ticketId: "T-1" },
      outputSchema: {
        type: "object",
        required: ["draft", "confidence"],
        properties: { draft: { type: "string" }, confidence: { type: "number" } },
      },
    })
    const result = await awaitSubRunResult(handle.runId, orgId, { timeoutMs: 15_000 })
    expect(result.ok).toBe(true)
    expect(bodies.length).toBeGreaterThanOrEqual(1)
    const body = bodies[0] as Body
    expect(body.cache_control).toBeUndefined()
    expect(body.system).toHaveLength(2)
    expect(body.system[0]?.text).toContain("You investigate one ticket and report.")
    expect(body.system[0]?.cache_control?.type).toBe("ephemeral")
    expect(body.system[1]?.text).toContain('"ticketId": "T-1"')
    expect(body.system[1]?.cache_control).toBeUndefined()
    const marks = body.messages.flatMap((m) => m.content.filter((p) => p.cache_control))
    expect(marks).toHaveLength(1)
    expect(marks[0]?.text).toBe("Investigate ticket T-1.")
    expect(marks[0]?.cache_control?.ttl).toBe(body.system[0]?.cache_control?.ttl)
  }, 30_000)
})
