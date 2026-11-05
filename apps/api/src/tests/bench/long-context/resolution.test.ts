// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  followingRows,
  isStatusQuestion,
  mentionsStatus,
  preferResolved,
  renderResolutionRecall,
  withFollows,
} from "./resolution"
import { buildStrategies } from "./strategies"
import { estimateTokens } from "./tokens"
import type { CorpusRow, Hit } from "./types"

function row(id: string, content: string, minute: number): CorpusRow {
  return {
    id,
    week: 1,
    ts: `2026-09-08T09:${String(minute).padStart(2, "0")}:00Z`,
    authorType: minute % 2 === 0 ? "user" : "agent",
    author: minute % 2 === 0 ? "quinn" : "logistics",
    kind: "message",
    content,
  }
}

const rows: CorpusRow[] = [
  row("m1", "I promised Sonovox in Lyon a call back on Friday about the backorder", 1),
  row("m2", "On the list: call Sonovox on Friday", 2),
  row("m3", "Called Sonovox, the backorder is confirmed for next week", 3),
  row("m4", "Good, mark it done", 4),
  row("m5", "unrelated chatter about foam inserts", 5),
  row("m6", "the Berlin pallet weighs 118 kg", 6),
  row("m7", "we opened claim CL-4471 for the crushed cartons", 7),
  row("m8", "the carrier has not answered, chasing them tomorrow", 8),
]

function hit(docId: string, rowIds: string[], minute: number): Hit {
  return {
    docId,
    rowIds,
    score: 1,
    snippet: rowIds.map((id) => rows.find((r) => r.id === id)?.content ?? "").join(" "),
    ts: `2026-09-08T09:${String(minute).padStart(2, "0")}:00Z`,
    author: "quinn",
  }
}

describe("following rows", () => {
  it("carries the rows after the hit and skips what the tail already has", () => {
    const follows = followingRows({
      rows,
      hit: hit("m1", ["m1"], 1),
      exclude: new Set(["m3"]),
    })
    expect(follows.map((r) => r.id)).toEqual(["m2", "m4", "m5", "m6"])
  })

  it("follows on from the END of a window document, never from its start", () => {
    const follows = followingRows({ rows, hit: hit("win:m3", ["m1", "m2", "m3"], 3), count: 2 })
    expect(follows.map((r) => r.id)).toEqual(["m4", "m5"])
  })

  it("returns nothing when the hit is the last row", () => {
    expect(followingRows({ rows, hit: hit("m8", ["m8"], 8) })).toEqual([])
  })
})

describe("the S12 recall block", () => {
  const tailIds = new Set(["m5", "m6"])

  it("renders what followed and never repeats a row the tail already carries", () => {
    const entries = withFollows({ rows, hits: [hit("m1", ["m1"], 1)], exclude: tailIds })
    const block = renderResolutionRecall({ entries })
    expect(block).toContain("what followed:")
    expect(block).toContain("Called Sonovox, the backorder is confirmed")
    expect(block).toContain("[m2 ")
    // m5 and m6 are in the tail: they are never duplicated into the recall.
    expect(block).not.toContain("foam inserts")
    expect(block).not.toContain("118 kg")
  })

  it("drops the oldest hit first to stay under the cap", () => {
    const entries = withFollows({
      rows,
      hits: [hit("m7", ["m7"], 7), hit("m1", ["m1"], 1)],
    })
    const capped = renderResolutionRecall({ entries, cap: 40 })
    expect(estimateTokens(capped)).toBeLessThanOrEqual(60)
    expect(capped).toContain("CL-4471")
    expect(capped).not.toContain("Sonovox in Lyon a call back")
  })
})

describe("the status word preference", () => {
  it("reorders a fixed hit list so a resolved loop comes first", () => {
    const entries = withFollows({
      rows,
      hits: [hit("m6", ["m6"], 6), hit("m1", ["m1"], 1), hit("m5", ["m5"], 5)],
    })
    expect(entries.map((e) => e.hit.docId)).toEqual(["m6", "m1", "m5"])
    const ordered = preferResolved(entries, "did we ever call the Lyon dealer back?")
    // m1's follow ups say "confirmed" and "done"; m6's and m5's say nothing.
    expect(ordered.map((e) => e.hit.docId)).toEqual(["m1", "m6", "m5"])
  })

  it("leaves the ranking alone when the question is not about status", () => {
    const entries = withFollows({ rows, hits: [hit("m6", ["m6"], 6), hit("m1", ["m1"], 1)] })
    const ordered = preferResolved(entries, "what pallet size do we use now?")
    expect(ordered.map((e) => e.hit.docId)).toEqual(["m6", "m1"])
  })

  it("counts an explicit still open as a status word", () => {
    expect(mentionsStatus("the claim is still open with the carrier")).toBe(true)
    expect(mentionsStatus("the Berlin pallet weighs 118 kg")).toBe(false)
  })

  it("knows a status question from a plain one", () => {
    expect(isStatusQuestion("is the claim still open?")).toBe(true)
    expect(isStatusQuestion("Did we send the pallet yet")).toBe(true)
    expect(isStatusQuestion("what is our DHL account number?")).toBe(true)
    expect(isStatusQuestion("which carrier do we use for Munich")).toBe(false)
  })
})

describe("the composite roster", () => {
  it("carries S11 and S12 alongside everything measured so far", () => {
    const ids = buildStrategies({ embeddingApiKey: null }).map((s) => s.id)
    expect(ids).toEqual([
      "S0",
      "S1",
      "S2",
      "S3",
      "S4",
      "S5",
      "S6",
      "S7",
      "S8",
      "S9",
      "S10",
      "S11",
      "S12",
    ])
  })
})
