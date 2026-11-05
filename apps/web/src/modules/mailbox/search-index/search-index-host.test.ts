// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The index is built, or search says it is unavailable. There is no third
// state, and in particular there is no "empty index answering every query with
// nothing", which is what shipped.

import { beforeEach, describe, expect, it } from "vitest"
import type { OpenedMessage, SealedMessagePayload } from "~/modules/mailbox/crypto-protocol"
import type { MailboxApi } from "~/modules/mailbox/mailbox-api"
import { createMemoryIndexBlobStore } from "~/modules/mailbox/search-index/index-blob-store"
import type { IndexSyncSource } from "~/modules/mailbox/search-index/index-sync"
import { createMemorySearchIndexAdapter } from "~/modules/mailbox/search-index/memory-adapter"
import {
  liveSearchIndexAdapter,
  startMailboxSearchIndex,
  stopMailboxSearchIndex,
} from "~/modules/mailbox/search-index/search-index-host"
import {
  resetSearchIndexStore,
  searchIndexStore,
} from "~/modules/mailbox/search-index/search-index-store"

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111"

const sealer = {
  seal: async (_shardId: string, plaintext: string) => `sealed:${plaintext}`,
  open: async (_shardId: string, blob: string) => blob.replace(/^sealed:/, ""),
}

function onePageSource(): IndexSyncSource {
  return {
    async fetchPage() {
      return {
        cursor: "cursor-1",
        done: true,
        total: 1,
        items: [
          {
            sealed: { id: MESSAGE_ID, encVersion: 1, encKeyId: 1 } as SealedMessagePayload,
            envelope: {
              accountId: "account-1",
              conversationId: "conv-1",
              sentAt: "2026-01-01T00:00:00.000Z",
              metadata: "someone@example.com invoice.pdf",
            },
          },
        ],
      }
    },
  }
}

const failingApi: MailboxApi = {
  get: async () => {
    throw new Error("404")
  },
  // biome-ignore lint/suspicious/noExplicitAny: a stand-in for the generic api client
  post: async (): Promise<any> => ({}),
  // biome-ignore lint/suspicious/noExplicitAny: a stand-in for the generic api client
  delete: async (): Promise<any> => ({}),
}

const opened: OpenedMessage = {
  id: MESSAGE_ID,
  subject: "Quarterly invoice",
  textBody: "the amount is due on friday",
  htmlBody: null,
  snippet: null,
}

describe("mailbox search index host", () => {
  beforeEach(() => {
    stopMailboxSearchIndex()
    resetSearchIndexStore()
  })

  it("builds the index and exposes it to the search responder", async () => {
    const outcome = await startMailboxSearchIndex({
      api: failingApi,
      sealer,
      open: async () => opened,
      isUnlocked: () => true,
      createAdapter: createMemorySearchIndexAdapter,
      store: createMemoryIndexBlobStore(),
      source: onePageSource(),
      messageCount: 1,
    })

    expect(outcome?.indexed).toBe(1)
    const adapter = liveSearchIndexAdapter()
    expect(adapter).not.toBeNull()
    expect(await adapter?.search({ text: "invoice", limit: 10 })).toEqual([MESSAGE_ID])
    expect(searchIndexStore.status).toBe("ready")
  })

  it("says search is unavailable when the sealed listing is not there", async () => {
    const outcome = await startMailboxSearchIndex({
      api: failingApi,
      sealer,
      open: async () => opened,
      isUnlocked: () => true,
      createAdapter: createMemorySearchIndexAdapter,
      store: createMemoryIndexBlobStore(),
      messageCount: 1,
    })

    expect(outcome).toBeNull()
    // No adapter, so the client search responder refuses rather than answering
    // an empty result set that reads as "you have no such mail".
    expect(liveSearchIndexAdapter()).toBeNull()
    expect(searchIndexStore.status).toBe("unavailable")
    expect(searchIndexStore.complete).toBe(false)
  })
})
