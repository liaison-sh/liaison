// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one place the adapter, the sealed store, the sync loop, the quota
// arithmetic and the banner meet (blueprint tasks 10.3 and 10.4).
//
// It exists so that no surface has to know the order of those five things. Its
// contract is short: whatever happens, the store ends in a state the banner can
// describe, and search never quietly answers less than it claims to.
//
// SERVER DEPENDENCY, stated rather than assumed. `source` is injected. The
// `GET /api/mailbox/sync-cursor` route named in blueprint task 10.3, and the
// paged sealed-message listing this needs behind it, are `apps/api` work and
// are not in the tree yet. A caller wires a real source to them; every path in
// this module is exercised against an injected one.

import type { OpenedMessage, SealedMessagePayload } from "~/modules/mailbox/crypto-protocol"
import type { SearchIndexAdapter } from "~/modules/mailbox/search-index/adapter"
import type { IndexBlobStore } from "~/modules/mailbox/search-index/index-blob-store"
import {
  dropPersistedIndex,
  restoreIndex,
  type ShardSealer,
} from "~/modules/mailbox/search-index/index-persistence"
import { type IndexSyncSource, syncSearchIndex } from "~/modules/mailbox/search-index/index-sync"
import {
  isQuotaExceededError,
  planIndexCapacity,
  type StorageEstimate,
} from "~/modules/mailbox/search-index/quota"
import {
  reportIndexBuildProgress,
  reportIndexDegraded,
  reportIndexLocked,
  reportIndexReady,
  reportIndexRebuilding,
  type SearchIndexStatus,
  searchIndexStore,
} from "~/modules/mailbox/search-index/search-index-store"

export interface StartSearchIndexInput {
  adapter: SearchIndexAdapter
  store: IndexBlobStore
  sealer: ShardSealer
  source: IndexSyncSource
  open(sealed: SealedMessagePayload): Promise<OpenedMessage | null>
  isUnlocked(): boolean
  /** Messages in the mailbox, for the capacity projection. */
  messageCount: number
  messagesInWindow?: number
  /** `navigator.storage.estimate()`, already read, or null. */
  estimate: StorageEstimate | null
  /** True when this device has had an index before, so a miss is an eviction. */
  hadIndexBefore?: boolean
  onStatus?(status: SearchIndexStatus): void
  signal?: AbortSignal
}

export type SearchIndexOutcome = {
  mode: "full" | "reduced-window" | "metadata-only" | "locked"
  indexed: number
}

export async function startSearchIndex(input: StartSearchIndexInput): Promise<SearchIndexOutcome> {
  const report = (status: SearchIndexStatus) => input.onStatus?.(status)

  if (!input.isUnlocked()) {
    // A locked mailbox cannot be indexed and must not be searched. Saying so is
    // the whole difference between "locked" and "you have no mail matching".
    reportIndexLocked()
    report("locked")
    return { mode: "locked", indexed: 0 }
  }

  const plan = planIndexCapacity({
    messageCount: input.messageCount,
    ...(input.messagesInWindow != null ? { messagesInWindow: input.messagesInWindow } : {}),
    estimate: input.estimate,
  })

  if (plan.mode === "metadata-only") {
    // Nothing is fetched and nothing is decrypted: an index that cannot hold
    // bodies has no business asking for them.
    input.adapter.setMode("metadata-only")
    reportIndexDegraded({ mode: "metadata-only", reason: "quota" })
    report("metadata-only")
    return { mode: "metadata-only", indexed: 0 }
  }

  const restored = await restoreIndex({
    adapter: input.adapter,
    store: input.store,
    sealer: input.sealer,
  })
  if (!restored.restored && input.hadIndexBefore) {
    reportIndexRebuilding()
    report("rebuilding")
  }

  try {
    const result = await syncSearchIndex({
      adapter: input.adapter,
      store: input.store,
      sealer: input.sealer,
      source: input.source,
      open: input.open,
      ...(input.signal ? { signal: input.signal } : {}),
      onProgress: (progress) => {
        reportIndexBuildProgress(progress)
        report(searchIndexStore.status)
      },
    })
    if (result.stoppedBecause === "locked") {
      reportIndexLocked()
      report("locked")
      return { mode: "locked", indexed: result.indexed }
    }
    if (result.completed) {
      if (plan.mode === "reduced-window") {
        reportIndexDegraded({
          mode: "reduced-window",
          reason: "quota",
          ...(plan.windowMonths != null ? { windowMonths: plan.windowMonths } : {}),
        })
        report("reduced-window")
        return { mode: "reduced-window", indexed: result.indexed }
      }
      reportIndexReady()
      report("ready")
      return { mode: "full", indexed: result.indexed }
    }
    // Interrupted, not degraded: the progress the loop reported already left
    // the store in "building", which is the honest state.
    report(searchIndexStore.status)
    return {
      mode: plan.mode === "reduced-window" ? "reduced-window" : "full",
      indexed: result.indexed,
    }
  } catch (error) {
    if (!isQuotaExceededError(error)) throw error
    // The origin filled up part way through. What is on disk now is a partial
    // index that would answer searches wrongly, so it goes, and search drops to
    // the half that needs no storage of its own.
    await dropPersistedIndex(input.store).catch(() => {})
    input.adapter.setMode("metadata-only")
    reportIndexDegraded({ mode: "metadata-only", reason: "quota" })
    report("metadata-only")
    return { mode: "metadata-only", indexed: 0 }
  }
}
