// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { pgSafe } from "./pg-safe-text"

describe("pgSafe", () => {
  it("drops U+0000 from strings, nested values and keys", () => {
    const input = { a: "x\u0000y", list: ["\u0000", 1, null, { "k\u0000": "v" }], n: 3 }
    const out: unknown = pgSafe(input)
    expect(out).toEqual({ a: "xy", list: ["", 1, null, { k: "v" }], n: 3 })
    // The input is never mutated.
    expect(input.a).toBe("x\u0000y")
  })

  it("replaces a lone surrogate and keeps a valid pair", () => {
    expect(pgSafe("a\uD800b")).toBe("a�b")
    expect(pgSafe("a\uDC00")).toBe("a�")
    expect(pgSafe("😀")).toBe("😀")
  })

  it("returns the same reference when nothing needs changing", () => {
    const input = { a: "plain", list: [1, "two", { three: true }], when: new Date(0) }
    expect(pgSafe(input)).toBe(input)
    const s = "plain"
    expect(pgSafe(s)).toBe(s)
  })

  it("survives a cycle and leaves class instances alone", () => {
    const cyclic: Record<string, unknown> = { a: "x\u0000" }
    cyclic.self = cyclic
    const out = pgSafe(cyclic)
    expect(out.a).toBe("x")
    const when = new Date(0)
    expect(pgSafe({ when }).when).toBe(when)
  })

  it("makes a value JSON that jsonb accepts", () => {
    const json = JSON.stringify(pgSafe({ name: "\u0000", s: "\uD83D" }))
    expect(json).not.toContain("\\u0000")
    expect(json).not.toMatch(/\\ud[89ab]/i)
  })
})
