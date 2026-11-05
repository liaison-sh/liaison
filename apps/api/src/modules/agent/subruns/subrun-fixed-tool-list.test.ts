// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A SUB-RUN'S TOOL LIST IS FIXED FOR THE RUN.
//
// A discovering sub-run (no tool allowlist) used to grow the tool list the
// provider saw each time tool_search loaded a tool, so every step after a load
// re-read the whole request. Now every step sends the tools the run started
// with, byte for byte, and the same system prompt; a tool loaded mid-run gets
// its description and parameters in a note right after the step that loaded
// it (kept in place on later steps), and is called through kernel__call_tool,
// which runs the tool itself. Real Anthropic provider, canned SSE at the fetch
// layer (no paid call).
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

type Part = {
  type: string
  text?: string
  name?: string
  input?: unknown
  content?: unknown
  tool_use_id?: string
  cache_control?: unknown
}
type Body = {
  system: Part[]
  tools?: Array<{ name: string }>
  messages: Array<{ role: string; content: Part[] }>
}

const MODEL_ID = `claude-subrun-fixed-${crypto.randomUUID().slice(0, 6)}`
const PAYLOAD = { draft: "d", confidence: 1 }
const SCOPES = ["kernel:threads:read", "kernel:skills:read"]
const CALLS: Array<{ name: string; input: unknown }> = [
  { name: "kernel__tool_search", input: { query: "select:kernel__list_skills" } },
  { name: "kernel__call_tool", input: { name: "kernel__list_skills", arguments: {} } },
  { name: "finalize", input: PAYLOAD },
]
const ORIG_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const realFetch = globalThis.fetch
const bodies: Body[] = []

function toolUseResponse(step: number): Response {
  const call = CALLS[step] ?? CALLS[CALLS.length - 1]
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: `msg_fixed_${step}`,
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
        content_block: { type: "tool_use", id: `toolu_fixed_${step}`, name: call?.name, input: {} },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call?.input) },
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

/** The request with its cache marks dropped: they roll forward by design (rolling-cache-breakpoints.ts). */
function unmarked(value: unknown): string {
  return JSON.stringify(value, (key, v) => (key === "cache_control" ? undefined : v))
}

describe("the tool list a discovering sub-run sends (fixed for the run)", () => {
  let orgId: string
  let userId: string

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-subrun-fixed"
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
    for (const scope of SCOPES) await minimal.grantScope(userId, scope)
    await withSystemDb("subrun-fixed-seed", async (db) => {
      await db
        .insert(modelPricing)
        .values({
          provider: "anthropic",
          modelId: MODEL_ID,
          displayName: "Subrun fixed list test",
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
      const step = bodies.length
      bodies.push(JSON.parse(String(init?.body)) as Body)
      return toolUseResponse(step)
    }) as typeof fetch
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await withSystemDb("subrun-fixed-cleanup", async (db) => {
      const { eq } = await import("drizzle-orm")
      await db.delete(modelPricing).where(eq(modelPricing.modelId, MODEL_ID))
    })
    await releaseTestLock()
  })

  it("sends one tool list and one system prompt on every step, and calls a loaded tool through the entry", async () => {
    const agentType = `fixed-${crypto.randomUUID().slice(0, 6)}`
    await createSubAgentDefinition({
      orgId,
      agentType,
      whenToUse: "test",
      scopeCeiling: SCOPES,
      creatorScopes: SCOPES,
      systemPrompt: "You look up the skills and report.",
    })
    await startSubrunWorker()
    const [thread] = await withPrivilegedDb(orgId, "subrun-fixed-thread", async (tx) =>
      tx
        .insert(kernelThreads)
        .values({
          orgId,
          handle: `sf-${crypto.randomUUID().slice(0, 8)}`,
          type: "thread",
          createdBy: userId,
        })
        .returning({ id: kernelThreads.id }),
    )
    const actor: UserContext = {
      actorType: "user",
      userId,
      orgId,
      scopes: SCOPES,
      dimensionGrants: {},
    }
    const handle = await spawnAgent({
      parentRun: { id: null, threadId: thread!.id, actor, nestingDepth: 0 },
      subagentType: agentType,
      description: "fixed tool list",
      prompt: "Which skills are there?",
      input: {},
      outputSchema: {
        type: "object",
        required: ["draft", "confidence"],
        properties: { draft: { type: "string" }, confidence: { type: "number" } },
      },
    })
    const result = await awaitSubRunResult(handle.runId, orgId, { timeoutMs: 20_000 })
    expect(result.ok).toBe(true)
    // The finalize step may be followed by one more request before the run's
    // abort lands (the stub answers it with finalize again).
    expect(bodies.length).toBeGreaterThanOrEqual(CALLS.length)
    const first = bodies[0] as Body
    const names = (first.tools ?? []).map((t) => t.name)
    expect(names).toContain("kernel__call_tool")
    expect(names).toContain("kernel__tool_search")
    expect(names).not.toContain("kernel__list_skills")
    // Every step: the same tools and system prompt, byte for byte.
    for (const body of bodies) {
      expect(JSON.stringify(body.tools)).toBe(JSON.stringify(first.tools))
      expect(JSON.stringify(body.system)).toBe(JSON.stringify(first.system))
    }
    // Append-only: each step's messages start with the previous step's.
    for (let k = 1; k < bodies.length; k++) {
      const prev = (bodies[k - 1] as Body).messages
      const next = (bodies[k] as Body).messages
      expect(unmarked(next.slice(0, prev.length))).toBe(unmarked(prev))
    }
    // The loaded tool's schema came once, right after the results of the step that loaded it.
    const isNote = (p: Part) =>
      typeof p.text === "string" && p.text.startsWith('<runtime-context note="app guides')
    const last = (bodies[CALLS.length - 1] as Body).messages
    const noteAt = last.findIndex((m) => m.role === "user" && m.content.some(isNote))
    expect(noteAt).toBeGreaterThan(0)
    expect(last.filter((m) => m.role === "user" && m.content.some(isNote))).toHaveLength(1)
    const noteText = last[noteAt]?.content.find(isNote)?.text ?? ""
    expect(noteText).toContain('"name":"kernel__list_skills"')
    expect(noteText).toContain("kernel__call_tool")
    // The note shares its user message with the tool_search result it follows.
    expect(last[noteAt]?.content[0]?.type).toBe("tool_result")
    // The call through the entry ran list_skills itself: its result is the tool's.
    const callResult = last
      .flatMap((m) => m.content)
      .find((p) => p.type === "tool_result" && p.tool_use_id === "toolu_fixed_1")
    expect(callResult).toBeDefined()
    expect(JSON.stringify(callResult?.content)).not.toContain("did not run")
    expect(JSON.stringify(callResult?.content)).not.toContain("not needed here")
  }, 40_000)
})
