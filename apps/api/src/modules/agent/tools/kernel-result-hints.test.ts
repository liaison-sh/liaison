// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  KERNEL_RESULT_HINTS,
  resultHintsShownIn,
  SHORT_WEB_FETCH_HINT,
  SHORT_WEB_SEARCH_HINT,
  withToolResultHint,
} from "./kernel-result-hints"

const toolMessage = (value: unknown) => ({
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: "c", toolName: "x", output: { type: "json", value } },
  ],
})

describe("a kernel tool's result rule, once per conversation", () => {
  it("the first result carries the full rule, the later ones the short untrusted marker", () => {
    const shown = new Set<string>()
    const first = withToolResultHint("web_fetch", { content: "<p1>" }, shown) as Record<
      string,
      unknown
    >
    expect(first.hint).toBe(KERNEL_RESULT_HINTS.web_fetch)
    // First, so a result cut to its head keeps it.
    expect(Object.keys(first)[0]).toBe("hint")
    expect(shown.has("web_fetch")).toBe(true)
    const second = withToolResultHint("web_fetch", { content: "<p2>" }, shown)
    expect(second).toEqual({ content: "<p2>", hint: SHORT_WEB_FETCH_HINT })
    expect(SHORT_WEB_FETCH_HINT).toMatch(/untrusted/i)
    expect(SHORT_WEB_FETCH_HINT.length).toBeLessThan(200)
    expect(KERNEL_RESULT_HINTS.web_fetch?.length).toBeGreaterThan(1000)
    // Each tool counts on its own.
    const search = withToolResultHint("web_search", { results: [] }, shown) as Record<
      string,
      unknown
    >
    expect(search.hint).toBe(KERNEL_RESULT_HINTS.web_search)
    expect(withToolResultHint("web_search", { results: [] }, shown)).toEqual({
      results: [],
      hint: SHORT_WEB_SEARCH_HINT,
    })
    expect(SHORT_WEB_SEARCH_HINT).toMatch(/untrusted/i)
  })

  it("a tool without a short marker carries nothing once its rule was shown", () => {
    const shown = new Set(["tool_search"])
    const result = { matches: [] }
    expect(withToolResultHint("tool_search", result, shown)).toBe(result)
  })

  it("a failure never counts as the rule shown", () => {
    const shown = new Set<string>()
    expect(withToolResultHint("web_fetch", { error: "HTTP 404" }, shown)).toEqual({
      error: "HTTP 404",
      hint: SHORT_WEB_FETCH_HINT,
    })
    expect(shown.size).toBe(0)
  })

  it("without a conversation to track, every result carries the full rule", () => {
    expect(withToolResultHint("web_fetch", { content: "x" }, undefined)).toEqual({
      content: "x",
      hint: KERNEL_RESULT_HINTS.web_fetch,
    })
    const own = { content: "x", hint: "own" }
    expect(withToolResultHint("web_fetch", own, new Set())).toBe(own)
    expect(withToolResultHint("web_fetch", "text", new Set())).toBe("text")
    expect(withToolResultHint("not_a_hinted_tool", { a: 1 }, new Set())).toEqual({ a: 1 })
  })

  it("reads which rules a replayed history holds, and only whole ones", () => {
    const shown = resultHintsShownIn([
      { role: "user", content: "hello" },
      toolMessage({ content: "x", hint: KERNEL_RESULT_HINTS.web_fetch }),
      toolMessage({ content: "y", hint: SHORT_WEB_SEARCH_HINT }),
      toolMessage({
        matches: [],
        hint: `${KERNEL_RESULT_HINTS.tool_search?.slice(0, 50)}… [clipped]`,
      }),
    ])
    expect([...shown]).toEqual(["web_fetch"])
  })
})
