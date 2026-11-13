// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The local Knowledge search narrows to Knowledge in the engine and pages
 * through the read guard: what the guard drops is never returned or counted,
 * a dropped page costs a page (bounded), never the answer.
 */
import { describe, expect, it, mock } from "bun:test"
import {
  type IndexedKnowledgeHit,
  MAX_PAGES,
  PAGE_SIZE,
  searchLocalKnowledge,
} from "~/apps/knowledge/local-search"
import type { KnowledgeActor } from "~/apps/knowledge/service"
import type { ScopedEntitySearchParams, SearchResponseEntity } from "~/modules/search/service"

const actor: KnowledgeActor = {
  orgId: "org-1",
  userId: "user-1",
  scopes: ["knowledge:documents:read"],
  dimensionGrants: {},
  roles: ["role-1"],
}

const doc = (n: number): SearchResponseEntity => ({
  id: `doc-${n}`,
  app: "knowledge",
  entityType: "document",
  label: `Doc ${n}`,
  title: `Doc ${n}`,
})

/** An index of `total` ranked documents, answered page by page. */
function index(total: number) {
  const all = Array.from({ length: total }, (_, i) => doc(i))
  return mock(async (p: ScopedEntitySearchParams) =>
    all.slice(p.offset ?? 0, (p.offset ?? 0) + p.limit),
  )
}

const keepAll = async (hits: IndexedKnowledgeHit[]) => hits

describe("searchLocalKnowledge", () => {
  it("asks the engine for Knowledge documents and source links only, as the actor", async () => {
    const search = index(3)
    await searchLocalKnowledge({ actor, q: "erae", limit: 20, keep: keepAll, search })
    const p = search.mock.calls[0]![0]
    expect(p.app).toEqual(["knowledge"])
    expect(p.entityType).toEqual(["document", "source_link"])
    expect(p).toMatchObject({ orgId: "org-1", userId: "user-1", roleIds: ["role-1"], q: "erae" })
  })

  it("one short page answers at once, ranked from 1", async () => {
    const search = index(3)
    const hits = await searchLocalKnowledge({ actor, q: "x", limit: 20, keep: keepAll, search })
    expect(search).toHaveBeenCalledTimes(1)
    expect(hits.map((h) => [h.sourceEntityId, h.sourceRank])).toEqual([
      ["doc-0", 1],
      ["doc-1", 2],
      ["doc-2", 3],
    ])
  })

  it("reads the next page when the guard dropped hits, and never returns a dropped one", async () => {
    const search = index(PAGE_SIZE * 3)
    // The reader may open only every 25th document.
    const keep = mock(async (hits: IndexedKnowledgeHit[]) =>
      hits.filter((h) => Number(h.sourceEntityId.slice(4)) % 25 === 0),
    )
    const hits = await searchLocalKnowledge({ actor, q: "x", limit: 5, keep, search })
    expect(hits.map((h) => h.sourceEntityId)).toEqual([
      "doc-0",
      "doc-25",
      "doc-50",
      "doc-75",
      "doc-100",
    ])
    expect(search).toHaveBeenCalledTimes(3)
    expect(search.mock.calls.map((c) => c[0].offset)).toEqual([0, PAGE_SIZE, PAGE_SIZE * 2])
  })

  it("stops after MAX_PAGES even when the guard keeps nothing", async () => {
    const search = index(PAGE_SIZE * (MAX_PAGES + 5))
    const hits = await searchLocalKnowledge({
      actor,
      q: "x",
      limit: 20,
      keep: async () => [],
      search,
    })
    expect(hits).toEqual([])
    expect(search).toHaveBeenCalledTimes(MAX_PAGES)
  })

  it("stops when the limit is reached and trims to it", async () => {
    const search = index(PAGE_SIZE * 4)
    const hits = await searchLocalKnowledge({ actor, q: "x", limit: 7, keep: keepAll, search })
    expect(hits).toHaveLength(7)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it("drops any hit outside Knowledge documents and source links the engine might return", async () => {
    const search = mock(async () => [
      { ...doc(1), app: "mail", entityType: "conversation" },
      doc(2),
      { ...doc(3), entityType: "collection" },
    ])
    const keep = mock(keepAll)
    const hits = await searchLocalKnowledge({ actor, q: "x", limit: 20, keep, search })
    expect(hits.map((h) => h.sourceEntityId)).toEqual(["doc-2"])
    expect(keep.mock.calls[0]![0].map((h) => h.sourceEntityId)).toEqual(["doc-2"])
  })
})
