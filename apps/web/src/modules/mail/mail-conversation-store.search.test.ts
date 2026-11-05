// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The inbox search over the whole view, beyond the pages the list has loaded.
// A private mailbox's search text never leaves the browser: only the message
// ids its local index matched are sent, and the test reads the serialized body.
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearDeepSearch,
  conversationStore,
  loadConversations,
  resetMailConversationStore,
  searchAllConversations,
} from "~/modules/mail/mail-conversation-store"

const PLAIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const PRIVATE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const MESSAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

const state = vi.hoisted(() => ({
  accounts: [] as Array<{
    id: string
    ownerType: "user" | "org"
    ownerId: string | null
    encryptionState: string | null
  }>,
  index: null as null | { search: ReturnType<typeof vi.fn> },
}))

vi.mock("~/modules/mail/mail-account-store", () => ({
  allAccounts: () => state.accounts,
  getAccount: (id: string) => state.accounts.find((account) => account.id === id),
}))
vi.mock("~/modules/mailbox/search-index/search-index-host", () => ({
  liveSearchIndexAdapter: () => state.index,
}))

function row(id: string, accountId: string, lastMessageAt: string) {
  return {
    id,
    accountId,
    subject: `Subject ${id}`,
    snippet: "...",
    isRead: true,
    isStarred: false,
    status: "open",
    lastMessageAt,
    messageCount: 1,
    labels: ["INBOX"],
  }
}

/** A first page of 25 rows with more to load. */
function apiWithFirstPage(post: (path: string, body?: unknown) => Promise<unknown>) {
  const page = Array.from({ length: 25 }, (_, i) =>
    row(`loaded-${i}`, PLAIN, `2026-11-04T10:${String(59 - i).padStart(2, "0")}:00.000Z`),
  )
  return {
    getEnvelope: vi.fn().mockResolvedValue({ data: page, meta: { nextCursor: "cursor-1" } }),
    post: <T>(path: string, body?: unknown) => post(path, body) as Promise<T>,
  }
}

const opts = { currentUserId: "user-1" }

beforeEach(() => {
  resetMailConversationStore()
  state.accounts = [{ id: PLAIN, ownerType: "org", ownerId: null, encryptionState: "none" }]
  state.index = null
})

describe("searchAllConversations", () => {
  it("adds a conversation beyond the loaded pages without touching the paginated list", async () => {
    const post = vi.fn().mockResolvedValue([row("old", PLAIN, "2026-10-01T00:00:00.000Z")])
    const api = apiWithFirstPage(post)
    await loadConversations(api, opts)
    const loaded = [...conversationStore.ids]

    await searchAllConversations(api, "  invoice ", opts)

    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0]).toBe("/mail/conversations/search")
    expect(post.mock.calls[0][1]).toMatchObject({
      query: "invoice",
      accountIds: [PLAIN],
      status: "open",
    })
    expect(conversationStore.searchIds).toEqual(["old"])
    expect(conversationStore.byId.old?.subject).toBe("Subject old")
    expect(conversationStore.ids).toEqual(loaded)

    clearDeepSearch()
    expect(conversationStore.searchIds).toEqual([])
  })

  it("a private mailbox sends the ids its local index matched, never the text", async () => {
    state.accounts = [
      { id: PLAIN, ownerType: "org", ownerId: null, encryptionState: "managed" },
      { id: PRIVATE, ownerType: "user", ownerId: "user-1", encryptionState: "ready" },
    ]
    state.index = { search: vi.fn().mockResolvedValue([MESSAGE_ID]) }
    const post = vi.fn().mockResolvedValue([])
    const api = apiWithFirstPage(post)
    await loadConversations(api, opts)

    await searchAllConversations(api, "secret phrase", opts)

    expect(state.index.search).toHaveBeenCalledWith({
      text: "secret phrase",
      accountIds: [PRIVATE],
      limit: 200,
    })
    const bodies = post.mock.calls.map((call) => call[1] as Record<string, unknown>)
    const privateBody = bodies.find((body) => Array.isArray(body.messageIds))
    expect(privateBody).toBeDefined()
    expect(privateBody?.accountIds).toEqual([PRIVATE])
    expect(privateBody?.messageIds).toEqual([MESSAGE_ID])
    expect(JSON.stringify(privateBody)).not.toContain("secret")
    expect(privateBody).not.toHaveProperty("query")
    // The readable mailbox is searched by text, and only it.
    const textBody = bodies.find((body) => body.query === "secret phrase")
    expect(textBody?.accountIds).toEqual([PLAIN])
    expect(bodies).toHaveLength(2)
  })

  it("a private mailbox with no index in this tab is not searched, and its text is never sent", async () => {
    state.accounts = [
      { id: PRIVATE, ownerType: "user", ownerId: "user-1", encryptionState: "ready" },
    ]
    const post = vi.fn().mockResolvedValue([])
    const api = apiWithFirstPage(post)
    await loadConversations(api, opts)

    await searchAllConversations(api, "secret phrase", opts)

    expect(post).not.toHaveBeenCalled()
  })

  it("ignores a response that a newer query overtook", async () => {
    let answerFirst!: (rows: unknown[]) => void
    const post = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerFirst = resolve
          }),
      )
      .mockResolvedValueOnce([row("second", PLAIN, "2026-10-02T00:00:00.000Z")])
    const api = apiWithFirstPage(post)
    await loadConversations(api, opts)

    const first = searchAllConversations(api, "first", opts)
    await searchAllConversations(api, "second", opts)
    answerFirst([row("first", PLAIN, "2026-10-01T00:00:00.000Z")])
    await first

    expect(conversationStore.searchIds).toEqual(["second"])
    expect(conversationStore.byId.first).toBeUndefined()
  })

  it("keeps the found rows through a reload of the list", async () => {
    const post = vi.fn().mockResolvedValue([row("old", PLAIN, "2026-10-01T00:00:00.000Z")])
    const api = apiWithFirstPage(post)
    await loadConversations(api, opts)
    await searchAllConversations(api, "invoice", opts)

    await loadConversations(api, opts)

    expect(conversationStore.searchIds).toEqual(["old"])
    expect(conversationStore.byId.old).toBeDefined()
    expect(conversationStore.ids).not.toContain("old")
  })
})
