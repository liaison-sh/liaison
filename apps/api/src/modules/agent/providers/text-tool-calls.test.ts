// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { simulateReadableStream, stepCountIs, tool } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { z } from "zod"
import { parseTextToolCalls } from "~/modules/agent/providers/text-tool-calls"
import { runAgentStream } from "~/modules/agent/runtime/agent-service"

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

function textStep(text: string, chunkSize = 7) {
  const deltas: string[] = []
  for (let i = 0; i < text.length; i += chunkSize) deltas.push(text.slice(i, i + chunkSize))
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
        { type: "text-end" as const, id: "t1" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "STOP" },
          usage: USAGE,
        },
      ],
    }),
  }
}

// The walk's reply, verbatim shape (87-dm-liaison-d.png).
const WRITTEN_CALL = JSON.stringify(
  {
    calls: [
      {
        tool: "tool_search",
        arguments: { query: "select:kpi_list_hubs,kpi_run" },
      },
    ],
  },
  null,
  2,
)

async function run(first: string) {
  const executed: Array<Record<string, unknown>> = []
  const model = new MockLanguageModelV3({
    doStream: [textStep(first), textStep("Le centre B'EST a eu 42 inscrits.")],
  })
  const result = runAgentStream({
    model,
    stepTokenCap: null,
    system: "sys",
    messages: [{ role: "user", content: "Combien d'inscrits ?" }],
    tools: {
      kernel__tool_search: tool({
        description: "find tools",
        inputSchema: z.object({ query: z.string() }),
        execute: async (input) => {
          executed.push(input)
          return { tools: ["kpi__kpi_run"] }
        },
      }),
    },
    stopWhen: stepCountIs(5),
  })
  const text = await result.text
  return { text, executed, calls: model.doStreamCalls.length }
}

describe("a tool call the model writes as text", () => {
  it("is executed as a real call and never becomes the answer", async () => {
    const out = await run(WRITTEN_CALL)
    expect(out.executed).toEqual([{ query: "select:kpi_list_hubs,kpi_run" }])
    expect(out.calls).toBe(2)
    expect(out.text).toBe("Le centre B'EST a eu 42 inscrits.")
    expect(out.text).not.toContain('"calls"')
  })

  it("also when fenced as a json code block", async () => {
    const out = await run(`\`\`\`json\n${WRITTEN_CALL}\n\`\`\``)
    expect(out.executed).toHaveLength(1)
    expect(out.text).not.toContain("tool_search")
  })

  it("leaves ordinary prose alone (one model call, text unchanged)", async () => {
    const model = new MockLanguageModelV3({ doStream: [textStep("Bonjour, voici la réponse.")] })
    const result = runAgentStream({
      model,
      stepTokenCap: null,
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: {
        kernel__tool_search: tool({
          inputSchema: z.object({ query: z.string() }),
          execute: async () => ({}),
        }),
      },
      stopWhen: stepCountIs(5),
    })
    expect(await result.text).toBe("Bonjour, voici la réponse.")
    expect(model.doStreamCalls.length).toBe(1)
  })

  it("keeps a JSON answer that names no offered tool", async () => {
    const answer = JSON.stringify({ name: "Alice", args: { age: 3 } })
    const model = new MockLanguageModelV3({ doStream: [textStep(answer)] })
    const result = runAgentStream({
      model,
      stepTokenCap: null,
      system: "sys",
      messages: [{ role: "user", content: "give me json" }],
      tools: {
        kernel__tool_search: tool({
          inputSchema: z.object({ query: z.string() }),
          execute: async () => ({}),
        }),
      },
      stopWhen: stepCountIs(5),
    })
    expect(await result.text).toBe(answer)
  })
})

describe("parseTextToolCalls", () => {
  const offered = ["kernel__tool_search", "kpi__kpi_run"]
  it("resolves bare names to the app-prefixed tool", () => {
    expect(parseTextToolCalls('{"tool":"kpi_run","args":{"hub":"x"}}', offered)).toEqual([
      { toolName: "kpi__kpi_run", input: { hub: "x" } },
    ])
  })
  it("accepts the OpenAI function shape with string arguments", () => {
    expect(
      parseTextToolCalls(
        '[{"function":{"name":"kernel__tool_search","arguments":"{\\"query\\":\\"q\\"}"}}]',
        offered,
      ),
    ).toEqual([{ toolName: "kernel__tool_search", input: { query: "q" } }])
  })
  it("rejects text around the block and unknown tools", () => {
    expect(parseTextToolCalls('Voici: {"tool":"kpi_run"}', offered)).toBeNull()
    expect(parseTextToolCalls('{"tool":"rm_rf","arguments":{}}', offered)).toBeNull()
  })
})
