// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The FlexSearch implementation of `SearchIndexAdapter` (spec section 5.5).
// It is the ONLY file in the product allowed to name a FlexSearch type.
//
// DEVIATION from the blueprint, recorded here because it is a design decision
// and not an oversight. Blueprint task 10.1 says to use FlexSearch's documented
// IndexedDB persistent adapter, `index.mount(db)`. That adapter writes the
// index to IndexedDB ITSELF, in the clear. Task 10.2 requires the persisted
// index to be encrypted under the D7 key, and T-SEC-12 reads the persisted blob
// back and fails if a plaintext token survives. The two cannot both hold: a
// backend that owns its own writes cannot have its bytes sealed on the way out.
// Encryption wins, so persistence goes through `export` / `import` and this
// adapter never touches storage. The spec's own D7 derivation takes a `shardId`
// (section 3.6), which only makes sense for separately sealed shards, so the
// sharded-blob reading is the one the cryptography was designed for.
//
// The consequence, stated rather than hidden: "never load the whole index into
// memory per page load" is only partly kept. Shards are sealed and loaded
// separately, so a session loads the shards it searches, but a full-mailbox
// query does touch every shard. If that becomes the binding constraint, the
// fallback in the spec (SQLite-WASM with FTS5 over OPFS, whose pages can be
// sealed individually) is the swap this adapter interface exists to allow.
//
// Two FlexSearch caveats carried from the spec into the code: persistent
// indexes do not support `fastupdate` (this one is not persistent, and
// `fastupdate` is still off because it is incompatible with the removal traffic
// a mailbox generates), and key-lookup efficiency degrades as documents are
// deleted, so `cleanup` is a real requirement, not a tidy-up.

import { Index as FlexSearchIndex } from "flexsearch"
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

/** The shard that carries the id to envelope map, distinct from index registers. */
export const FLEXSEARCH_DOCUMENTS_SHARD_ID = "flexsearch.documents"
const CONTENT_SHARD_PREFIX = "flexsearch.content."
const METADATA_SHARD_PREFIX = "flexsearch.metadata."

/**
 * `tokenize: "strict"` and `resolution: 3` are MEASURED settings, recorded in
 * spec section 5.5 and reproducible with `measure-index-size.ts`. On an 8000
 * message corpus, "forward" (prefix) tokenization costs 6.0 index bytes per
 * text byte, which is roughly 700 MB for a 100k message mailbox and therefore
 * not shippable. "strict" costs 0.92, and 1.01 with the expanded metadata
 * tokens. Raising the resolution back to 9 costs about 3 percent more for a
 * ranking nobody sees, since the caller only ever gets ids.
 */
function newIndex(encode: (text: string) => string[]): FlexSearchIndex {
  return new FlexSearchIndex({
    tokenize: "strict",
    fastupdate: false,
    resolution: 3,
    encode,
  })
}

const newContentIndex = () => newIndex(tokenizeMailText)
const newMetadataIndex = () => newIndex(tokenizeMailMetadata)

async function exportIndex(index: FlexSearchIndex, prefix: string): Promise<IndexShard[]> {
  const shards: IndexShard[] = []
  await index.export(async (key: string, data: string) => {
    // FlexSearch hands back `undefined` for registers it has nothing in.
    if (data == null) return
    shards.push({ shardId: `${prefix}${key}`, data })
  })
  return shards
}

export function createFlexSearchIndexAdapter(): SearchIndexAdapter {
  let content = newContentIndex()
  let metadata = newMetadataIndex()
  const docs = new Map<string, IndexedDocumentMeta>()
  let mode: IndexMode = "full"

  function put(doc: MailIndexDocument): void {
    // `update` rather than `add`: re-syncing an edited message must replace it,
    // and `add` on an existing id leaves the old tokens behind.
    const write = docs.has(doc.id) ? "update" : "add"
    metadata[write](doc.id, doc.metadata)
    content[write](doc.id, doc.content)
    docs.set(doc.id, {
      accountId: doc.accountId,
      conversationId: doc.conversationId,
      sentAt: doc.sentAt,
    })
  }

  return {
    name: "flexsearch",
    mode: () => mode,
    setMode(next) {
      mode = next
    },
    async add(doc) {
      put(doc)
    },
    async addMany(list) {
      for (const doc of list) put(doc)
    },
    async remove(id) {
      metadata.remove(id)
      content.remove(id)
      docs.delete(id)
    },
    async has(id) {
      return docs.has(id)
    },
    async size() {
      return docs.size
    },
    async search(query: SearchQuery) {
      if (tokenizeMailText(query.text).length === 0) return []
      const limit = clampSearchLimit(query.limit)
      const scope =
        query.accountIds && query.accountIds.length > 0 ? new Set(query.accountIds) : null
      const seen = new Set<string>()
      const sources = mode === "full" ? [content, metadata] : [metadata]
      for (const index of sources) {
        // Over-fetch before scoping: a limit applied inside FlexSearch would be
        // spent on rows the account scope then throws away, which silently
        // truncates a scoped search.
        const raw = (await index.search(query.text, {
          limit: scope ? limit * 8 : limit,
        })) as (string | number)[]
        for (const id of raw) seen.add(String(id))
      }
      const hits = [...seen].filter((id) => {
        const meta = docs.get(id)
        if (!meta) return false
        return !scope || scope.has(meta.accountId)
      })
      hits.sort((a, b) => (docs.get(b)?.sentAt ?? "").localeCompare(docs.get(a)?.sentAt ?? ""))
      return hits.slice(0, limit)
    },
    async cleanup() {
      content.cleanup()
      metadata.cleanup()
    },
    async exportShards() {
      return [
        { shardId: FLEXSEARCH_DOCUMENTS_SHARD_ID, data: JSON.stringify([...docs]) },
        ...(await exportIndex(content, CONTENT_SHARD_PREFIX)),
        ...(await exportIndex(metadata, METADATA_SHARD_PREFIX)),
      ]
    },
    async importShards(shards) {
      for (const shard of shards) {
        if (shard.shardId === FLEXSEARCH_DOCUMENTS_SHARD_ID) {
          for (const [id, meta] of JSON.parse(shard.data) as [string, IndexedDocumentMeta][]) {
            docs.set(id, meta)
          }
        } else if (shard.shardId.startsWith(CONTENT_SHARD_PREFIX)) {
          content.import(shard.shardId.slice(CONTENT_SHARD_PREFIX.length), shard.data)
        } else if (shard.shardId.startsWith(METADATA_SHARD_PREFIX)) {
          metadata.import(shard.shardId.slice(METADATA_SHARD_PREFIX.length), shard.data)
        }
      }
    },
    async clear() {
      // A fresh pair rather than `clear()`: FlexSearch keeps its registers on a
      // cleared index, and a restore into a cleared index has merged before.
      content = newContentIndex()
      metadata = newMetadataIndex()
      docs.clear()
    },
  }
}
