// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { type DiffLine, diffStats, lineDiff, withCollapsedContext } from "./line-diff"

const types = (lines: DiffLine[]) => lines.map((l) => `${l.type[0]}:${l.text}`)

describe("lineDiff", () => {
  it("marks unchanged lines as same", () => {
    expect(lineDiff("a\nb\nc", "a\nb\nc")).toEqual([
      { type: "same", text: "a" },
      { type: "same", text: "b" },
      { type: "same", text: "c" },
    ])
  })

  it("detects a pure addition in the middle", () => {
    expect(types(lineDiff("a\nc", "a\nb\nc"))).toEqual(["s:a", "a:b", "s:c"])
  })

  it("detects a pure deletion", () => {
    expect(types(lineDiff("a\nb\nc", "a\nc"))).toEqual(["s:a", "d:b", "s:c"])
  })

  it("detects a replacement as del + add", () => {
    expect(types(lineDiff("a\nOLD\nc", "a\nNEW\nc"))).toEqual(["s:a", "d:OLD", "a:NEW", "s:c"])
  })

  it("empty old -> all additions; empty new -> all deletions", () => {
    expect(types(lineDiff("", "x\ny"))).toEqual(["a:x", "a:y"])
    expect(types(lineDiff("x\ny", ""))).toEqual(["d:x", "d:y"])
  })

  it("diffStats counts adds and removes", () => {
    const d = lineDiff("a\nOLD\nc", "a\nNEW\nEXTRA\nc")
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 })
  })
})

describe("withCollapsedContext", () => {
  it("collapses a long unchanged run into a gap, keeping context around a change", () => {
    // 10 same lines, one changed line, 10 same lines.
    const same = Array.from({ length: 10 }, (_, i) => `s${i}`)
    const oldText = [...same, "OLD", ...same].join("\n")
    const newText = [...same, "NEW", ...same].join("\n")
    const rows = withCollapsedContext(lineDiff(oldText, newText), 3)
    // A gap should appear before and after the change (leading + trailing runs collapse).
    const gaps = rows.filter((r) => r.type === "gap")
    expect(gaps.length).toBe(2)
    // The changed lines survive.
    expect(rows.some((r) => r.type === "del" && "text" in r && r.text === "OLD")).toBe(true)
    expect(rows.some((r) => r.type === "add" && "text" in r && r.text === "NEW")).toBe(true)
    // Exactly 3 lines of context are kept on each side of the change (before the
    // leading gap collapses the rest, and after the trailing gap).
    const leadGap = gaps[0] as { type: "gap"; count: number }
    expect(leadGap.count).toBe(10 - 3) // 7 collapsed, 3 kept as context
  })

  it("does not collapse short unchanged runs", () => {
    const rows = withCollapsedContext(lineDiff("a\nOLD\nc", "a\nNEW\nc"), 3)
    expect(rows.some((r) => r.type === "gap")).toBe(false)
  })
})
