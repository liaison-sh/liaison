// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo orgs' per-step output limit, through the agent loop's own entry
// point (`runAgentStream`), so a loop that stops applying the cap fails here as
// surely as a middleware that stops capping. A step's input is not limited.
import { describe, expect, it } from "bun:test"
import { simulateReadableStream, stepCountIs } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import {
  CHARS_PER_TOKEN_FLOOR,
  estimateVisitorTokens,
  type StepTokenCap,
} from "~/modules/agent/providers/step-token-cap"
import { runAgentStream } from "~/modules/agent/runtime/agent-service"
import { RESERVED_STEP_OUTPUT_TOKENS } from "~/modules/demo/demo-spend-ceiling"

const RESERVED_CAP: StepTokenCap = { maxOutputTokens: RESERVED_STEP_OUTPUT_TOKENS }

function answer() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        { type: "text-delta" as const, id: "t1", delta: "ok" },
        { type: "text-end" as const, id: "t1" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "STOP" },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ],
    }),
  }
}

async function run(content: string, stepTokenCap: StepTokenCap | null) {
  const model = new MockLanguageModelV4({ doStream: async () => answer() })
  const result = runAgentStream({
    model,
    stepTokenCap,
    system: "sys",
    messages: [{ role: "user", content }],
    tools: {},
    stopWhen: stepCountIs(1),
  })
  let error: unknown = null
  try {
    for await (const part of result.fullStream) {
      if (part.type === "error") error = part.error
    }
  } catch (err) {
    error = err
  }
  return { model, error }
}

describe("the per-step token cap", () => {
  // 150,000 tokens' worth at the floor: past any input limit the demo once had.
  const large = "x".repeat(150_000 * CHARS_PER_TOKEN_FLOOR)

  it("sends a large reserved step, its output capped and its input untouched", async () => {
    const { model, error } = await run(large, RESERVED_CAP)
    expect(error).toBeNull()
    expect(model.doStreamCalls.length).toBe(1)
    expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(RESERVED_STEP_OUTPUT_TOKENS)
  })

  it("sends the same context untouched when the org has no cap", async () => {
    const { model, error } = await run(large, null)
    expect(error).toBeNull()
    expect(model.doStreamCalls.length).toBe(1)
    expect(model.doStreamCalls[0]?.maxOutputTokens).toBeUndefined()
  })

  it("hands a visitor step's input estimate to its meter before the request leaves", async () => {
    const seen: number[] = []
    const { model, error } = await run(large, {
      maxOutputTokens: 16_000,
      visitor: true,
      onRequest: (estimated) => {
        seen.push(estimated)
      },
    })
    expect(error).toBeNull()
    expect(model.doStreamCalls.length).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeGreaterThanOrEqual(150_000)
  })

  it("sends nothing when the meter refuses the request", async () => {
    const { model, error } = await run("Bonjour", {
      maxOutputTokens: 16_000,
      visitor: true,
      onRequest: () => {
        throw new Error("The demo budget for this email is used up.")
      },
    })
    expect(model.doStreamCalls.length).toBe(0)
    expect(String((error as Error | null)?.message ?? error)).toContain("budget")
  })

  it("estimates at the floor, so it never undercounts plain text", () => {
    const text = "a".repeat(30_000)
    expect(estimateVisitorTokens(text)).toBeGreaterThanOrEqual(text.length / CHARS_PER_TOKEN_FLOOR)
  })
})
