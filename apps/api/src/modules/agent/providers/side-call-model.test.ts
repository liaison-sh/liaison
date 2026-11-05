// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Side calls (here the proofreader, through defaultProofreadDeps.complete) get
// the per-step output limit preCheck returns, and their usage reaches the meter
// with the cache split. Before, each side call resolved a bare model: the
// reserved demo org's step cap never applied to them, and cache reads/writes
// were dropped from what they billed. Mocked provider (fetch), no paid call.
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as creditMeter from "~/modules/agent/credits/credit-meter"
import { defaultProofreadDeps } from "~/modules/assist/proofread-service"

const realFetch = globalThis.fetch

function precheckWith(stepTokenCap?: { maxOutputTokens: number }) {
  return spyOn(creditMeter, "preCheck").mockResolvedValue({
    allowed: true,
    model: {
      provider: "anthropic",
      modelId: "claude-side-call-test",
      inputCostPerM: "1",
      outputCostPerM: "1",
      contextWindow: 200000,
      ...(stepTokenCap ? { stepTokenCap } : {}),
    },
    providerKey: "sk-side-call",
    keySource: "byok",
  } as never)
}

// generateText is not streamed: the Messages API answers one JSON message.
function anthropicText(usage: Record<string, number>): Response {
  return new Response(
    JSON.stringify({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-side-call-test",
      content: [{ type: "text", text: "Fixed." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { ...usage, output_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("side calls go through the wrapped model factory", () => {
  it("applies the step output limit preCheck returned", async () => {
    const pre = precheckWith({ maxOutputTokens: 7 })
    const fin = spyOn(creditMeter, "finalizeUsage").mockResolvedValue({ creditCost: "0" })
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")))
      return anthropicText({ input_tokens: 1 })
    }) as unknown as typeof fetch
    try {
      await defaultProofreadDeps.complete({
        system: "Fix the text.",
        prompt: "x".repeat(10_000),
        orgId: "00000000-0000-0000-0000-000000005c01",
        userId: "00000000-0000-0000-0000-000000005c02",
      })
      expect(bodies).toHaveLength(1)
      expect(bodies[0]?.max_tokens).toBe(7)
    } finally {
      fin.mockRestore()
      pre.mockRestore()
    }
  })

  it("hands the meter the cache reads and writes of the call", async () => {
    const pre = precheckWith()
    const fin = spyOn(creditMeter, "finalizeUsage").mockResolvedValue({ creditCost: "0" })
    globalThis.fetch = (async () =>
      anthropicText({
        input_tokens: 40,
        cache_creation_input_tokens: 60,
        cache_read_input_tokens: 900,
      })) as unknown as typeof fetch
    try {
      await defaultProofreadDeps.complete({
        system: "Fix the text.",
        prompt: "teh text",
        orgId: "00000000-0000-0000-0000-000000005c01",
        userId: "00000000-0000-0000-0000-000000005c02",
      })
      const args = fin.mock.calls[0]?.[1] as unknown as Record<string, unknown>
      expect(args.inputTokens).toBe(1000)
      expect(args.cachedInputTokens).toBe(900)
      expect(args.cacheWriteTokens).toBe(60)
    } finally {
      fin.mockRestore()
      pre.mockRestore()
    }
  })
})
