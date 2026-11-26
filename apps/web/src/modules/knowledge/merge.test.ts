// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { blocksOf, mergeBodies, mergeTexts, mergeTitles } from "./merge"

const base = ["# Plan", "", "Intro", "", "- one", "- two", "", "Outro"].join("\n")
const edit = (from: string, to: string, text = base) => text.replace(from, to)

describe("mergeBodies", () => {
  it("keeps both edits when they touch different blocks", () => {
    const mine = edit("Intro", "Intro, edited")
    const theirs = edit("Outro", "Outro, edited")
    expect(mergeBodies(base, mine, theirs)).toBe(edit("Outro", "Outro, edited", mine))
  })

  it("keeps edits of two neighbouring list items", () => {
    const mine = edit("- one", "- one!")
    const theirs = edit("- two", "- two!")
    expect(mergeBodies(base, mine, theirs)).toBe(edit("- two", "- two!", mine))
  })

  it("refuses two different changes of the same block", () => {
    expect(mergeBodies(base, edit("Intro", "Mine"), edit("Intro", "Theirs"))).toBeNull()
  })

  it("refuses an edit of a block the other side deleted", () => {
    expect(mergeBodies(base, edit("Intro", "Mine"), edit("Intro\n\n", ""))).toBeNull()
  })

  it("takes the same change made on both sides once", () => {
    const both = edit("Intro", "Same")
    expect(mergeBodies(base, both, both)).toBe(both)
  })

  it("keeps two paragraphs added at the same place, theirs first", () => {
    const mine = `${base}\n\nMine`
    const theirs = `${base}\n\nTheirs`
    expect(mergeBodies(base, mine, theirs)).toBe(`${base}\n\nTheirs\n\nMine`)
  })

  it("keeps a deletion on one side with an edit elsewhere on the other", () => {
    const mine = edit("- two\n", "")
    const theirs = edit("# Plan", "# Plan v2")
    expect(mergeBodies(base, mine, theirs)).toBe(edit("# Plan", "# Plan v2", mine))
  })

  it("never loses a block: every line of both edits is in the merge", () => {
    const mine = edit("Intro", "Intro A").concat("\n\nEnd A")
    const theirs = edit("# Plan", "# Plan B")
    const merged = mergeBodies(base, mine, theirs)!
    for (const line of [...mine.split("\n"), ...theirs.split("\n")].filter(
      (l) => l && l !== "Intro" && l !== "# Plan",
    ))
      expect(merged.split("\n")).toContain(line)
  })

  it("treats a fenced code block as one block", () => {
    expect(blocksOf("a\n```\nx\n\ny\n```\nb")).toEqual(["a", "```\nx\n\ny\n```", "b"])
    const codeBase = "Intro\n\n```\nlet a = 1\n```\n\nOutro"
    const mine = codeBase.replace("let a = 1", "let a = 2")
    // A line added in the same code block: the block changed on both sides.
    const theirs = codeBase.replace("let a = 1", "let a = 1\nlet b = 3")
    expect(mergeBodies(codeBase, mine, theirs)).toBeNull()
  })
})

describe("mergeTitles / mergeTexts", () => {
  it("keeps one side's rename, refuses two different ones", () => {
    expect(mergeTitles("A", "A", "B")).toBe("B")
    expect(mergeTitles("A", "C", "A")).toBe("C")
    expect(mergeTitles("A", "C", "B")).toBeNull()
  })

  it("merges the title and the text together", () => {
    expect(
      mergeTexts(
        { title: "T", body: base },
        { title: "T2", body: edit("Intro", "I") },
        { title: "T", body: edit("Outro", "O") },
      ),
    ).toEqual({ title: "T2", body: edit("Outro", "O", edit("Intro", "I")) })
  })
})
