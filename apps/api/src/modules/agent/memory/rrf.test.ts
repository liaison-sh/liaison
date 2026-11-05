// SPDX-License-Identifier: FSL-1.1-ALv2
// P4c-T48: reciprocal rank fusion, moved from the long-context bench.
import { describe, expect, it } from "bun:test"
import { cosine, fuse, MMR_LAMBDA, mmr, RRF_K } from "~/modules/agent/memory/rrf"

interface Doc {
  docId: string
}

const d = (docId: string): Doc => ({ docId })

describe("rrf", () => {
  it("scores a document by the sum of 1/(k + rank) over the legs it appears in", () => {
    const fused = fuse<Doc>([[d("a"), d("b")], [d("b")]])
    const byId = new Map(fused.map((h) => [h.docId, h.score]))
    expect(byId.get("a")).toBeCloseTo(1 / (RRF_K + 1), 12)
    expect(byId.get("b")).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 12)
  })

  it("ranks a document two legs agree on above one leg's top hit", () => {
    const fused = fuse<Doc>([
      [d("top-of-one-leg"), d("agreed")],
      [d("other"), d("agreed")],
    ])
    expect(fused[0]?.docId).toBe("agreed")
  })

  it("uses k = 60", () => {
    expect(RRF_K).toBe(60)
  })

  it("breaks an equal score by first seen order, keeping the fusion stable", () => {
    const fused = fuse<Doc>([[d("first")], [d("second")]])
    expect(fused.map((h) => h.docId)).toEqual(["first", "second"])
  })

  it("accepts a caller's tie break", () => {
    const fused = fuse<Doc>([[d("zebra")], [d("apple")]], {
      tieBreak: (a, b) => a.docId.localeCompare(b.docId),
    })
    expect(fused.map((h) => h.docId)).toEqual(["apple", "zebra"])
  })

  it("keeps the payload of the first leg that carried the document", () => {
    const rich = { docId: "a", snippet: "kept" }
    const poor = { docId: "a", snippet: "dropped" }
    expect(fuse([[rich], [poor]])[0]?.snippet).toBe("kept")
  })

  it("fuses nothing to nothing", () => {
    expect(fuse<Doc>([[], []])).toEqual([])
  })
})

describe("cosine", () => {
  it("is 1 for a vector against itself and 0 against an orthogonal one", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 12)
  })

  it("is 0, never NaN, for a zero vector", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })
})

describe("mmr", () => {
  const vectors: Record<string, number[]> = {
    a: [1, 0, 0, 0],
    // A near copy of `a`: relevant, but it adds nothing once `a` is picked.
    aCopy: [0.999, 0.01, 0, 0],
    b: [0, 1, 0, 0],
    c: [0, 0, 1, 0],
    dd: [0, 0, 0, 1],
  }
  const ranked = ["a", "aCopy", "b", "c", "dd"]

  it("keeps lambda at 0.7", () => {
    expect(MMR_LAMBDA).toBe(0.7)
  })

  it("prefers a different document over a near copy of one already picked", () => {
    const picked = mmr(ranked, (id) => vectors[id], 2)
    expect(picked).toEqual(["a", "b"])
  })

  it("falls back to plain ranking when nothing has a vector", () => {
    expect(mmr(ranked, () => null, 3)).toEqual(["a", "aCopy", "b"])
  })

  it("never returns more than the limit or more than it was given", () => {
    expect(mmr(["a", "b"], (id) => vectors[id], 5)).toHaveLength(2)
    expect(mmr(ranked, (id) => vectors[id], 1)).toHaveLength(1)
  })
})
