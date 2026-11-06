// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { jsonSchema } from "ai"
import { z } from "zod"
import {
  indexedToolPart,
  loadedToolPart,
  renderIndexedToolsBlock,
  toolPurpose,
} from "~/modules/agent/context/guide-notes"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { handleCallTool } from "~/modules/agent/tools/call-tool"
import {
  CALL_TOOL_SDK_NAME,
  callToolArguments,
  describeLoadedTool,
  fixedToolListFrame,
  undeliveredLoadedTools,
  unwrapCallTool,
  validateLoadedToolInput,
  wrapOffListToolCalls,
} from "./fixed-tool-list"

describe("the call through kernel__call_tool", () => {
  const held = ["kernel__call_tool", "kernel__tool_search", "tickets__get"]

  it("becomes a call to the loaded tool it names, with its arguments as the input", () => {
    expect(
      unwrapCallTool(JSON.stringify({ name: "tickets__get", arguments: { ticketId: "t1" } }), held),
    ).toEqual({ toolName: "tickets__get", input: JSON.stringify({ ticketId: "t1" }) })
  })

  it("reads the arguments in the shapes weak models write them", () => {
    expect(callToolArguments({ name: "x", arguments: '{"a":1}' })).toEqual({ a: 1 })
    expect(callToolArguments({ name: "x", args: { a: 1 } })).toEqual({ a: 1 })
    expect(callToolArguments({ name: "x", a: 1 })).toEqual({ a: 1 })
    expect(
      unwrapCallTool(JSON.stringify({ name: "tickets:get", arguments: {} }), held)?.toolName,
    ).toBe("tickets__get")
  })

  it("is left to the entry itself when it names no held tool", () => {
    expect(unwrapCallTool(JSON.stringify({ name: "tickets__nope", arguments: {} }), held)).toBe(
      null,
    )
    expect(unwrapCallTool(JSON.stringify({ name: CALL_TOOL_SDK_NAME }), held)).toBe(null)
    expect(unwrapCallTool("not json", held)).toBe(null)
  })
})

describe("the history the provider is sent", () => {
  it("writes a call to a tool off the list, and its result, as the entry call it was made through", () => {
    const prompt = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c1",
            toolName: "tickets__get",
            input: { ticketId: "t1" },
          },
          {
            type: "tool-call" as const,
            toolCallId: "c2",
            toolName: "kernel__tool_search",
            input: { query: "q" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "c1",
            toolName: "tickets__get",
            output: { type: "text" as const, value: "ok" },
          },
        ],
      },
    ]
    const out = wrapOffListToolCalls(prompt, new Set(["kernel__tool_search", CALL_TOOL_SDK_NAME]))
    const assistant = out[1] as (typeof prompt)[1]
    expect(assistant.content[0]).toMatchObject({
      toolName: CALL_TOOL_SDK_NAME,
      input: { name: "tickets__get", arguments: { ticketId: "t1" } },
    })
    expect(assistant.content[1]).toBe(prompt[1].content[1])
    expect((out[2] as (typeof prompt)[2]).content[0]).toMatchObject({
      toolName: CALL_TOOL_SDK_NAME,
    })
    // Nothing off the list: the same prompt object, untouched.
    expect(wrapOffListToolCalls(prompt, new Set(["tickets__get", "kernel__tool_search"]))).toBe(
      prompt,
    )
  })
})

describe("a loaded tool's schema and an argument error", () => {
  const tool = {
    description: "Get one ticket.",
    inputSchema: jsonSchema(
      { type: "object", properties: { ticketId: { type: "string" } }, required: ["ticketId"] },
      {
        validate: (value) => {
          const r = z.object({ ticketId: z.string() }).safeParse(value)
          return r.success ? { success: true, value: r.data } : { success: false, error: r.error }
        },
      },
    ),
  }

  it("describes the tool as the tool list would", () => {
    expect(describeLoadedTool("tickets__get", tool)).toEqual({
      name: "tickets__get",
      description: "Get one ticket.",
      parameters: {
        type: "object",
        properties: { ticketId: { type: "string" } },
        required: ["ticketId"],
      },
    })
  })

  it("names the tool, what is wrong and the parameters it expects", async () => {
    expect(await validateLoadedToolInput(tool, { ticketId: "t1" })).toEqual({ ok: true })
    const listed = new Set(["kernel__call_tool"])
    const frame = {
      turnToolNames: new Set(["kernel__call_tool", "tickets__get"]),
      fixedToolList: {
        listed,
        isLoaded: () => true,
        describe: (name: string) => describeLoadedTool(name, tool),
        validate: (_name: string, args: unknown) => validateLoadedToolInput(tool, args),
      },
    } as unknown as RunContext
    const error = await runContextStore
      .run(frame, () =>
        handleCallTool({ name: "tickets__get", arguments: { id: "t1" } }, { orgId: "o" }),
      )
      .then(
        () => null,
        (e: Error) => e.message,
      )
    expect(error).toContain("Invalid arguments for tickets__get")
    expect(error).toContain("ticketId")
    expect(error).toContain('"required":["ticketId"]')
    expect(error).toContain('kernel__call_tool with {"name": "tickets__get"')
  })
})

describe("a name that is no tool the turn holds", () => {
  it("points at a search by job, not at selecting the name, and keeps the log marker", async () => {
    const frame = {
      turnToolNames: new Set(["kernel__call_tool", "knowledge__get"]),
      fixedToolList: { listed: new Set(["kernel__call_tool"]), isLoaded: () => true },
    } as unknown as RunContext
    const error = await runContextStore
      .run(frame, () =>
        handleCallTool({ name: "mail__getSyncStatus", arguments: {} }, { orgId: "o" }),
      )
      .then(
        () => null,
        (e: Error) => e.message,
      )
    expect(error).toContain('No tool named "mail__getSyncStatus" is available to you')
    expect(error).toContain("renamed or replaced")
    expect(error).toContain("describe the job in words with kernel__tool_search")
    expect(error).toContain('"select:<exact name>" only works for a name that search has returned')
    expect(error).not.toContain("Did you mean")
  })
})

describe("a tool loaded on speculation is listed by name until the model asks for it", () => {
  const schemaOf = (props: Record<string, unknown>, required: string[]) =>
    jsonSchema({ type: "object", properties: props, required })
  const tools: Record<string, unknown> = {
    kernel__call_tool: { description: "Call a loaded tool.", inputSchema: schemaOf({}, []) },
    shop__orders_search: {
      description:
        "Search the shop's orders by customer, status or date. Returns at most 50 orders per page.\nLong usage notes follow.",
      inputSchema: schemaOf({ uniqueOrderFilterParam: { type: "string" } }, []),
    },
    shop__refund: {
      description: "Refund an order.",
      inputSchema: schemaOf({ orderId: { type: "string" } }, ["orderId"]),
    },
  }
  const listed = new Set(["kernel__call_tool"])
  const active = Object.keys(tools)

  it("sends one index line per speculative tool, its schema not at all", () => {
    const delivered = new Set<string>()
    const { loaded, indexed, parts } = undeliveredLoadedTools(
      active,
      listed,
      tools,
      delivered,
      (name) => name === "shop__orders_search",
    )
    expect(loaded.map((t) => t.name)).toEqual(["shop__refund"])
    expect(indexed.map((t) => t.name)).toEqual(["shop__orders_search"])
    expect(parts).toEqual([indexedToolPart("shop__orders_search"), loadedToolPart("shop__refund")])
    const block = renderIndexedToolsBlock(indexed)
    expect(block).toContain(
      "- shop__orders_search: Search the shop's orders by customer, status or date.",
    )
    expect(block).not.toContain("uniqueOrderFilterParam")
    expect(block).not.toContain("Long usage notes")
    expect(block).toContain("kernel__call_tool")
    expect(block).toContain('"select:<its name>"')
  })

  it("sends the index line once, and the schema once the tool is asked for", () => {
    const delivered = new Set([
      indexedToolPart("shop__orders_search"),
      loadedToolPart("shop__refund"),
    ])
    // Still known by name only: nothing new to send.
    const again = undeliveredLoadedTools(active, listed, tools, delivered, () => true)
    expect(again.loaded).toEqual([])
    expect(again.indexed).toEqual([])
    // Asked for (searched or called): the full schema, as its `tool:` part.
    const asked = undeliveredLoadedTools(active, listed, tools, delivered, () => false)
    expect(asked.loaded.map((t) => t.name)).toEqual(["shop__orders_search"])
    expect(asked.parts).toEqual([loadedToolPart("shop__orders_search")])
    expect(JSON.stringify(asked.loaded[0]?.parameters)).toContain("uniqueOrderFilterParam")
    // Delivered in full: never listed by name again.
    delivered.add(loadedToolPart("shop__orders_search"))
    expect(undeliveredLoadedTools(active, listed, tools, delivered, () => true).indexed).toEqual([])
  })

  it("states a tool's purpose in one sentence", () => {
    expect(toolPurpose("Refund an order. Partial refunds take an amount.")).toBe("Refund an order.")
    expect(toolPurpose("\n  Look up v1.2 of a doc\nmore")).toBe("Look up v1.2 of a doc")
    expect(toolPurpose("x".repeat(300))).toHaveLength(160)
  })

  it("a call through the entry asks for the tool, and bad arguments come back with its parameters", async () => {
    const requested: string[] = []
    const frame = {
      turnToolNames: new Set(active),
      fixedToolList: fixedToolListFrame(
        listed,
        {
          ...tools,
          shop__refund: {
            description: "Refund an order.",
            inputSchema: jsonSchema(
              {
                type: "object",
                properties: { orderId: { type: "string" } },
                required: ["orderId"],
              },
              {
                validate: (value) => {
                  const r = z.object({ orderId: z.string() }).safeParse(value)
                  return r.success
                    ? { success: true, value: r.data }
                    : { success: false, error: r.error }
                },
              },
            ),
          },
        },
        () => true,
        (names) => requested.push(...names),
      ),
    } as unknown as RunContext
    const error = await runContextStore
      .run(frame, () =>
        handleCallTool({ name: "shop__refund", arguments: { order: "1" } }, { orgId: "o" }),
      )
      .then(
        () => null,
        (e: Error) => e.message,
      )
    expect(requested).toEqual(["shop__refund"])
    expect(error).toContain("Invalid arguments for shop__refund")
    expect(error).toContain('"required":["orderId"]')
  })
})
