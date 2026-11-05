// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The conformance suite every `SearchIndexAdapter` has to pass, written once
// and run against each implementation (blueprint task 10.1: "adapter conformance
// suite runnable against either implementation").
//
// It is exported from a plain module rather than a `.test.ts` so both adapter
// test files can call it. It asserts only what the INTERFACE promises, never a
// library detail, which is the property that makes the FlexSearch to
// SQLite-WASM swap a contained change.

import { describe, expect, it } from "vitest"
import type { MailIndexDocument, SearchIndexAdapter } from "~/modules/mailbox/search-index/adapter"

function doc(overrides: Partial<MailIndexDocument> & Pick<MailIndexDocument, "id">) {
  return {
    accountId: "acc-1",
    conversationId: "conv-1",
    sentAt: "2026-08-01T00:00:00.000Z",
    metadata: "ada@example.com grace@example.com inbox",
    content: "the quarterly numbers are attached",
    ...overrides,
  } satisfies MailIndexDocument
}

export function describeAdapterConformance(
  name: string,
  makeAdapter: () => SearchIndexAdapter,
): void {
  describe(`search index adapter conformance: ${name}`, () => {
    it("finds a document by a word from its content", async () => {
      const adapter = makeAdapter()
      await adapter.add(doc({ id: "m1", content: "the pangolin invoice is overdue" }))
      expect(await adapter.search({ text: "pangolin" })).toEqual(["m1"])
    })

    it("returns message ids only, never document content", async () => {
      const adapter = makeAdapter()
      await adapter.add(doc({ id: "m1", content: "the pangolin invoice is overdue" }))
      const hits = await adapter.search({ text: "pangolin" })
      // The interface's whole security value: a hit is an id, so nothing that
      // ever reaches a caller can carry a body or a snippet.
      for (const hit of hits) expect(typeof hit).toBe("string")
      expect(JSON.stringify(hits)).not.toContain("invoice")
    })

    it("returns nothing for a term in no document", async () => {
      const adapter = makeAdapter()
      await adapter.add(doc({ id: "m1" }))
      expect(await adapter.search({ text: "aardvark" })).toEqual([])
    })

    it("indexes many documents and reports its size", async () => {
      const adapter = makeAdapter()
      await adapter.addMany([
        doc({ id: "m1", content: "alpha shared" }),
        doc({ id: "m2", content: "beta shared" }),
        doc({ id: "m3", content: "gamma shared" }),
      ])
      expect(await adapter.size()).toBe(3)
      expect((await adapter.search({ text: "shared" })).sort()).toEqual(["m1", "m2", "m3"])
    })

    it("honours the limit", async () => {
      const adapter = makeAdapter()
      await adapter.addMany([
        doc({ id: "m1", content: "shared" }),
        doc({ id: "m2", content: "shared" }),
        doc({ id: "m3", content: "shared" }),
      ])
      expect((await adapter.search({ text: "shared", limit: 2 })).length).toBe(2)
    })

    it("scopes results to the requested accounts", async () => {
      const adapter = makeAdapter()
      await adapter.addMany([
        doc({ id: "m1", accountId: "acc-1", content: "shared" }),
        doc({ id: "m2", accountId: "acc-2", content: "shared" }),
      ])
      expect(await adapter.search({ text: "shared", accountIds: ["acc-2"] })).toEqual(["m2"])
    })

    it("removes a document", async () => {
      const adapter = makeAdapter()
      await adapter.add(doc({ id: "m1", content: "pangolin" }))
      expect(await adapter.has("m1")).toBe(true)
      await adapter.remove("m1")
      expect(await adapter.has("m1")).toBe(false)
      expect(await adapter.search({ text: "pangolin" })).toEqual([])
    })

    it("replaces a document rather than duplicating it", async () => {
      const adapter = makeAdapter()
      await adapter.add(doc({ id: "m1", content: "pangolin" }))
      await adapter.add(doc({ id: "m1", content: "aardvark" }))
      expect(await adapter.size()).toBe(1)
      expect(await adapter.search({ text: "pangolin" })).toEqual([])
      expect(await adapter.search({ text: "aardvark" })).toEqual(["m1"])
    })

    it("searches metadata in metadata-only mode and never content", async () => {
      const adapter = makeAdapter()
      await adapter.add(
        doc({ id: "m1", metadata: "ada@example.com inbox", content: "pangolin invoice" }),
      )
      adapter.setMode("metadata-only")
      expect(adapter.mode()).toBe("metadata-only")
      expect(await adapter.search({ text: "pangolin" })).toEqual([])
      expect(await adapter.search({ text: "ada@example.com" })).toEqual(["m1"])
    })

    it("round trips through exported shards", async () => {
      const adapter = makeAdapter()
      await adapter.addMany([
        doc({ id: "m1", content: "pangolin invoice" }),
        doc({ id: "m2", content: "aardvark receipt" }),
      ])
      const shards = await adapter.exportShards()
      // Non-vacuity: an adapter that exported nothing would make the restore
      // assertion below pass against an index that was never cleared.
      expect(shards.length).toBeGreaterThan(0)

      const restored = makeAdapter()
      expect(await restored.search({ text: "pangolin" })).toEqual([])
      await restored.importShards(shards)
      expect(await restored.search({ text: "pangolin" })).toEqual(["m1"])
      expect(await restored.search({ text: "aardvark" })).toEqual(["m2"])
      expect(await restored.size()).toBe(2)
    })

    it("clears everything", async () => {
      const adapter = makeAdapter()
      await adapter.addMany([doc({ id: "m1" }), doc({ id: "m2" })])
      await adapter.clear()
      expect(await adapter.size()).toBe(0)
      expect(await adapter.search({ text: "quarterly" })).toEqual([])
    })

    it("survives a cleanup pass", async () => {
      const adapter = makeAdapter()
      await adapter.addMany([doc({ id: "m1", content: "pangolin" }), doc({ id: "m2" })])
      await adapter.remove("m2")
      await adapter.cleanup()
      expect(await adapter.search({ text: "pangolin" })).toEqual(["m1"])
      expect(await adapter.size()).toBe(1)
    })
  })
}
