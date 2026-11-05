// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ONE interface every caller of the client search index sees.
//
// Why an adapter at all (spec section 5.5): FlexSearch is effectively a
// single-maintainer project, its persistent indexes do not support
// `fastupdate`, and its key-lookup efficiency degrades as documents are
// deleted, which a mailbox does constantly. The documented fallback is
// SQLite-WASM with FTS5 over OPFS. Neither of those swaps may reach a caller,
// so nothing outside `*-adapter.ts` may name a library type.
//
// Two properties of this interface are security properties, not conveniences:
//
//   1. `search` returns message IDS. Never a snippet, never a body, never a
//      score carrying text. What a caller cannot hold, it cannot leak into a
//      tool result or an HTTP body (spec section 5.5, plan task 10.5).
//   2. `exportShards` returns PLAINTEXT shards, and says so in its name. The
//      caller seals every shard before it touches disk (task 10.2). No adapter
//      writes to storage itself, which is exactly why FlexSearch's own
//      `index.mount(db)` persistence is NOT used: it would write an unencrypted
//      index to IndexedDB, and T-SEC-12 exists to forbid that.

/** What a shard is keyed by, and therefore what the D7 index key binds. */
export type ShardId = string

/**
 * One indexable message.
 *
 * `metadata` is the half that stays searchable when the index degrades: it is
 * cleartext on the server anyway by spec section 2.1 (correspondents, labels,
 * attachment filenames, dates). `content` is the half that only exists after a
 * decrypt, which is why losing it degrades search rather than breaking it.
 */
export interface MailIndexDocument {
  id: string
  accountId: string
  conversationId: string
  /** ISO 8601. Used to pick the window when the index is reduced. */
  sentAt: string
  metadata: string
  content: string
}

/** Full indexes both halves. Metadata-only has no decrypted text in it at all. */
export type IndexMode = "full" | "metadata-only"

export interface SearchQuery {
  text: string
  limit?: number
  /** Scope the result to these accounts. Empty or absent means every account. */
  accountIds?: readonly string[]
}

/** A serialized piece of the index, in the clear. The caller seals it. */
export interface IndexShard {
  shardId: ShardId
  data: string
}

export interface SearchIndexAdapter {
  /** Names the implementation, for the banner and for the ledger. */
  readonly name: string
  mode(): IndexMode
  setMode(mode: IndexMode): void
  add(doc: MailIndexDocument): Promise<void>
  addMany(docs: readonly MailIndexDocument[]): Promise<void>
  remove(id: string): Promise<void>
  has(id: string): Promise<boolean>
  size(): Promise<number>
  /** Message ids, most relevant first, capped by `limit`. */
  search(query: SearchQuery): Promise<string[]>
  /**
   * Periodic maintenance. FlexSearch's key-lookup efficiency degrades as
   * documents are deleted; a mailbox deletes and re-syncs constantly, so this
   * is a requirement rather than a tidy-up (spec section 5.5).
   */
  cleanup(): Promise<void>
  exportShards(): Promise<IndexShard[]>
  importShards(shards: readonly IndexShard[]): Promise<void>
  clear(): Promise<void>
}

/** The default result cap. A caller may ask for less, never for more. */
export const SEARCH_RESULT_LIMIT_DEFAULT = 50
export const SEARCH_RESULT_LIMIT_MAX = 200

export function clampSearchLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return SEARCH_RESULT_LIMIT_DEFAULT
  return Math.min(SEARCH_RESULT_LIMIT_MAX, Math.max(1, Math.floor(limit)))
}

/**
 * The tokenizer both adapters agree on for the fields THIS product indexes.
 * `@`, `.`, `-` and `_` stay inside a token so an address is one token: mail
 * search is mostly people, and splitting `ada@example.com` into three tokens
 * makes every address on the same domain a hit.
 */
export function tokenizeMailText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/)
    .map((token) => token.replace(/^[._-]+|[._-]+$/g, ""))
    .filter((token) => token.length > 0)
}

/**
 * Metadata tokens, expanded.
 *
 * MEASURED DECISION, not taste. Prefix ("forward") tokenization costs 6.0
 * index bytes per text byte on the corpus in `measure-index-size.ts`, and the
 * cost is worst exactly on long tokens, which is what an email address is. So
 * the indexes are exact-token ("strict"), and the prefix behaviour a person
 * actually wants from an address, typing "ada" and finding
 * "ada@example.com", is bought instead by ALSO emitting the address's parts as
 * their own tokens. That reads the same to a user and costs 0.09 index bytes
 * per text byte rather than 5.1.
 */
export function tokenizeMailMetadata(value: string): string[] {
  const tokens = new Set<string>()
  for (const token of tokenizeMailText(value)) {
    tokens.add(token)
    for (const part of token.split(/[@._-]+/)) {
      if (part.length > 1) tokens.add(part)
    }
  }
  return [...tokens]
}

/** The document fields an id lookup needs after a restore. */
export interface IndexedDocumentMeta {
  accountId: string
  conversationId: string
  sentAt: string
}
