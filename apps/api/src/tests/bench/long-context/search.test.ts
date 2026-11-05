// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { Bm25Index, buildDocs } from "./bm25"
import { loadCorpus, proofRowIds } from "./corpus"
import { fuse } from "./rrf"
import type { Hit } from "./types"

const FIXTURE = join(import.meta.dir, "fixtures", "mini")

describe("BM25 over the bench documents", () => {
  const corpus = loadCorpus(FIXTURE)
  const index = new Bm25Index(buildDocs(corpus.rows))

  it.each(corpus.ledger.filter((l) => l.kind !== "throwaway").map((l) => [l.id, l] as const))(
    "%s: the planted row ranks first for its proof hint",
    (_id, item) => {
      const proof = new Set(proofRowIds(corpus.rows, item.proof_hint))
      expect(proof.size).toBeGreaterThan(0)
      const hits = index.search(item.proof_hint, 5)
      expect(hits.length).toBeGreaterThan(0)
      expect((hits[0] as Hit).rowIds.some((r) => proof.has(r))).toBe(true)
    },
  )

  it("emits a window document every third row, covering the last five", () => {
    const docs = buildDocs(corpus.rows)
    const windows = docs.filter((d) => d.docId.startsWith("win:"))
    expect(windows.length).toBe(Math.floor(corpus.rows.length / 3))
    expect((windows[1]?.rowIds ?? []).length).toBe(5)
  })
})

describe("reciprocal rank fusion", () => {
  const hit = (id: string): Hit => ({
    docId: id,
    rowIds: [id],
    score: 0,
    snippet: id,
    ts: "2026-09-08T09:14:00Z",
    author: "quinn",
  })

  it("puts a document both legs rank above one leg's leader", () => {
    const keyword = [hit("a"), hit("b"), hit("c")]
    const vector = [hit("c"), hit("b"), hit("d")]
    // b is second in both legs: 1/62 + 1/62. a is first in one: 1/61.
    // c is third then first: 1/63 + 1/61, the best total.
    expect(fuse([keyword, vector]).map((h) => h.docId)).toEqual(["c", "b", "a", "d"])
  })

  it("breaks a tie by the order the document was first seen", () => {
    const left = [hit("x")]
    const right = [hit("y")]
    expect(fuse([left, right]).map((h) => h.docId)).toEqual(["x", "y"])
  })
})
