// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The no dash punctuation rule itself, over the shapes that actually turn up in
// release notes. The gate lints the notes a customer reads in the update
// prompt, so what matters is the DASH USED AS PUNCTUATION, in every spelling
// somebody reaches for: the em dash, the en dash, the double hyphen, and the
// spaced hyphen a writer types when the keyboard has no em dash.
//
// The two shapes that must keep passing are the ones the rule is not about: a
// hyphen inside a compound word and a hyphen inside a range. A rule that
// refuses "single-build" or "1-8" is a rule a release engineer deletes.
import { describe, expect, it } from "bun:test"
import { assertNoDashPunctuation, findDashPunctuation } from "./no-dash"

function offends(text: string): boolean {
  return findDashPunctuation(text).length > 0
}

describe("the no dash punctuation rule", () => {
  it("refuses an em dash, an en dash and a double hyphen", () => {
    expect(offends("The update installs itself — quietly.")).toBe(true)
    expect(offends("Sessions 1–5 are restored.")).toBe(true)
    expect(offends("One thing changed -- and another.")).toBe(true)
  })

  it("refuses a spaced hyphen, which is the same punctuation typed differently", () => {
    // The spelling a writer reaches for when the keyboard has no em dash. It
    // reads to a customer exactly like one, so the rule that refuses the em
    // dash has to refuse this too.
    expect(offends("The update installs itself - quietly.")).toBe(true)
    expect(offends("- Fixed a crash - the window now opens.")).toBe(true)
  })

  it("allows a compound and a range, which are not punctuation", () => {
    expect(offends("A single-build release.")).toBe(false)
    expect(offends("Sessions 1-8 are restored.")).toBe(false)
    expect(offends("The auto-update path is faster.")).toBe(false)
  })

  it("allows a list marker, at the start of a line and indented under one", () => {
    // A markdown bullet is a spaced hyphen at the start of a line, and the
    // template ships nested ones. A rule that refuses them refuses the
    // template it exists to protect.
    expect(offends("- One line per change.\n  - A nested detail.\n")).toBe(false)
  })

  it("names the offending line when it throws", () => {
    expect(() => assertNoDashPunctuation("fine\nnot - fine\n", "the release notes")).toThrow(
      "line 2",
    )
  })
})
