// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The behavioural half of T-WEB-5 (blueprint task 10.4): what the product
// actually DOES when the browser runs out of room, or evicted the index between
// sessions. Every one of these paths ends in a banner, and none of them ends in
// an empty result set that looks like an answer.

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OpenedMessage, SealedMessagePayload } from "~/modules/mailbox/crypto-protocol"
import { createMemoryIndexBlobStore } from "~/modules/mailbox/search-index/index-blob-store"
import { persistIndex, type ShardSealer } from "~/modules/mailbox/search-index/index-persistence"
import type { IndexSyncPage } from "~/modules/mailbox/search-index/index-sync"
import { createMemorySearchIndexAdapter } from "~/modules/mailbox/search-index/memory-adapter"
import { STORED_BYTES_PER_MESSAGE } from "~/modules/mailbox/search-index/quota"
import { startSearchIndex } from "~/modules/mailbox/search-index/search-index-controller"
import {
  resetSearchIndexStore,
  searchIndexStore,
} from "~/modules/mailbox/search-index/search-index-store"

function fakeSealer(): ShardSealer {
  return {
    async seal(shardId, plaintext) {
      return btoa(unescape(encodeURIComponent(`${shardId}|${plaintext}`)))
    },
    async open(shardId, blob) {
      const raw = decodeURIComponent(escape(atob(blob)))
      if (!raw.startsWith(`${shardId}|`)) throw new Error("wrong shard")
      return raw.slice(shardId.length + 1)
    },
  }
}

function pageOf(ids: string[]): IndexSyncPage {
  return {
    cursor: ids[ids.length - 1] ?? "",
    done: true,
    total: ids.length,
    items: ids.map((id) => ({
      sealed: { id, encVersion: 1, encKeyId: 1, contentKeyWrapped: "", contentKeyEpk: "" },
      envelope: {
        accountId: "acc-1",
        conversationId: `conv-${id}`,
        sentAt: "2026-08-01T00:00:00.000Z",
        metadata: "ada@example.com inbox",
      },
    })),
  }
}

const open = async (sealed: SealedMessagePayload): Promise<OpenedMessage> => ({
  id: sealed.id,
  subject: `subject ${sealed.id}`,
  textBody: `body of ${sealed.id} with wd${sealed.id}q`,
  htmlBody: null,
  snippet: null,
})

describe("T-WEB-5: search index degradation is explicit, never a silent zero result", () => {
  beforeEach(() => {
    resetSearchIndexStore()
  })

  it("builds, then reports the index as complete", async () => {
    const adapter = createMemorySearchIndexAdapter()
    const outcome = await startSearchIndex({
      adapter,
      store: createMemoryIndexBlobStore(),
      sealer: fakeSealer(),
      source: {
        async fetchPage() {
          return pageOf(["m1", "m2"])
        },
      },
      open,
      isUnlocked: () => true,
      messageCount: 2,
      estimate: null,
    })
    expect(outcome.mode).toBe("full")
    expect(searchIndexStore.status).toBe("ready")
    expect(searchIndexStore.complete).toBe(true)
    expect(await adapter.search({ text: "wdm2q" })).toEqual(["m2"])
  })

  it("says it is rebuilding when the browser evicted the index", async () => {
    const seen: string[] = []
    await startSearchIndex({
      adapter: createMemorySearchIndexAdapter(),
      store: createMemoryIndexBlobStore(),
      sealer: fakeSealer(),
      source: {
        async fetchPage() {
          return pageOf(["m1"])
        },
      },
      open,
      isUnlocked: () => true,
      messageCount: 1,
      estimate: null,
      // A previous session existed, so a missing index is an eviction rather
      // than a first run, and the wording differs.
      hadIndexBefore: true,
      onStatus: (status) => seen.push(status),
    })
    expect(seen).toContain("rebuilding")
  })

  it("restores an existing index without rebuilding it", async () => {
    const store = createMemoryIndexBlobStore()
    const sealer = fakeSealer()
    const seed = createMemorySearchIndexAdapter()
    await seed.add({
      id: "m1",
      accountId: "acc-1",
      conversationId: "c1",
      sentAt: "2026-08-01T00:00:00.000Z",
      metadata: "inbox",
      content: "restoredcontent",
    })
    await persistIndex({ adapter: seed, store, sealer })

    const adapter = createMemorySearchIndexAdapter()
    const fetchPage = vi.fn(async () => pageOf([]))
    await startSearchIndex({
      adapter,
      store,
      sealer,
      source: { fetchPage },
      open,
      isUnlocked: () => true,
      messageCount: 1,
      estimate: null,
    })
    expect(await adapter.search({ text: "restoredcontent" })).toEqual(["m1"])
  })

  it("degrades to metadata search with a banner when the mailbox cannot fit", async () => {
    const adapter = createMemorySearchIndexAdapter()
    const fetchPage = vi.fn(async () => pageOf(["m1"]))
    const outcome = await startSearchIndex({
      adapter,
      store: createMemoryIndexBlobStore(),
      sealer: fakeSealer(),
      source: { fetchPage },
      open,
      isUnlocked: () => true,
      // One message past what the measured figure says fits in the safe share,
      // with no window small enough to help.
      messageCount: 1_000_000,
      messagesInWindow: 900_000,
      estimate: { usage: 0, quota: 4 * STORED_BYTES_PER_MESSAGE },
    })
    expect(outcome.mode).toBe("metadata-only")
    expect(adapter.mode()).toBe("metadata-only")
    expect(searchIndexStore.status).toBe("metadata-only")
    expect(searchIndexStore.complete).toBe(false)
    // Bodies are never decrypted for an index that cannot hold them.
    expect(fetchPage).not.toHaveBeenCalled()
  })

  it("degrades on a QuotaExceededError raised mid build, and drops the half index", async () => {
    const adapter = createMemorySearchIndexAdapter()
    const store = createMemoryIndexBlobStore()
    const quotaError = new Error("no room")
    quotaError.name = "QuotaExceededError"
    const put = vi.spyOn(store, "put").mockRejectedValue(quotaError)

    const outcome = await startSearchIndex({
      adapter,
      store,
      sealer: fakeSealer(),
      source: {
        async fetchPage() {
          return pageOf(["m1", "m2"])
        },
      },
      open,
      isUnlocked: () => true,
      messageCount: 2,
      estimate: null,
    })
    expect(put).toHaveBeenCalled()
    expect(outcome.mode).toBe("metadata-only")
    expect(searchIndexStore.status).toBe("metadata-only")
    expect(searchIndexStore.reason).toBe("quota")
  })

  it("reports a locked mailbox rather than an empty index", async () => {
    const outcome = await startSearchIndex({
      adapter: createMemorySearchIndexAdapter(),
      store: createMemoryIndexBlobStore(),
      sealer: fakeSealer(),
      source: {
        async fetchPage() {
          return pageOf(["m1"])
        },
      },
      open,
      isUnlocked: () => false,
      messageCount: 1,
      estimate: null,
    })
    expect(outcome.mode).toBe("locked")
    expect(searchIndexStore.status).toBe("locked")
    expect(searchIndexStore.complete).toBe(false)
  })
})
