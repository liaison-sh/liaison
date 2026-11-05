// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dependency-free `SearchIndexAdapter`. It exists for two reasons, both of
// them load bearing rather than convenience:
//
//   * It is the SECOND implementation the conformance suite runs against, which
//     is the only way to know the interface actually contains the library swap
//     the spec reserves the right to make.
//   * It is the fallback when the real backend cannot start (an old browser, a
//     corrupted shard set). A degraded search is a stated outcome in this
//     design; a search box that throws is not.
//
// It holds everything in memory, so the caller is responsible for sealing and
// persisting its shards exactly as it is for the FlexSearch one.

import {
  clampSearchLimit,
  type IndexedDocumentMeta,
  type IndexMode,
  type IndexShard,
  type MailIndexDocument,
  type SearchIndexAdapter,
  type SearchQuery,
  tokenizeMailMetadata,
  tokenizeMailText,
} from "~/modules/mailbox/search-index/adapter"

interface StoredDocument extends IndexedDocumentMeta {
  metadataTokens: string[]
  contentTokens: string[]
}

/** The one shard this implementation emits. Named, so a restore can check it. */
export const MEMORY_SHARD_ID = "memory.documents"

export function createMemorySearchIndexAdapter(): SearchIndexAdapter {
  const docs = new Map<string, StoredDocument>()
  let mode: IndexMode = "full"

  function store(doc: MailIndexDocument): void {
    docs.set(doc.id, {
      accountId: doc.accountId,
      conversationId: doc.conversationId,
      sentAt: doc.sentAt,
      metadataTokens: tokenizeMailMetadata(doc.metadata),
      contentTokens: tokenizeMailText(doc.content),
    })
  }

  function matches(stored: StoredDocument, terms: string[]): boolean {
    const haystack =
      mode === "full" ? [...stored.metadataTokens, ...stored.contentTokens] : stored.metadataTokens
    // Exact tokens, matching the FlexSearch adapter's measured `strict`
    // setting, so the two implementations answer the same query the same way.
    // AND rather than OR: a two-word query that returned the union would
    // drown the real hit.
    const tokens = new Set(haystack)
    return terms.every((term) => tokens.has(term))
  }

  return {
    name: "memory",
    mode: () => mode,
    setMode(next) {
      mode = next
    },
    async add(doc) {
      store(doc)
    },
    async addMany(list) {
      for (const doc of list) store(doc)
    },
    async remove(id) {
      docs.delete(id)
    },
    async has(id) {
      return docs.has(id)
    },
    async size() {
      return docs.size
    },
    async search(query: SearchQuery) {
      const terms = tokenizeMailText(query.text)
      if (terms.length === 0) return []
      const scope =
        query.accountIds && query.accountIds.length > 0 ? new Set(query.accountIds) : null
      const hits: string[] = []
      for (const [id, stored] of docs) {
        if (scope && !scope.has(stored.accountId)) continue
        if (matches(stored, terms)) hits.push(id)
      }
      // Newest first: a mailbox search almost always wants the recent one.
      hits.sort((a, b) => (docs.get(b)?.sentAt ?? "").localeCompare(docs.get(a)?.sentAt ?? ""))
      return hits.slice(0, clampSearchLimit(query.limit))
    },
    async cleanup() {
      // Nothing to compact: deletion is exact here.
    },
    async exportShards(): Promise<IndexShard[]> {
      return [{ shardId: MEMORY_SHARD_ID, data: JSON.stringify([...docs]) }]
    },
    async importShards(shards) {
      for (const shard of shards) {
        if (shard.shardId !== MEMORY_SHARD_ID) continue
        const parsed = JSON.parse(shard.data) as [string, StoredDocument][]
        for (const [id, doc] of parsed) docs.set(id, doc)
      }
    },
    async clear() {
      docs.clear()
    },
  }
}
