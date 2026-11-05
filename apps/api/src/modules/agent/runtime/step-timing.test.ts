// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The step timer is fed by the real SDK loop (`runAgentStream` forwards the
// model-call start, its chunks and its end), so every step of a turn gets a
// time to first token and a model time on `agent_step_usage`.
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Drop the `onChunk` forwarding: ttftMs comes back null.
//  * Drop the `onLanguageModelCallStart` forwarding: every time comes back null.
import { describe, expect, it } from "bun:test"
import { simulateReadableStream, stepCountIs, tool } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { z } from "zod"
import { runAgentStream } from "~/modules/agent/runtime/agent-service"
import { StepTimer, type StepTimes } from "~/modules/agent/runtime/step-timing"

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}
const finish = {
  type: "finish" as const,
  finishReason: { unified: "stop" as const, raw: "STOP" },
  usage: USAGE,
}

describe("step timing through the SDK loop", () => {
  it("each step gets a time to first token and a model time", async () => {
    const model = new MockLanguageModelV3({
      doStream: [
        {
          stream: simulateReadableStream({
            initialDelayInMs: 30,
            chunkDelayInMs: 5,
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-call" as const,
                toolCallId: "c1",
                toolName: "lookup",
                input: JSON.stringify({ id: 1 }),
              },
              { ...finish, finishReason: { unified: "tool-calls" as const, raw: "TOOL" } },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            initialDelayInMs: 30,
            chunkDelayInMs: 5,
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "t1" },
              { type: "text-delta" as const, id: "t1", delta: "done" },
              { type: "text-end" as const, id: "t1" },
              finish,
            ],
          }),
        },
      ],
    })
    const stepTimer = new StepTimer()
    const times: StepTimes[] = []
    const result = runAgentStream({
      model,
      stepTokenCap: null,
      stepTimer,
      system: "sys",
      messages: [{ role: "user", content: "look it up" }],
      tools: {
        lookup: tool({
          description: "lookup",
          inputSchema: z.object({ id: z.number() }),
          execute: async () => "found",
        }),
      } as never,
      stopWhen: stepCountIs(3),
      onStepFinish: () => {
        times.push(stepTimer.stepFinished())
      },
    })
    for await (const _ of result.fullStream) {
      // drain
    }
    expect(times.length).toBe(2)
    for (const t of times) {
      expect(t.ttftMs).not.toBeNull()
      expect(t.ttftMs as number).toBeGreaterThan(0)
      expect(t.modelMs as number).toBeGreaterThanOrEqual(t.ttftMs as number)
      expect(t.stepMs).toBeGreaterThanOrEqual(t.modelMs as number)
    }
  })
})
