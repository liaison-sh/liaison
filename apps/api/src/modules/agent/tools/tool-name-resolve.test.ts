// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool name the model calls in the wrong form (`knowledge:search`, a bare
// `tool_search`) runs the held tool it unambiguously names; an ambiguous or
// unheld name is refused with the closest held names; a tool the turn does not
// hold never executes. The stream tests drive the REAL AI SDK loop with a mock
// model, so they pin what the SDK actually does with the repair hook.
import { describe, expect, it } from "bun:test"
import {
  InvalidToolInputError,
  NoSuchToolError,
  simulateReadableStream,
  stepCountIs,
  tool,
} from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { z } from "zod"
import { runAgentStream, toolErrorLogLevel } from "~/modules/agent/runtime/agent-service"
import { jsonSchemaToZod } from "~/modules/agent/tools/tool-bridge"
import {
  isUnresolvedToolCallError,
  repairHeldToolCall,
  resolveHeldToolName,
} from "~/modules/agent/tools/tool-name-resolve"

const HELD = [
  "kernel__tool_search",
  "kernel__skill_read",
  "knowledge__search",
  "knowledge__get",
  "tickets__search",
  "tickets__reply",
  "invoicing__pending_approvals_list",
]

describe("resolveHeldToolName", () => {
  it("an exact held name is itself", () => {
    expect(resolveHeldToolName("knowledge__search", HELD)).toEqual({
      kind: "exact",
      name: "knowledge__search",
    })
  })

  it("separator variants resolve to the held app__tool", () => {
    for (const called of [
      "knowledge:search",
      "knowledge.search",
      "knowledge/search",
      "knowledge::search",
    ]) {
      expect(resolveHeldToolName(called, HELD)).toEqual({
        kind: "resolved",
        name: "knowledge__search",
        via: "separator",
      })
    }
    expect(resolveHeldToolName("kernel:tool_search", HELD)).toMatchObject({
      name: "kernel__tool_search",
    })
  })

  it("a bare name resolves only when exactly one held tool carries it", () => {
    expect(resolveHeldToolName("tool_search", HELD)).toEqual({
      kind: "resolved",
      name: "kernel__tool_search",
      via: "bare",
    })
    expect(resolveHeldToolName("reply", HELD)).toMatchObject({ name: "tickets__reply" })
  })

  it("a bare name shared by several held tools is ambiguous and names them", () => {
    expect(resolveHeldToolName("search", HELD)).toEqual({
      kind: "ambiguous",
      candidates: ["knowledge__search", "tickets__search"],
    })
  })

  it("a separator form naming an app the turn does not hold never borrows another app's tool", () => {
    const r = resolveHeldToolName("mail:search", HELD)
    expect(r.kind).toBe("unknown")
    // Suggestions are held names only.
    if (r.kind === "unknown") {
      expect(r.suggestions.length).toBeGreaterThan(0)
      for (const s of r.suggestions) expect(HELD).toContain(s)
      expect(r.suggestions).toContain("knowledge__search")
    }
  })

  it("an unheld tool is unknown, with the closest held names suggested", () => {
    const r = resolveHeldToolName("kernel__approvals_list", HELD)
    expect(r).toEqual({ kind: "unknown", suggestions: ["invoicing__pending_approvals_list"] })
  })
})

describe("repairHeldToolCall (the SDK repair hook)", () => {
  const noop = tool({ inputSchema: z.object({}).passthrough(), execute: async () => ({}) })
  const heldSet = Object.fromEntries(HELD.map((n) => [n, noop]))
  const noSuch = (name: string) => new NoSuchToolError({ toolName: name, availableTools: [] })

  it("an active held tool named in another form runs under its real name, input untouched", async () => {
    const repair = repairHeldToolCall(heldSet)
    const out = await repair({
      toolCall: { toolCallId: "c1", toolName: "knowledge:search", input: '{"query":"packing"}' },
      tools: { knowledge__search: noop },
      error: noSuch("knowledge:search"),
    })
    expect(out).toEqual({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "knowledge__search",
      input: '{"query":"packing"}',
    })
  })

  it("a held but deferred tool becomes its discovery", async () => {
    const repair = repairHeldToolCall(heldSet)
    const out = await repair({
      toolCall: { toolCallId: "c2", toolName: "tickets:reply", input: "{}" },
      tools: { kernel__tool_search: noop },
      error: noSuch("tickets:reply"),
    })
    expect(out).toEqual({
      type: "tool-call",
      toolCallId: "c2",
      toolName: "kernel__tool_search",
      input: JSON.stringify({ query: "select:tickets__reply" }),
    })
  })

  it("an ambiguous name is refused with the candidates", async () => {
    const repair = repairHeldToolCall(heldSet)
    await expect(
      repair({
        toolCall: { toolCallId: "c3", toolName: "search", input: "{}" },
        tools: heldSet,
        error: noSuch("search"),
      }),
    ).rejects.toThrow(/knowledge__search, tickets__search/)
  })

  it("an unheld tool is refused and never rewritten into anything executable", async () => {
    const repair = repairHeldToolCall(heldSet)
    await expect(
      repair({
        toolCall: { toolCallId: "c4", toolName: "kernel:approvals_list", input: "{}" },
        tools: heldSet,
        error: noSuch("kernel:approvals_list"),
      }),
    ).rejects.toThrow(/invoicing__pending_approvals_list/)
  })
})

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

function toolCallStep(toolName: string, input: Record<string, unknown>) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: "call-1",
          toolName,
          input: JSON.stringify(input),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "TOOL_CALLS" },
          usage: USAGE,
        },
      ],
    }),
  }
}

function textStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        { type: "text-delta" as const, id: "t1", delta: text },
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

/** One turn through the real SDK loop: the model calls `called`, then answers. */
async function turn(called: string, heldExtra: Record<string, unknown> = {}) {
  const executed: Array<{ tool: string; input: unknown }> = []
  const exec = (name: string) =>
    tool({
      description: name,
      inputSchema: z.object({ query: z.string() }),
      execute: async (input) => {
        executed.push({ tool: name, input })
        return { ok: true }
      },
    })
  const tools = {
    kernel__tool_search: exec("kernel__tool_search"),
    knowledge__search: exec("knowledge__search"),
    tickets__search: exec("tickets__search"),
    ...heldExtra,
  }
  const model = new MockLanguageModelV3({
    doStream: [toolCallStep(called, { query: "packing" }), textStep("done")],
  })
  const { blindCallRepair } = await import("~/modules/agent/runtime/agent-service")
  const result = runAgentStream({
    model,
    stepTokenCap: null,
    system: "sys",
    messages: [{ role: "user", content: "find the packing doc" }],
    tools: tools as never,
    stopWhen: stepCountIs(4),
    repairToolCall: blindCallRepair(tools as never),
  })
  const errors: unknown[] = []
  for await (const chunk of result.fullStream) {
    if (chunk.type === "tool-error") errors.push(chunk.error)
  }
  // What the model reads back on its second step.
  const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt ?? [])
  return { executed, errors, secondPrompt }
}

describe("through the real SDK loop", () => {
  it("knowledge:search executes knowledge__search in the same step", async () => {
    const out = await turn("knowledge:search")
    expect(out.executed).toEqual([{ tool: "knowledge__search", input: { query: "packing" } }])
    expect(out.errors).toEqual([])
  })

  it("a bare tool_search executes kernel__tool_search", async () => {
    const out = await turn("tool_search")
    expect(out.executed).toEqual([{ tool: "kernel__tool_search", input: { query: "packing" } }])
    expect(out.errors).toEqual([])
  })

  it("a bare ambiguous name executes nothing and the model reads the candidates", async () => {
    const out = await turn("search")
    expect(out.executed).toEqual([])
    expect(out.errors).toHaveLength(1)
    expect(out.secondPrompt).toContain("knowledge__search, tickets__search")
    // The refusal is the model's mistake, logged at warn, not a page.
    expect(toolErrorLogLevel(out.errors[0])).toBe("warn")
  })

  it("an unheld tool executes nothing, and the error names the closest held tools", async () => {
    const out = await turn("kernel__approvals_list")
    expect(out.executed).toEqual([])
    expect(out.secondPrompt).toContain('No tool named \\"kernel__approvals_list\\"')
    expect(isUnresolvedToolCallError(out.errors[0])).toBe(true)
    expect(toolErrorLogLevel(out.errors[0])).toBe("warn")
  })
})

// The live payload: a weak model sent tickets__search's `status` (one status,
// or an array of them) as a JSON-encoded string, and the SDK refused the call.
const STATUS_ENUM = ["open", "awaiting_customer", "awaiting_followup", "closed"]
const searchTool = () =>
  tool({
    description: "tickets search",
    // The shape the bridge builds from the manifest's JSON Schema.
    inputSchema: z.object({
      q: jsonSchemaToZod({ type: "string" }).optional(),
      status: jsonSchemaToZod({
        oneOf: [
          { type: "string", enum: STATUS_ENUM },
          { type: "array", items: { type: "string", enum: STATUS_ENUM } },
        ],
      }).optional(),
      limit: jsonSchemaToZod({ type: "integer" }).optional(),
    }),
    execute: async () => ({ ok: true }),
  })
const LIVE_INPUT = JSON.stringify({
  q: "Kestrel battery sled charging",
  status: '["closed", "awaiting_customer", "awaiting_followup"]',
})
const invalidInput = (input: string) =>
  new InvalidToolInputError({ toolName: "tickets__search", toolInput: input, cause: "bad" })

describe("a stringified array parameter (the SDK repair hook)", () => {
  it("parses the live payload into the array the schema wants", async () => {
    const tools = { tickets__search: searchTool() }
    const repaired = await repairHeldToolCall(tools as never)({
      toolCall: { toolCallId: "s1", toolName: "tickets__search", input: LIVE_INPUT },
      tools,
      error: invalidInput(LIVE_INPUT),
    })
    expect(repaired).toEqual({
      type: "tool-call",
      toolCallId: "s1",
      toolName: "tickets__search",
      input: JSON.stringify({
        q: "Kestrel battery sled charging",
        status: ["closed", "awaiting_customer", "awaiting_followup"],
      }),
    })
  })

  it("never coerces an array whose items the schema refuses, or in any other direction", async () => {
    const tools = { tickets__search: searchTool() }
    const repair = repairHeldToolCall(tools as never)
    for (const input of [
      // items outside the enum
      JSON.stringify({ status: '["closed", "nonsense"]' }),
      // a string that is not an array
      JSON.stringify({ status: '{"a":1}' }),
      // a string where only a number is admitted
      JSON.stringify({ limit: "[1]" }),
      // a parameter whose schema is a plain string stays a string
      JSON.stringify({ q: '["a"]', status: "[1]" }),
    ]) {
      expect(
        await repair({
          toolCall: { toolCallId: "s2", toolName: "tickets__search", input },
          tools,
          error: invalidInput(input),
        }),
      ).toBeNull()
    }
  })

  it("through the real SDK loop the call executes with the parsed array, no input error", async () => {
    const executed: unknown[] = []
    const tools = {
      tickets__search: tool({
        ...searchTool(),
        execute: async (input: unknown) => {
          executed.push(input)
          return { ok: true }
        },
      }),
    }
    const model = new MockLanguageModelV3({
      doStream: [
        toolCallStep("tickets__search", JSON.parse(LIVE_INPUT) as Record<string, unknown>),
        textStep("done"),
      ],
    })
    const { blindCallRepair } = await import("~/modules/agent/runtime/agent-service")
    const result = runAgentStream({
      model,
      stepTokenCap: null,
      system: "sys",
      messages: [{ role: "user", content: "find similar tickets" }],
      tools: tools as never,
      stopWhen: stepCountIs(4),
      repairToolCall: blindCallRepair(tools as never),
    })
    const errors: unknown[] = []
    for await (const chunk of result.fullStream) {
      if (chunk.type === "tool-error") errors.push(chunk.error)
    }
    expect(errors).toEqual([])
    expect(executed).toEqual([
      {
        q: "Kestrel battery sled charging",
        status: ["closed", "awaiting_customer", "awaiting_followup"],
      },
    ])
  })
})
