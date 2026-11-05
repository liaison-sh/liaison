// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where the client search index is actually built (blueprint tasks 10.3-10.5).
//
// Phase 10 built every piece of this and left the assembly to a caller that did
// not exist, so the index was never built and search over an encrypted mailbox
// returned nothing at all: the server index is deliberately empty for sealed
// conversations, and an unbuilt client index answers "no matches" to every
// question. That is the one answer this design may not give by accident.
//
// SERVER DEPENDENCY, and the reason for the `unavailable` state. The sealed
// listing this reads, `GET /api/mailbox/sync-cursor`, is the route blueprint
// task 10.3 specifies. Where it is not deployed, the build stops and the mail
// surface SAYS search is unavailable. It never falls back to an empty index
// presented as a complete answer.

import type { OpenedMessage, SealedMessagePayload } from "~/modules/mailbox/crypto-protocol"
import type { MailboxApi } from "~/modules/mailbox/mailbox-api"
import type { SearchIndexAdapter } from "~/modules/mailbox/search-index/adapter"
import { createFlexSearchIndexAdapter } from "~/modules/mailbox/search-index/flexsearch-adapter"
import {
  createIndexedDbBlobStore,
  type IndexBlobStore,
} from "~/modules/mailbox/search-index/index-blob-store"
import type { ShardSealer } from "~/modules/mailbox/search-index/index-persistence"
import type { IndexSyncPage, IndexSyncSource } from "~/modules/mailbox/search-index/index-sync"
import { estimateIndexStorage } from "~/modules/mailbox/search-index/quota"
import {
  type SearchIndexOutcome,
  startSearchIndex,
} from "~/modules/mailbox/search-index/search-index-controller"
import { reportIndexUnavailable } from "~/modules/mailbox/search-index/search-index-store"

/** The route blueprint task 10.3 names. Kept in one place so the client half
 *  and the server half cannot drift apart quietly. */
export const MAILBOX_SEALED_LISTING_PATH = "/mailbox/sync-cursor"

let adapter: SearchIndexAdapter | null = null
let running: Promise<SearchIndexOutcome | null> | null = null
let abort: AbortController | null = null

/** The adapter the client search responder answers from, or null when no index
 *  has been built in this tab. Null means "cannot answer", never "no hits". */
export function liveSearchIndexAdapter(): SearchIndexAdapter | null {
  return adapter
}

function readPage(value: unknown): IndexSyncPage | null {
  if (!value || typeof value !== "object") return null
  const page = value as Record<string, unknown>
  if (typeof page.cursor !== "string" || typeof page.done !== "boolean") return null
  if (!Array.isArray(page.items)) return null
  return {
    cursor: page.cursor,
    done: page.done,
    items: page.items as IndexSyncPage["items"],
    ...(typeof page.total === "number" ? { total: page.total } : {}),
  }
}

/** The sealed listing, as `index-sync` consumes it. */
export function createSealedListingSource(api: MailboxApi): IndexSyncSource {
  return {
    async fetchPage(cursor, limit) {
      const params = new URLSearchParams({ limit: String(limit) })
      if (cursor) params.set("cursor", cursor)
      const page = readPage(await api.get(`${MAILBOX_SEALED_LISTING_PATH}?${params.toString()}`))
      if (!page) throw new Error("the sealed message listing answered in a shape this cannot read")
      return page
    },
  }
}

export interface MailboxSearchIndexHostDeps {
  api: MailboxApi
  sealer: ShardSealer
  open(sealed: SealedMessagePayload): Promise<OpenedMessage | null>
  isUnlocked(): boolean
  /** Injected in tests. Production builds the FlexSearch adapter. */
  createAdapter?: () => SearchIndexAdapter
  store?: IndexBlobStore
  source?: IndexSyncSource
  messageCount?: number
}

/**
 * Build (or resume) the index for this tab. One build at a time: a second call
 * while one is running joins the first rather than racing it over the same
 * shards.
 */
export function startMailboxSearchIndex(
  deps: MailboxSearchIndexHostDeps,
): Promise<SearchIndexOutcome | null> {
  if (running) return running
  const controller = new AbortController()
  abort = controller
  adapter = (deps.createAdapter ?? createFlexSearchIndexAdapter)()
  const store = deps.store ?? createIndexedDbBlobStore()
  const source = deps.source ?? createSealedListingSource(deps.api)

  running = (async () => {
    try {
      return await startSearchIndex({
        adapter: adapter as SearchIndexAdapter,
        store,
        sealer: deps.sealer,
        source,
        open: deps.open,
        isUnlocked: deps.isUnlocked,
        messageCount: deps.messageCount ?? 0,
        estimate: await estimateIndexStorage(),
        signal: controller.signal,
      })
    } catch {
      // The listing is missing or refused. Say search is unavailable and drop
      // the adapter: answering from a half-built index would be the silent
      // wrong answer this whole module exists to avoid.
      adapter = null
      reportIndexUnavailable()
      return null
    } finally {
      running = null
    }
  })()
  return running
}

export function stopMailboxSearchIndex(): void {
  abort?.abort()
  abort = null
  adapter = null
  running = null
}
