// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool's declared output shape (`returns.schema`): each field is present with its declared kind.
import { describe, expect, it } from "bun:test"
import { validateToolResult } from "./execute-tool"

describe("validateToolResult", () => {
  it("a field declared array holds an array, and nothing else passes for one", () => {
    const schema = { title: "string", steps: "array", quote: "object" }
    expect(validateToolResult({ title: "Plan", steps: [], quote: null }, schema)).toBe(true)
    expect(validateToolResult({ title: "Plan", steps: [{ a: 1 }], quote: {} }, schema)).toBe(true)
    expect(validateToolResult({ title: "Plan", steps: {}, quote: null }, schema)).toBe(false)
    expect(validateToolResult({ title: "Plan", quote: null }, schema)).toBe(false)
  })
})
