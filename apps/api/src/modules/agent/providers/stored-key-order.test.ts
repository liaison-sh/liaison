// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { inStoredKeyOrder, promptInStoredKeyOrder } from "./stored-key-order"

describe("tool calls and results in the key order jsonb stores", () => {
  it("orders keys shorter first, then byte by byte, at every depth", () => {
    const value = { query: "q", matches: [{ name: "a", appName: "x" }], note: "n", hint: "h" }
    // What `SELECT '{...}'::jsonb` gives back for the same object.
    expect(JSON.stringify(inStoredKeyOrder(value))).toBe(
      '{"hint":"h","note":"n","query":"q","matches":[{"name":"a","appName":"x"}]}',
    )
    expect(Object.keys(inStoredKeyOrder({ b: 1, B: 2, aa: 3 }) as object)).toEqual(["B", "b", "aa"])
  })

  it("returns a value already in that order as it is", () => {
    const value = { a: 1, bb: [{ c: 2 }] }
    expect(inStoredKeyOrder(value)).toBe(value)
  })

  it("rewrites tool call inputs and JSON results, and nothing else", () => {
    const prompt = [
      { role: "user" as const, content: [{ type: "text" as const, text: '{"zz":1,"a":2}' }] },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c1",
            toolName: "t",
            input: { query: 1, id: 2 },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "c1",
            toolName: "t",
            output: { type: "json" as const, value: { results: [], hint: "h" } },
          },
        ],
      },
    ]
    const out = promptInStoredKeyOrder(prompt)
    expect(out[0]).toBe(prompt[0])
    expect(JSON.stringify(out[1])).toContain('"input":{"id":2,"query":1}')
    expect(JSON.stringify(out[2])).toContain('"value":{"hint":"h","results":[]}')
    expect(promptInStoredKeyOrder(out)).toBe(out)
  })
})
