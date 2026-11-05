// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agentic loop, with a stub model. No network.
import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { createSdkAnswerer, FINAL_ANSWER_INSTRUCTION, parseToolCall } from "./answerers"
import type { BenchTool } from "./types"

const searchTool: BenchTool = {
  name: "memory_search",
  description: "search",
  inputSchema: z.object({ query: z.string() }),
  async run() {
    return "m000123 | 2026-09-08T09:14:00Z | quinn | the pallet is 1200 x 1000"
  },
}

describe("the forced last turn", () => {
  it("still answers when the model calls a tool at every opportunity", async () => {
    const prompts: string[] = []
    const answerer = createSdkAnswerer({
      modelId: "stub",
      async call(_model, prompt) {
        prompts.push(prompt)
        // The model calls a tool whenever the tool protocol is in front of it.
        if (prompt.includes(FINAL_ANSWER_INSTRUCTION)) {
          return { text: "the pallet is 1200 x 1000", inputTokens: 7 }
        }
        return { text: '{"tool":"memory_search","args":{"query":"pallet"}}', inputTokens: 7 }
      },
    })
    const result = await answerer.answer({
      system: "you are the agent",
      user: "what pallet do we use?",
      tools: [searchTool],
      maxToolCalls: 3,
    })
    expect(result.toolCalls).toBe(3)
    expect(result.text).toBe("the pallet is 1200 x 1000")
    expect(result.text.trim()).not.toBe("")
    // Three tool turns plus the forced last turn, which carries no protocol.
    expect(prompts).toHaveLength(4)
    expect(prompts[3]).toContain(FINAL_ANSWER_INSTRUCTION)
    expect(prompts[3]).not.toContain("To call one, reply with ONLY a JSON object")
    expect(result.providerInputTokens).toBe(28)
  })

  it("reports an empty answer when even the forced turn calls a tool", async () => {
    const answerer = createSdkAnswerer({
      modelId: "stub",
      async call() {
        return { text: '{"tool":"memory_search","args":{"query":"pallet"}}', inputTokens: 1 }
      },
    })
    const result = await answerer.answer({
      system: "s",
      user: "u",
      tools: [searchTool],
      maxToolCalls: 3,
    })
    expect(result.toolCalls).toBe(3)
    expect(result.text).toBe("")
  })

  it("never runs a tool turn when the strategy offers no tools", async () => {
    let calls = 0
    const answerer = createSdkAnswerer({
      modelId: "stub",
      async call() {
        calls++
        return { text: "7492118", inputTokens: null }
      },
    })
    const result = await answerer.answer({ system: "s", user: "u", tools: [], maxToolCalls: 0 })
    expect(calls).toBe(1)
    expect(result.toolCalls).toBe(0)
    expect(result.text).toBe("7492118")
  })

  it("reads a tool call out of a fenced reply and nothing out of prose", () => {
    expect(parseToolCall('```json\n{"tool":"memory_open","args":{"id":"m1"}}\n```')?.tool).toBe(
      "memory_open",
    )
    expect(parseToolCall("the account number is 7492118")).toBeNull()
  })
})
