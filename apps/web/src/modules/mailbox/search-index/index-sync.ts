// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Building and maintaining the client index (blueprint task 10.3, spec 5.5).
//
// Three properties, all of them things a naive loop gets wrong:
//
//   * RESUMABLE. The cursor is persisted after every page, alongside the index
//     shards themselves, so a closed tab costs one page and not the whole
//     mailbox. A first build on a real account is minutes of decryption.
//   * YIELDING. The loop awaits a yield between pages. Without it the tab is
//     unresponsive for the duration, which on a first build reads as a hang.
//   * HONEST. If the mailbox locks part way through, the sync STOPS and says
//     so. It never marks itself complete over a partial index: a search against
//     a silently partial index answers "no matches" for mail that is sitting
//     right there, and the user has no way to tell the two apart.

import type { OpenedMessage, SealedMessagePayload } from "~/modules/mailbox/crypto-protocol"
import type { MailIndexDocument, SearchIndexAdapter } from "~/modules/mailbox/search-index/adapter"
import type { IndexBlobStore } from "~/modules/mailbox/search-index/index-blob-store"
import {
  loadIndexCursor,
  persistIndex,
  type ShardSealer,
  saveIndexCursor,
} from "~/modules/mailbox/search-index/index-persistence"

/** The cleartext half of a message, by spec section 2.1. */
export interface IndexEnvelope {
  accountId: string
  conversationId: string
  sentAt: string
  /** Correspondents, labels and attachment filenames, already flattened. */
  metadata: string
}

export interface IndexSyncItem {
  sealed: SealedMessagePayload
  envelope: IndexEnvelope
}

export interface IndexSyncPage {
  /** The monotonic change cursor AFTER this page. */
  cursor: string
  done: boolean
  items: IndexSyncItem[]
  /** Total messages behind the cursor, when the server can say. */
  total?: number
}

export interface IndexSyncSource {
  fetchPage(cursor: string | null, limit: number): Promise<IndexSyncPage>
}

export type IndexSyncPhase = "building" | "incremental" | "done"

export interface IndexSyncProgress {
  indexed: number
  total: number | null
  cursor: string | null
  phase: IndexSyncPhase
}

export type IndexSyncStop = "aborted" | "locked"

export interface IndexSyncResult {
  indexed: number
  cursor: string | null
  completed: boolean
  stoppedBecause?: IndexSyncStop
}

export interface IndexSyncInput {
  adapter: SearchIndexAdapter
  store: IndexBlobStore
  sealer: ShardSealer
  source: IndexSyncSource
  /** Returns null when the mailbox is locked, per `openSealedMessage`. */
  open(sealed: SealedMessagePayload): Promise<OpenedMessage | null>
  pageSize?: number
  onProgress?(progress: IndexSyncProgress): void
  yieldToMainThread?(): Promise<void>
  signal?: AbortSignal
}

const DEFAULT_PAGE_SIZE = 50

/**
 * `scheduler.yield` where the browser has it, a macrotask otherwise. A
 * microtask is NOT a yield: it runs before the next paint and leaves the tab
 * just as frozen.
 */
function defaultYield(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (scheduler?.yield) return scheduler.yield()
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * The indexed text of one message. Subject and body are the decrypted half;
 * `metadata` stays searchable when the index degrades to metadata only.
 */
function toDocument(item: IndexSyncItem, opened: OpenedMessage): MailIndexDocument {
  return {
    id: item.sealed.id,
    accountId: item.envelope.accountId,
    conversationId: item.envelope.conversationId,
    sentAt: item.envelope.sentAt,
    metadata: item.envelope.metadata,
    content: [opened.subject, opened.textBody, opened.snippet].filter(Boolean).join(" \n"),
  }
}

export async function syncSearchIndex(input: IndexSyncInput): Promise<IndexSyncResult> {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE
  const yieldNow = input.yieldToMainThread ?? defaultYield
  let cursor = await loadIndexCursor({ store: input.store, sealer: input.sealer })
  const phase: IndexSyncPhase = cursor ? "incremental" : "building"
  let indexed = 0
  let total: number | null = null

  for (;;) {
    if (input.signal?.aborted) {
      return { indexed, cursor, completed: false, stoppedBecause: "aborted" }
    }
    const page = await input.source.fetchPage(cursor, pageSize)
    if (page.total != null) total = page.total

    const documents: MailIndexDocument[] = []
    for (const item of page.items) {
      const opened = await input.open(item.sealed)
      if (!opened) {
        // Persist what did open, so the next unlock resumes from here rather
        // than re-decrypting this page.
        await commit(input, documents, cursor)
        return {
          indexed: indexed + documents.length,
          cursor,
          completed: false,
          stoppedBecause: "locked",
        }
      }
      documents.push(toDocument(item, opened))
    }

    if (documents.length > 0) {
      cursor = page.cursor
      await commit(input, documents, cursor)
      indexed += documents.length
    }

    input.onProgress?.({ indexed, total, cursor, phase: page.done ? "done" : phase })
    if (page.done) return { indexed, cursor, completed: true }
    if (page.items.length === 0) {
      // A source that returns nothing and is not done would spin forever.
      return { indexed, cursor, completed: false, stoppedBecause: "aborted" }
    }
    await yieldNow()
  }
}

/** Index, seal, store, then move the cursor. The cursor moves LAST on purpose:
 * a crash between the two re-indexes a page, which is idempotent, while the
 * other order would skip one. */
async function commit(
  input: IndexSyncInput,
  documents: readonly MailIndexDocument[],
  cursor: string | null,
): Promise<void> {
  if (documents.length > 0) await input.adapter.addMany(documents)
  await persistIndex({ adapter: input.adapter, store: input.store, sealer: input.sealer })
  if (cursor) await saveIndexCursor({ store: input.store, sealer: input.sealer, cursor })
}
