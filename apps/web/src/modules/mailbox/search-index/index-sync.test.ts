// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Blueprint task 10.3. A first index build reads and decrypts the whole
// mailbox, which on a real account is minutes of work. Two things therefore
// have to be true or the feature is unusable: it must survive being
// interrupted, and it must not freeze the tab while it runs.

import { describe, expect, it, vi } from "vitest"
import type { OpenedMessage, SealedMessagePayload } from "~/modules/mailbox/crypto-protocol"
import { createMemoryIndexBlobStore } from "~/modules/mailbox/search-index/index-blob-store"
import {
  loadIndexCursor,
  restoreIndex,
  type ShardSealer,
} from "~/modules/mailbox/search-index/index-persistence"
import {
  type IndexSyncPage,
  type IndexSyncSource,
  syncSearchIndex,
} from "~/modules/mailbox/search-index/index-sync"
import { createMemorySearchIndexAdapter } from "~/modules/mailbox/search-index/memory-adapter"

/** A sealer that does not encrypt. The crypto is proven in T-SEC-12; this file
 * is about resumption, so a transparent sealer keeps the failures readable. */
function fakeSealer(): ShardSealer {
  return {
    async seal(shardId, plaintext) {
      return btoa(unescape(encodeURIComponent(`${shardId}|${plaintext}`)))
    },
    async open(shardId, blob) {
      const raw = decodeURIComponent(escape(atob(blob)))
      const prefix = `${shardId}|`
      if (!raw.startsWith(prefix)) throw new Error("wrong shard")
      return raw.slice(prefix.length)
    },
  }
}

function sealedStub(id: string): SealedMessagePayload {
  return {
    id,
    encVersion: 1,
    encKeyId: 1,
    contentKeyWrapped: "",
    contentKeyEpk: "",
  }
}

/** Ten messages over five pages of two, each with its own distinctive word. */
function source(pageSize = 2): IndexSyncSource & { calls: (string | null)[] } {
  const ids = Array.from({ length: 10 }, (_, i) => `m${i + 1}`)
  const calls: (string | null)[] = []
  return {
    calls,
    async fetchPage(cursor: string | null): Promise<IndexSyncPage> {
      calls.push(cursor)
      const start = cursor ? ids.indexOf(cursor) + 1 : 0
      const slice = ids.slice(start, start + pageSize)
      return {
        cursor: slice.length > 0 ? slice[slice.length - 1]! : (cursor ?? ""),
        done: start + pageSize >= ids.length,
        total: ids.length,
        items: slice.map((id) => ({
          sealed: sealedStub(id),
          envelope: {
            accountId: "acc-1",
            conversationId: `conv-${id}`,
            sentAt: "2026-08-01T00:00:00.000Z",
            metadata: `ada@example.com inbox ${id}`,
          },
        })),
      }
    },
  }
}

const openMessage = async (sealed: SealedMessagePayload): Promise<OpenedMessage> => ({
  id: sealed.id,
  subject: `subject ${sealed.id}`,
  textBody: `body of ${sealed.id} with wd${sealed.id}q`,
  htmlBody: null,
  snippet: null,
})

describe("T-WEB-4 support: client search index sync is resumable and yields", () => {
  it("builds the whole index and records the cursor", async () => {
    const adapter = createMemorySearchIndexAdapter()
    const store = createMemoryIndexBlobStore()
    const sealer = fakeSealer()
    const result = await syncSearchIndex({
      adapter,
      store,
      sealer,
      source: source(),
      open: openMessage,
      pageSize: 2,
    })
    expect(result.completed).toBe(true)
    expect(result.indexed).toBe(10)
    expect(await adapter.size()).toBe(10)
    expect(await adapter.search({ text: "wdm7q" })).toEqual(["m7"])
    expect(await loadIndexCursor({ store, sealer })).toBe("m10")
  })

  it("resumes an interrupted first build instead of restarting it", async () => {
    const store = createMemoryIndexBlobStore()
    const sealer = fakeSealer()
    const first = createMemorySearchIndexAdapter()
    const firstSource = source()
    const controller = new AbortController()
    let pages = 0

    const interrupted = await syncSearchIndex({
      adapter: first,
      store,
      sealer,
      source: firstSource,
      open: openMessage,
      pageSize: 2,
      onProgress: (progress) => {
        pages += 1
        // Stop at 40 percent, which is two pages of ten messages.
        if (progress.indexed >= 4) controller.abort()
      },
      signal: controller.signal,
    })
    expect(interrupted.completed).toBe(false)
    expect(interrupted.indexed).toBe(4)
    expect(pages).toBe(2)
    expect(await loadIndexCursor({ store, sealer })).toBe("m4")

    // A brand new adapter, exactly like a page reload.
    const second = createMemorySearchIndexAdapter()
    const restored = await restoreIndex({ adapter: second, store, sealer })
    expect(restored.restored).toBe(true)
    expect(await second.size()).toBe(4)

    const secondSource = source()
    const resumed = await syncSearchIndex({
      adapter: second,
      store,
      sealer,
      source: secondSource,
      open: openMessage,
      pageSize: 2,
    })
    // The proof of resumption: the first fetch asked from the stored cursor,
    // not from the beginning, and only the remaining six were indexed.
    expect(secondSource.calls[0]).toBe("m4")
    expect(secondSource.calls).not.toContain(null)
    expect(resumed.indexed).toBe(6)
    expect(await second.size()).toBe(10)
    expect(await second.search({ text: "wdm1q" })).toEqual(["m1"])
    expect(await second.search({ text: "wdm10q" })).toEqual(["m10"])
  })

  it("yields to the main thread between pages", async () => {
    const yieldToMainThread = vi.fn(async () => {})
    await syncSearchIndex({
      adapter: createMemorySearchIndexAdapter(),
      store: createMemoryIndexBlobStore(),
      sealer: fakeSealer(),
      source: source(),
      open: openMessage,
      pageSize: 2,
      yieldToMainThread,
    })
    // Five pages, and the last one returns `done` before it would yield, so
    // four yields is the floor.
    expect(yieldToMainThread.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it("reports progress with a total so the UI can show one", async () => {
    const seen: number[] = []
    await syncSearchIndex({
      adapter: createMemorySearchIndexAdapter(),
      store: createMemoryIndexBlobStore(),
      sealer: fakeSealer(),
      source: source(),
      open: openMessage,
      pageSize: 2,
      onProgress: (progress) => {
        expect(progress.total).toBe(10)
        seen.push(progress.indexed)
      },
    })
    expect(seen).toEqual([2, 4, 6, 8, 10])
  })

  it("stops without claiming completion when the mailbox locks mid build", async () => {
    const adapter = createMemorySearchIndexAdapter()
    const store = createMemoryIndexBlobStore()
    const sealer = fakeSealer()
    let opened = 0
    const result = await syncSearchIndex({
      adapter,
      store,
      sealer,
      source: source(),
      open: async (sealed) => {
        opened += 1
        // The mailbox locks after three messages. A locked mailbox answers
        // null rather than throwing (mailbox-store `openSealedMessage`).
        return opened > 3 ? null : await openMessage(sealed)
      },
      pageSize: 2,
    })
    expect(result.completed).toBe(false)
    expect(result.stoppedBecause).toBe("locked")
    // An index that silently omitted the rest would answer "no matches" for
    // mail that is right there, which is the failure this whole phase forbids.
    // The three that DID open are kept and persisted, under the cursor of the
    // last page that completed: resuming re-reads that page, which is
    // idempotent, rather than skipping it.
    expect(result.indexed).toBe(3)
    expect(await loadIndexCursor({ store, sealer })).toBe("m2")
    expect(await adapter.size()).toBe(3)
  })
})
