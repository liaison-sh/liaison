// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The rolling cache breakpoints on the WIRE: a multi-step tool loop driven by
// the real AI SDK and its real Anthropic provider (canned SSE at the fetch
// layer, no network), with the same prepareStep the sub-run worker uses and
// the main loop composes (clip, then mark). Asserted on the request bodies:
//   - every step marks its newest message (5m) and no request carries more
//     than Anthropic's 4 breakpoints;
//   - TTLs are ordered (no 1h breakpoint after a 5m one);
//   - the bytes a previous step's breakpoint covered are still the bytes this
//     step sends, clipping included, so each step reads its predecessor's
//     cache and re-sends only a bounded tail.
// Without the marks a step's uncached tail is the whole run (it grows by one
// tool result per step); with an END mark alone, a step that clips an old
// result misses and re-writes the whole run.

import { describe, expect, it } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { isStepCount, jsonSchema, streamText, tool } from "ai"
import {
  clipAndMarkStepMessages,
  markRollingBreakpoints,
  unmarkRollingBreakpoints,
} from "~/modules/agent/runtime/rolling-cache-breakpoints"
import {
  type ClipLedger,
  KEEP_RECENT_TOOL_RESULTS,
  STALE_CLIP_BATCH_CHARS,
} from "~/modules/agent/runtime/stale-result-clipper"

type CacheControl = { type: string; ttl?: string }
type Block = { type: string; cache_control?: CacheControl } & Record<string, unknown>
type Body = {
  system?: Block[]
  tools?: Array<{ cache_control?: CacheControl }>
  messages: Array<{ role: string; content: Block[] }>
}

const ONE_HOUR = { anthropic: { cacheControl: { type: "ephemeral" as const, ttl: "1h" as const } } }

function sse(events: Array<[string, unknown]>): Response {
  return new Response(
    events.map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

/** Step `i` of `toolSteps` calls the tool; the step after them answers. */
function anthropicStep(i: number, toolSteps: number): Response {
  const start: [string, unknown] = [
    "message_start",
    {
      type: "message_start",
      message: {
        id: `msg_${i}`,
        type: "message",
        role: "assistant",
        model: "claude-rolling-test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  ]
  const end = (reason: string): Array<[string, unknown]> => [
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: reason, stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]
  const block =
    i < toolSteps
      ? { type: "tool_use", id: `toolu_${i}`, name: "lookup", input: {} }
      : { type: "text", text: "" }
  const delta =
    i < toolSteps
      ? { type: "input_json_delta", partial_json: JSON.stringify({ n: i }) }
      : { type: "text_delta", text: "Done." }
  return sse([
    start,
    ["content_block_start", { type: "content_block_start", index: 0, content_block: block }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ...end(i < toolSteps ? "tool_use" : "end_turn"),
  ])
}

async function runLoop(toolSteps: number, rollingCache: boolean): Promise<Body[]> {
  const bodies: Body[] = []
  const anthropic = createAnthropic({
    apiKey: "sk-test",
    fetch: (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Body)
      return anthropicStep(bodies.length - 1, toolSteps)
    }) as never,
  })
  const ledger: ClipLedger = new Map()
  const result = streamText({
    model: anthropic("claude-rolling-test"),
    system: [{ role: "system", content: "Stable system prompt.", providerOptions: ONE_HOUR }],
    messages: [
      { role: "user", content: "Look the records up.", providerOptions: ONE_HOUR },
      { role: "user", content: "<runtime-context>today</runtime-context>" },
    ],
    tools: {
      lookup: tool({
        description: "Look a record up.",
        inputSchema: jsonSchema<{ n: number }>({
          type: "object",
          properties: { n: { type: "number" } },
          required: ["n"],
        }),
        // Large enough that the clipper cuts it once it leaves the keep window.
        execute: async ({ n }) => ({ record: n, body: `${n}:`.padEnd(30_000, "x") }),
      }),
    },
    maxOutputTokens: 1000,
    stopWhen: isStepCount(toolSteps + 1),
    prepareStep: ({ messages }) => {
      const list = clipAndMarkStepMessages(messages, ledger, rollingCache)
      return list !== messages ? { messages: list as typeof messages } : {}
    },
  })
  await result.consumeStream()
  return bodies
}

/** Every block of the request in render order, cache_control stripped. */
function blocks(body: Body): string[] {
  return body.messages.flatMap((m) =>
    m.content.map((b) => {
      const { cache_control: _cc, ...rest } = b
      return JSON.stringify([m.role, rest])
    }),
  )
}

/** Positions (block counts) of the message-level marks, with their TTL. */
function marks(body: Body): Array<{ pos: number; ttl: string | undefined }> {
  const out: Array<{ pos: number; ttl: string | undefined }> = []
  let pos = 0
  for (const m of body.messages) {
    for (const b of m.content) {
      pos++
      if (b.cache_control) out.push({ pos, ttl: b.cache_control.ttl })
    }
  }
  return out
}

function allTtls(body: Body): Array<string | undefined> {
  return [
    ...(body.tools ?? []).flatMap((t) => (t.cache_control ? [t.cache_control.ttl] : [])),
    ...(body.system ?? []).flatMap((b) => (b.cache_control ? [b.cache_control.ttl] : [])),
    ...marks(body).map((m) => m.ttl),
  ]
}

/** How many blocks of `body` sit after the furthest cache entry an earlier
 *  request wrote that this one can read (prefix-equal, within 20 positions of
 *  one of this request's breakpoints): what the step pays without a read. */
function uncachedTail(bodies: Body[], k: number): number {
  const cur = blocks(bodies[k] as Body)
  const bps = marks(bodies[k] as Body).map((m) => m.pos)
  let hit = 0
  for (let j = 0; j < k; j++) {
    const prev = blocks(bodies[j] as Body)
    for (const { pos } of marks(bodies[j] as Body)) {
      const samePrefix = prev.slice(0, pos).every((b, i) => cur[i] === b)
      const reachable = bps.some((bp) => bp >= pos && bp - pos <= 20)
      if (samePrefix && reachable && pos > hit) hit = pos
    }
  }
  return cur.length - hit
}

describe("rolling cache breakpoints on an Anthropic tool loop", () => {
  it("marks the newest message every step, within 4 breakpoints and TTL order", async () => {
    const bodies = await runLoop(2, true) // a 3-step loop: tool, tool, answer
    expect(bodies).toHaveLength(3)
    for (const body of bodies) {
      const last = body.messages[body.messages.length - 1] as Body["messages"][number]
      const lastBlock = last.content[last.content.length - 1] as Block
      expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
      const ttls = allTtls(body)
      expect(ttls.length).toBeLessThanOrEqual(4)
      // Longer TTLs first: once a 5m breakpoint appears, no 1h follows.
      const first5m = ttls.indexOf("5m")
      expect(ttls.slice(first5m).every((t) => t === "5m")).toBe(true)
      expect(ttls.filter((t) => t === "1h")).toHaveLength(2) // system + transcript, untouched
    }
    // The step's marks are not carried into the next one.
    expect(marks(bodies[2] as Body).filter((m) => m.ttl === "5m").length).toBeLessThanOrEqual(2)
    // Each step after the first reads everything the previous step sent.
    for (const k of [1, 2]) expect(uncachedTail(bodies, k)).toBe(2) // the new tool_use + result
  })

  it("keeps the cached prefix byte-stable across steps while the clipper rewrites old results", async () => {
    const steps = 9
    const bodies = await runLoop(steps, true)
    expect(bodies).toHaveLength(steps + 1)
    for (let k = 1; k < bodies.length; k++) {
      const body = bodies[k] as Body
      expect(allTtls(body).length).toBeLessThanOrEqual(4)
      // The earlier of the previous request's 5m marks (PRE once clipping is
      // possible, else END) covers bytes this request sends unchanged.
      const prev = blocks(bodies[k - 1] as Body)
      const cur = blocks(body)
      const prevMarks = marks(bodies[k - 1] as Body).filter((m) => m.ttl === "5m")
      const earliest = Math.min(...prevMarks.map((m) => m.pos))
      expect(cur.slice(0, earliest)).toEqual(prev.slice(0, earliest))
      // So the step re-sends a bounded tail (a batch of clipped results and
      // the keep window), never the whole run.
      expect(uncachedTail(bodies, k)).toBeLessThanOrEqual(
        2 * (KEEP_RECENT_TOOL_RESULTS + 1 + Math.ceil(STALE_CLIP_BATCH_CHARS / 30_000)),
      )
    }
    // And only a batch step re-sends more than its own new call and result:
    // the clipper rewrites in batches, not one result per step.
    const rereads = bodies.slice(1).filter((_, i) => uncachedTail(bodies, i + 1) > 2)
    expect(rereads.length).toBeLessThanOrEqual(1)
    // The clipper did rewrite results that an END-only mark had covered.
    const firstResult = (b: Body) => blocks(b).find((s) => s.includes('"tool_result"')) ?? ""
    expect(firstResult(bodies[steps] as Body)).not.toEqual(firstResult(bodies[1] as Body))
  })

  it("leaves non-Anthropic requests unmarked", async () => {
    const bodies = await runLoop(2, false)
    for (const body of bodies) {
      expect(marks(body).every((m) => m.ttl === "1h")).toBe(true)
    }
    // And without the marks every step re-sends the run's whole tail.
    expect(uncachedTail(bodies, 2)).toBe(blocks(bodies[2] as Body).length - 1)
  })

  it("never places a 5m mark at or before an existing (1h) mark, nor on a thinking block", () => {
    const toolMsg = (id: string) => ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "t",
          output: { type: "text", value: "v" },
        },
      ],
    })
    const call = (id: string) => ({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "t", input: {} }],
    })
    // A replayed tool result in the persisted history, BEFORE the 1h transcript
    // mark: its PRE position would put a 5m entry ahead of the 1h one.
    const history = [
      { role: "user", content: "q" },
      call("h1"),
      toolMsg("h1"),
      { role: "user", content: "now", providerOptions: ONE_HOUR },
    ]
    const out = markRollingBreakpoints(history, 1) as typeof history
    expect(out).toBe(history) // the newest message already carries the 1h mark
    const withTail = [...history, { role: "user", content: "<runtime-context/>" }]
    const marked = markRollingBreakpoints(withTail, 2) as Array<{ providerOptions?: unknown }>
    expect(marked.map((m) => m.providerOptions ?? null)).toEqual([
      null,
      null,
      null,
      ONE_HOUR,
      { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } },
    ])
    // Marks are dropped again before the next step.
    expect(unmarkRollingBreakpoints(marked)).toEqual(withTail)
    // A message whose last part is a thinking block is not marked.
    const thinking = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "reasoning", text: "..." }] },
    ]
    expect(markRollingBreakpoints(thinking, null)).toBe(thinking)
  })
})
