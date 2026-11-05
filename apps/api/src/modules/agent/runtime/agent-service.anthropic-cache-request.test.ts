// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT REACHES ANTHROPIC, AND WHAT COMES BACK INTO USAGE.
//
// Prompt caching is money: the stable prefix (tools + system) and the moving
// transcript breakpoint are what keep a long agent run at cache-read prices.
// Both are expressed as AI SDK provider options (context.ts), and the SDK and
// its Anthropic provider turn them into `cache_control` on the wire. An SDK
// upgrade can move, drop or duplicate them with every unit test still green,
// because those tests mock the model, not the HTTP body.
//
// So this test runs two real agent turns (two tool calls, then the answer;
// then a follow-up turn) through invokeAgentForThread with the real Anthropic
// provider, answers from canned SSE at the fetch layer, and asserts the
// request bodies: exactly one system breakpoint (the last stable block), one
// 1h transcript breakpoint (the newest persisted user text, before the
// runtime-context tail), a 5m rolling breakpoint on the newest block of every
// step (rolling-cache-breakpoints.ts), at most 4 breakpoints, 1h before 5m, no
// top-level `cache_control`, and a tool list that only ever grows at the end
// (a stable prefix). It then checks that the provider's cache read and write
// counts land in the persisted usage, that the 5m part of the writes is billed
// at 1.25x and the rest at 2x, and the cache_hit_ratio line. The assembly
// layout is the one AI SDK 6 sent (captured 2026-09-30 before the AI SDK 7
// upgrade, byte-identical after it).
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import { creditMeterLogger } from "~/modules/agent/credits/credit-meter"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-00000000cc01"
const USER_ID = "00000000-0000-0000-0000-00000000cc02"
const THREAD_ID = "00000000-0000-0000-0000-00000000cc03"
const MODEL_ID = "claude-cache-shape-test"
const TOOL_INPUT = { query: "select:kernel__list_skills" }

type Body = {
  cache_control?: unknown
  system: Array<{ type: string; text: string; cache_control?: { type: string; ttl?: string } }>
  messages: Array<{
    role: string
    content: Array<{ type: string; text?: string; cache_control?: { type: string; ttl?: string } }>
  }>
  tools: Array<{ name: string; cache_control?: unknown }>
}

// Per step: [input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
// output_tokens, the 5m part of cache_creation]
const STEP_USAGE: Array<[number, number, number, number, number]> = [
  [50, 100, 800, 20, 40],
  [60, 110, 900, 30, 70],
  [70, 120, 1000, 40, 90],
]
const TOOL_STEPS = 2

function sse(events: Array<[string, unknown]>): Response {
  return new Response(
    events.map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

function anthropicStep(step: number): Response {
  const [input, write, read, output, write5m] = STEP_USAGE[step] as [
    number,
    number,
    number,
    number,
    number,
  ]
  const start: [string, unknown] = [
    "message_start",
    {
      type: "message_start",
      message: {
        id: `msg_${step}`,
        type: "message",
        role: "assistant",
        model: MODEL_ID,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: input,
          cache_creation_input_tokens: write,
          cache_read_input_tokens: read,
          cache_creation: {
            ephemeral_5m_input_tokens: write5m,
            ephemeral_1h_input_tokens: write - write5m,
          },
          output_tokens: 1,
        },
      },
    },
  ]
  const end = (reason: string): Array<[string, unknown]> => [
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: reason, stop_sequence: null },
        usage: { output_tokens: output },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]
  if (step < TOOL_STEPS) {
    return sse([
      start,
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: `toolu_shape_${++toolUseCounter}`,
            name: "kernel__tool_search",
            input: {},
          },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(TOOL_INPUT) },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ...end("tool_use"),
    ])
  }
  return sse([
    start,
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ...end("end_turn"),
  ])
}

let toolUseCounter = 0
const bodies: Body[][] = []
let turnBodies: Body[] = []
const realFetch = globalThis.fetch
const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

function breakpoints(body: Body) {
  const system = body.system.flatMap((b, i) =>
    b.cache_control ? [{ i, cc: b.cache_control }] : [],
  )
  const messages = body.messages.flatMap((m, i) =>
    m.content.flatMap((p, j) => (p.cache_control ? [{ i, j, part: p, cc: p.cache_control }] : [])),
  )
  const tools = body.tools.filter((t) => t.cache_control)
  return { system, messages, tools }
}

describe("the Anthropic request an agent turn sends (prompt-cache layout)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'CacheShapeOrg', 'cache-shape-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'cache-shape@test.com', 'Cache Shape')`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '0', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Cache shape test', '1.00', '5.00', 200000, false, 'starter') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, agent_model_id)
      VALUES (${THREAD_ID}, ${ORG_ID}, 'cache-shape', 'agent_chat', ${USER_ID}, ${MODEL_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!url.includes("api.anthropic.com")) return realFetch(input as never, init)
      const step = turnBodies.length
      turnBodies.push(JSON.parse(String(init?.body)) as Body)
      return anthropicStep(step)
    }) as typeof fetch
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${THREAD_ID}`
    await sql`DELETE FROM kernel.threads WHERE id = ${THREAD_ID}`
    await sql`DELETE FROM kernel.users WHERE id = ${USER_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("places the assembly and rolling breakpoints and bills the cache counts by TTL", async () => {
    const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
    const infoSpy = spyOn(creditMeterLogger, "info")
    const usages: Array<Record<string, number>> = []
    try {
      for (const [turn, text] of [
        "Which skills do I have? Look them up.",
        "Thanks. Anything else?",
      ].entries()) {
        turnBodies = []
        const msgId = `00000000-0000-0000-0000-00000000cc1${turn}`
        await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
          VALUES (${msgId}, ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'user', ${text}, '{}')`
        const result = await invokeAgentForThread(
          THREAD_ID,
          msgId,
          { userId: USER_ID, orgId: ORG_ID, scopes: ["*"], dimensionGrants: {} },
          ORG_ID,
        )
        expect(result.finishReason).not.toBe("error")
        bodies.push(turnBodies)
        const [row] = await sql`SELECT metadata FROM kernel.messages
          WHERE thread_id = ${THREAD_ID} AND author_type = 'agent' ORDER BY created_at DESC LIMIT 1`
        expect(row).toBeDefined()
        usages.push((row as { metadata: { usage: Record<string, number> } }).metadata.usage)
      }

      for (const [turn, steps] of bodies.entries()) {
        expect(steps).toHaveLength(TOOL_STEPS + 1) // two tool calls, then the answer
        for (const [k, body] of steps.entries()) {
          expect(body.cache_control).toBeUndefined()
          const bp = breakpoints(body)
          // The stable prefix: exactly one system breakpoint, on the last
          // stable block (the volatile block after it is never cached).
          expect(bp.system).toHaveLength(1)
          expect(bp.system[0]?.i).toBe(body.system.length - 2)
          expect(bp.system[0]?.cc).toEqual({ type: "ephemeral", ttl: "1h" })
          // The transcript breakpoint: exactly one 1h mark, on the newest
          // persisted user text (on the first step, right before the
          // runtime-context tail).
          const transcript = bp.messages.filter((b) => b.cc.ttl === "1h")
          expect(transcript).toHaveLength(1)
          const mark = transcript[0] as NonNullable<(typeof transcript)[0]>
          expect(mark.part.type).toBe("text")
          expect(mark.part.text).toBe(
            turn === 0 ? "Which skills do I have? Look them up." : "Thanks. Anything else?",
          )
          const lastMsg = body.messages[body.messages.length - 1] as Body["messages"][number]
          const lastPart = lastMsg.content[lastMsg.content.length - 1]
          if (k === 0) {
            const next = body.messages[mark.i]?.content[mark.j + 1]
            expect(next?.text?.startsWith("<runtime-context")).toBe(true)
            // The rolling breakpoint: the newest block of the step, 5m.
            expect(lastPart?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
          } else {
            // The runtime tail rides last, after the steps (it is never
            // replayed), and outside the cache: the rolling breakpoint is the
            // newest block of the step, the one right before it, 5m.
            expect(lastPart?.text?.startsWith("<runtime-context")).toBe(true)
            expect(lastPart?.cache_control).toBeUndefined()
            const blocks = body.messages.flatMap((m) => m.content)
            expect(blocks[blocks.length - 2]?.cache_control).toEqual({
              type: "ephemeral",
              ttl: "5m",
            })
          }
          // Within Anthropic's 4, and every 5m mark after the 1h ones.
          const ordered = [...bp.system, ...bp.messages].map((b) => b.cc.ttl)
          expect(ordered.length).toBeLessThanOrEqual(4)
          expect(ordered.slice(ordered.indexOf("5m")).every((t) => t === "5m")).toBe(true)
          for (const b of bp.messages.filter((m) => m.cc.ttl === "5m")) {
            expect(b.i > mark.i || (b.i === mark.i && b.j > mark.j)).toBe(true)
          }
          expect(bp.tools).toHaveLength(0)
          for (const b of [...bp.system, ...bp.messages]) expect(b.cc.type).toBe("ephemeral")
        }
        // The tool list is deterministic, the turn's starting tools sorted by
        // name, and fixed for the thread: a discovery does not join it (the
        // loaded tool is called through kernel__call_tool or held for a direct
        // call), so nothing in it moves.
        const names = steps.map((b) => b.tools.map((t) => t.name))
        const [first, second, third] = names as [string[], string[], string[]]
        expect(first).toEqual([...first].sort())
        expect(first).toContain("kernel__call_tool")
        expect(first).not.toContain("kernel__list_skills")
        expect(second).toEqual(first)
        expect(third).toEqual(first)
      }

      // Usage: input counts cache reads and writes too; the cache read total
      // and the cache write total come from the provider's own fields.
      const sum = (k: 0 | 1 | 2 | 3 | 4) => STEP_USAGE.reduce((n, s) => n + s[k], 0)
      for (const usage of usages) {
        expect(usage.inputTokens).toBe(sum(0) + sum(1) + sum(2))
        expect(usage.cachedInputTokens).toBe(sum(2))
        expect(usage.outputTokens).toBe(sum(3))
      }
      // Billing: the plain input at the model rate (1.00/M), reads at 0.1x,
      // the 5m part of the writes at 1.25x and the rest at the 1h premium
      // (2x), output at 5.00/M. Before the 5m split every write was billed
      // at 2x; before that, reads at 1.1x and writes at 1x.
      const [credit] = await sql`SELECT raw_cost::text AS raw_cost FROM kernel.credit_transactions
        WHERE org_id = ${ORG_ID} ORDER BY created_at LIMIT 1`
      const expected =
        (sum(0) + sum(2) * 0.1 + sum(4) * 1.25 + (sum(1) - sum(4)) * 2 + sum(3) * 5) / 1_000_000
      expect(Number((credit as { raw_cost: string }).raw_cost)).toBeCloseTo(expected, 8)
      const ratioLines = infoSpy.mock.calls.filter((c) => c[1] === "cache_hit_ratio")
      expect(ratioLines).toHaveLength(2)
      for (const line of ratioLines) {
        expect((line[0] as { cacheWriteTokens?: number }).cacheWriteTokens).toBe(sum(1))
        expect((line[0] as { cacheWrite5mTokens?: number }).cacheWrite5mTokens).toBe(sum(4))
      }
    } finally {
      infoSpy.mockRestore()
    }
  }, 60_000)
})
