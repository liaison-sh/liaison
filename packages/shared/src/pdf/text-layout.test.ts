// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { textWidth, wrapRuns, wrapText } from "./text-layout"

const plain = (lines: ReturnType<typeof wrapRuns>) =>
  lines.map((l) => l.map((p) => p.text).join(""))

describe("textWidth", () => {
  it("uses the bold table for bold text", () => {
    expect(textWidth("Hello", 10)).toBeCloseTo(((722 + 556 + 222 + 222 + 556) / 1000) * 10)
    expect(textWidth("Hello", 10, true)).toBeCloseTo(((722 + 556 + 278 + 278 + 611) / 1000) * 10)
  })
  it("advances CJK by one em", () => {
    expect(textWidth("日本", 10)).toBe(20)
  })
})

describe("wrapRuns", () => {
  it("matches wrapText for a single run", () => {
    const text = "The quick brown fox jumps over the lazy dog and keeps running far away"
    expect(plain(wrapRuns([{ text }], 120, 11))).toEqual(wrapText(text, 120, 11))
  })

  it("keeps a placeholder run color across a line break", () => {
    const runs = [
      { text: "Tracking number: " },
      { text: "[a very long grey placeholder label]", color: "grey" },
      { text: " thanks" },
    ]
    const lines = wrapRuns(runs, 140, 11)
    expect(lines.length).toBeGreaterThan(1)
    const greyText = lines
      .flat()
      .filter((p) => p.color === "grey")
      .map((p) => p.text)
      .join(" ")
    expect(greyText.replace(/\s+/g, " ").trim()).toBe("[a very long grey placeholder label]")
    // grey pieces appear on more than one line
    expect(lines.filter((l) => l.some((p) => p.color === "grey")).length).toBeGreaterThan(1)
    // non-grey words never pick up the color
    expect(
      lines
        .flat()
        .filter((p) => p.color === undefined)
        .map((p) => p.text)
        .join(""),
    ).toContain("thanks")
  })

  it("measures bold runs with the bold table", () => {
    const text = "WWWW iiii"
    const regular = textWidth(text, 10)
    const bold = textWidth(text, 10, true)
    expect(bold).toBeGreaterThan(regular)
    // a width between the two: the regular text fits one line, the bold text wraps
    const maxWidth = (regular + bold) / 2
    expect(wrapRuns([{ text }], maxWidth, 10)).toHaveLength(1)
    const wrapped = wrapRuns([{ text, bold: true }], maxWidth, 10)
    expect(wrapped).toHaveLength(2)
    expect(wrapped.flat().every((p) => p.bold)).toBe(true)
  })

  it("glues adjacent runs with no whitespace and keeps styles", () => {
    const lines = wrapRuns(
      [{ text: "Ref" }, { text: "[x]", color: "grey" }, { text: "." }],
      500,
      11,
    )
    expect(lines).toEqual([
      [
        { text: "Ref", color: undefined, bold: false },
        { text: "[x]", color: "grey", bold: false },
        { text: ".", color: undefined, bold: false },
      ],
    ])
  })

  it("returns one empty line for empty input and breaks a very long word", () => {
    expect(wrapRuns([], 100, 11)).toEqual([[]])
    expect(wrapRuns([{ text: "   " }], 100, 11)).toEqual([[]])
    const lines = plain(wrapRuns([{ text: "x".repeat(300) }], 100, 11))
    expect(lines.join("")).toBe("x".repeat(300))
    for (const l of lines) expect(textWidth(l, 11)).toBeLessThanOrEqual(100)
  })

  it("keeps order when a very long word follows text", () => {
    const long = "y".repeat(120)
    const lines = plain(wrapRuns([{ text: `before ${long} after` }], 100, 11))
    expect(lines[0]).toBe("before")
    expect(lines.join("").replace(/ /g, "")).toBe(`before${long}after`)
  })
})

describe("wrapText order", () => {
  it("flushes the current line before an over-wide word's chunks", () => {
    const lines = wrapText("Ref: ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJ", 60, 9, false)
    expect(lines[0]).toBe("Ref:")
    expect(lines.slice(1).join("")).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJ")
  })
})
