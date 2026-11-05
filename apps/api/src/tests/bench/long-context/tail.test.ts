// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { cutTail, lastUserIndex } from "./tail"
import type { CorpusRow } from "./types"

function row(id: string, authorType: CorpusRow["authorType"], content: string): CorpusRow {
  return {
    id,
    week: 1,
    ts: "2026-09-08T09:14:00Z",
    authorType,
    author: authorType === "user" ? "quinn" : "logistics",
    kind: "message",
    content,
  }
}

describe("the tail cut", () => {
  const rows: CorpusRow[] = [
    row("m1", "user", "x".repeat(400)),
    row("m2", "agent", "y".repeat(400)),
    row("m3", "user", "the question that matters".padEnd(400, "z")),
    row("m4", "agent", "a".repeat(400)),
    row("m5", "agent", "b".repeat(400)),
    row("m6", "system", "c".repeat(400)),
  ]

  it("never splits the last user message from the rows after it", () => {
    // A budget that only fits the last two rows still has to reach back to m3.
    const cut = cutTail(rows, 220)
    expect(cut.tail[0]?.id).toBe("m3")
    expect(cut.tail.map((r) => r.id)).toEqual(["m3", "m4", "m5", "m6"])
    expect(cut.head.map((r) => r.id)).toEqual(["m1", "m2"])
  })

  it("keeps everything when the budget fits the whole history", () => {
    const cut = cutTail(rows, 100_000)
    expect(cut.head).toHaveLength(0)
    expect(cut.tail).toHaveLength(rows.length)
  })

  it("always feeds at least the final row, however small the budget", () => {
    const cut = cutTail([row("m1", "agent", "q".repeat(4000))], 1)
    expect(cut.tail.map((r) => r.id)).toEqual(["m1"])
  })

  it("anchors at zero when no user row exists", () => {
    expect(lastUserIndex([row("m1", "agent", "a")])).toBe(0)
  })
})
