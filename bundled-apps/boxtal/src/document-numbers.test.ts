// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { CrossAppEnvelope } from "./ctx"
import { documentNumbersById } from "./document-numbers"

describe("documentNumbersById", () => {
  it("resolves ids to numbers in one documents_search read by ids", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const ctx = {
      executeTool: async (target: string, args: string | Record<string, unknown>): Promise<CrossAppEnvelope> => {
        calls.push({ target, args })
        return {
          status: "completed",
          result: [
            { id: "a", number: "INV-2026-0022" },
            { id: "b", number: null },
          ],
        } as CrossAppEnvelope
      },
    }
    const map = await documentNumbersById(ctx, ["a", "b", "a", null, ""])
    expect(calls).toEqual([{ target: "invoicing:documents_search", args: { ids: ["a", "b"], limit: 2 } }])
    expect(map.get("a")).toBe("INV-2026-0022")
    expect(map.has("b")).toBe(false)
  })

  it("makes no call for no refs, and a refused read leaves every id unresolved", async () => {
    let n = 0
    const refused = {
      executeTool: async (): Promise<CrossAppEnvelope> => {
        n++
        return { status: "error", error: { code: "forbidden", message: "no" } } as CrossAppEnvelope
      },
    }
    expect((await documentNumbersById(refused, [])).size).toBe(0)
    expect(n).toBe(0)
    expect((await documentNumbersById(refused, ["a"])).size).toBe(0)
  })
})
