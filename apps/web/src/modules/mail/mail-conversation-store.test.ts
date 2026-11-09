// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("mail-conversation-store", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("setView changes current view and resets list", async () => {
    const { conversationStore, currentView, setView } = await import(
      "~/modules/mail/mail-conversation-store"
    )
    setView("starred")
    expect(currentView()).toBe("starred")
    expect(conversationStore.ids).toEqual([])
  })

  it("a new message in a conversation updates its row live and moves it to the top", async () => {
    const { conversationStore, handleConversationEvent, setView } = await import(
      "~/modules/mail/mail-conversation-store"
    )
    setView("inbox")
    const row = (id: string, lastMessageAt: string) => ({
      id,
      accountId: "mail-1",
      subject: `Subject ${id}`,
      snippet: "...",
      isRead: true,
      isStarred: false,
      status: "open",
      lastMessageAt,
      messageCount: 1,
      labels: ["INBOX"],
    })
    handleConversationEvent("create", row("older", "2026-01-01T00:00:00.000Z"))
    handleConversationEvent("create", row("newer", "2026-01-02T00:00:00.000Z"))
    expect(conversationStore.ids).toEqual(["newer", "older"])

    // The reply sent on "older": the page write's conversation update.
    handleConversationEvent("update", {
      id: "older",
      accountId: "mail-1",
      snippet: "Here is the quote",
      messageCount: 2,
      isRead: true,
      lastMessageAt: "2026-01-03T00:00:00.000Z",
    })
    expect(conversationStore.ids).toEqual(["older", "newer"])
    expect(conversationStore.byId.older?.snippet).toBe("Here is the quote")
    expect(conversationStore.byId.older?.messageCount).toBe(2)

    // A state-only update (read, labels) keeps the order.
    handleConversationEvent("update", { id: "newer", isRead: false })
    expect(conversationStore.ids).toEqual(["older", "newer"])
  })

  it("setView does not clear the list when selecting the active view", async () => {
    const { conversationStore, handleConversationEvent, setView } = await import(
      "~/modules/mail/mail-conversation-store"
    )
    handleConversationEvent("create", {
      id: "c1",
      accountId: "mail-1",
      subject: "Inbox item",
      snippet: "...",
      isRead: false,
      isStarred: false,
      status: "open",
      lastMessageAt: "2026-01-01T00:00:00.000Z",
      messageCount: 1,
      assignedTo: null,
      contactId: null,
      internalThreadId: null,
      labels: [],
      senderName: "Alice",
      senderEmail: "alice@example.com",
    })

    setView("inbox")
    expect(conversationStore.ids).toEqual(["c1"])
  })

  it("loadConversations uses the shared API client and stores results", async () => {
    const api = {
      getEnvelope: vi.fn().mockResolvedValue({
        data: [
          {
            id: "c1",
            accountId: "mail-1",
            subject: "Test",
            snippet: "Hello",
            isRead: false,
            isStarred: false,
            status: "open",
            lastMessageAt: "2026-01-01T00:00:00.000Z",
            messageCount: 1,
            assignedTo: null,
            contactId: null,
            internalThreadId: null,
            labels: [],
            senderName: "Alice",
            senderEmail: "alice@example.com",
          },
        ],
        meta: { nextCursor: null },
      }),
    }

    const { conversationStore, loadConversations } = await import(
      "~/modules/mail/mail-conversation-store"
    )
    await loadConversations(api)

    expect(api.getEnvelope).toHaveBeenCalledWith("/mail/conversations?status=open&limit=25")
    expect(conversationStore.ids).toEqual(["c1"])
    expect(conversationStore.byId.c1?.subject).toBe("Test")
  })

  it("setView('assigned-to-me') loads conversations assigned to the current user", async () => {
    const api = { getEnvelope: vi.fn().mockResolvedValue({ data: [], meta: { nextCursor: null } }) }

    const { loadConversations, setView } = await import("~/modules/mail/mail-conversation-store")
    setView("assigned-to-me")
    await loadConversations(api, { currentUserId: "u-123" })

    expect(api.getEnvelope).toHaveBeenCalledWith(
      "/mail/conversations?assignedTo=u-123&status=open&limit=25",
    )
  })

  it("assignedToMeCount counts only unread conversations assigned to the current user", async () => {
    vi.doMock("~/modules/auth/auth-store", () => ({ userFromToken: () => ({ userId: "u-123" }) }))
    const { assignedToMeCount, handleConversationEvent } = await import(
      "~/modules/mail/mail-conversation-store"
    )

    for (const conversation of [
      { id: "mine-unread", assignedTo: "u-123", isRead: false },
      { id: "mine-read", assignedTo: "u-123", isRead: true },
      { id: "other-unread", assignedTo: "u-999", isRead: false },
    ]) {
      handleConversationEvent("create", {
        id: conversation.id,
        accountId: "mail-1",
        subject: conversation.id,
        snippet: "...",
        isRead: conversation.isRead,
        isStarred: false,
        status: "open",
        lastMessageAt: "2026-01-01T00:00:00.000Z",
        messageCount: 1,
        assignedTo: conversation.assignedTo,
        contactId: null,
        internalThreadId: null,
        labels: [],
        senderName: "Alice",
        senderEmail: "alice@example.com",
      })
    }

    expect(assignedToMeCount()).toBe(1)
    vi.doUnmock("~/modules/auth/auth-store")
  })

  it("assigned-to-me view accepts inbound create events assigned to the current user", async () => {
    vi.doMock("~/modules/auth/auth-store", () => ({ userFromToken: () => ({ userId: "u-123" }) }))
    const { conversationStore, handleConversationEvent, setView } = await import(
      "~/modules/mail/mail-conversation-store"
    )

    setView("assigned-to-me")
    handleConversationEvent("create", {
      id: "mine-unread",
      accountId: "mail-1",
      subject: "Mine",
      snippet: "...",
      isRead: false,
      isStarred: false,
      status: "open",
      lastMessageAt: "2026-01-01T00:00:00.000Z",
      messageCount: 1,
      assignedTo: "u-123",
      contactId: null,
      internalThreadId: null,
      labels: [],
      senderName: "Alice",
      senderEmail: "alice@example.com",
    })

    expect(conversationStore.ids).toEqual(["mine-unread"])
    vi.doUnmock("~/modules/auth/auth-store")
  })

  it("handleConversationEvent only prepends items that match the current view", async () => {
    const { conversationStore, handleConversationEvent, setView } = await import(
      "~/modules/mail/mail-conversation-store"
    )

    setView("starred")
    handleConversationEvent("create", {
      id: "c-new",
      accountId: "mail-1",
      subject: "New email",
      snippet: "...",
      isRead: false,
      isStarred: false,
      status: "open",
      lastMessageAt: new Date().toISOString(),
      messageCount: 1,
      assignedTo: null,
      contactId: null,
      internalThreadId: null,
      labels: [],
      senderName: "Alice",
      senderEmail: "alice@example.com",
    })

    expect(conversationStore.ids).toEqual([])
  })

  it("optimistic star toggle reverts on failure", async () => {
    const api = {
      patch: vi.fn().mockRejectedValue(new Error("Network error")),
    }

    const { conversationStore, handleConversationEvent, toggleStar } = await import(
      "~/modules/mail/mail-conversation-store"
    )

    handleConversationEvent("create", {
      id: "c1",
      accountId: "mail-1",
      subject: "Old",
      snippet: "...",
      isRead: false,
      isStarred: false,
      status: "open",
      lastMessageAt: "2026-01-01T00:00:00.000Z",
      messageCount: 1,
      assignedTo: null,
      contactId: null,
      internalThreadId: null,
      labels: [],
      senderName: "Alice",
      senderEmail: "alice@example.com",
    })

    await toggleStar(api, "c1")
    expect(conversationStore.byId.c1?.isStarred).toBe(false)
  })

  it("optimistic read toggle reverts on failure", async () => {
    const api = {
      patch: vi.fn().mockRejectedValue(new Error("Network error")),
    }

    const { conversationStore, handleConversationEvent, toggleRead } = await import(
      "~/modules/mail/mail-conversation-store"
    )

    handleConversationEvent("create", {
      id: "c1",
      accountId: "mail-1",
      subject: "Old",
      snippet: "...",
      isRead: false,
      isStarred: false,
      status: "open",
      lastMessageAt: "2026-01-01T00:00:00.000Z",
      messageCount: 1,
      assignedTo: null,
      contactId: null,
      internalThreadId: null,
      labels: [],
      senderName: "Alice",
      senderEmail: "alice@example.com",
    })

    await toggleRead(api, "c1")
    expect(conversationStore.byId.c1?.isRead).toBe(false)
  })

  it("claimConversation patches assignedTo to the current user", async () => {
    const api = { patch: vi.fn().mockResolvedValue({}) }
    const { claimConversation } = await import("~/modules/mail/mail-conversation-store")

    await claimConversation(api, "conv-1", "current-user-id")

    expect(api.patch).toHaveBeenCalledWith("/mail/conversations/conv-1", {
      assignedTo: "current-user-id",
    })
  })

  it("reassignConversation and unassignConversation patch assignedTo", async () => {
    const api = { patch: vi.fn().mockResolvedValue({}) }
    const { reassignConversation, unassignConversation } = await import(
      "~/modules/mail/mail-conversation-store"
    )

    await reassignConversation(api, "conv-1", "user-2")
    await unassignConversation(api, "conv-1")

    expect(api.patch).toHaveBeenCalledWith("/mail/conversations/conv-1", { assignedTo: "user-2" })
    expect(api.patch).toHaveBeenCalledWith("/mail/conversations/conv-1", { assignedTo: null })
  })

  it("ignores stale conversation responses after the view changes", async () => {
    const resolvers: Array<(value: { data: any[]; meta: { nextCursor: null } }) => void> = []
    const api = {
      getEnvelope: vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((resolve) =>
              resolvers.push(
                resolve as (value: { data: any[]; meta: { nextCursor: null } }) => void,
              ),
            ),
        ),
    }

    const { conversationStore, loadConversations, setView } = await import(
      "~/modules/mail/mail-conversation-store"
    )

    const firstLoad = loadConversations(api)
    setView("starred")
    const secondLoad = loadConversations(api)

    resolvers[1]!({
      data: [
        {
          id: "fresh",
          accountId: "mail-1",
          subject: "Fresh",
          snippet: "fresh",
          isRead: false,
          isStarred: true,
          status: "open",
          lastMessageAt: "2026-01-02T00:00:00.000Z",
          messageCount: 1,
          assignedTo: null,
          contactId: null,
          internalThreadId: null,
          labels: [],
          senderName: "Alice",
          senderEmail: "alice@example.com",
        },
      ],
      meta: { nextCursor: null },
    })
    await secondLoad

    resolvers[0]!({
      data: [
        {
          id: "stale",
          accountId: "mail-1",
          subject: "Stale",
          snippet: "stale",
          isRead: false,
          isStarred: false,
          status: "open",
          lastMessageAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          assignedTo: null,
          contactId: null,
          internalThreadId: null,
          labels: [],
          senderName: "Bob",
          senderEmail: "bob@example.com",
        },
      ],
      meta: { nextCursor: null },
    })
    await firstLoad

    expect(conversationStore.ids).toEqual(["fresh"])
  })

  // A stale answer that lands while the current view's request is still out
  // must leave the list loading: clearing the flag showed the emptied list as
  // "No conversations" (the Trash view in mail-conversations Scenario 3)
  // until the real answer came.
  it("a stale answer landing first keeps the list loading until the current one lands", async () => {
    const resolvers: Array<(value: { data: any[]; meta: { nextCursor: null } }) => void> = []
    const api = {
      getEnvelope: vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((resolve) =>
              resolvers.push(
                resolve as (value: { data: any[]; meta: { nextCursor: null } }) => void,
              ),
            ),
        ),
    }
    const { conversationStore, loadConversations, loading, setView } = await import(
      "~/modules/mail/mail-conversation-store"
    )

    const firstLoad = loadConversations(api)
    setView("trash")
    const secondLoad = loadConversations(api)
    expect(loading()).toBe(true)

    resolvers[0]!({ data: [], meta: { nextCursor: null } })
    await firstLoad
    expect(conversationStore.ids).toEqual([])
    expect(loading()).toBe(true)

    resolvers[1]!({
      data: [
        {
          id: "trashed",
          accountId: "mail-1",
          subject: "Trashed",
          snippet: "trashed",
          isRead: true,
          isStarred: false,
          status: "open",
          lastMessageAt: "2026-01-02T00:00:00.000Z",
          messageCount: 1,
          assignedTo: null,
          contactId: null,
          internalThreadId: null,
          labels: [],
          senderName: "Alice",
          senderEmail: "alice@example.com",
        },
      ],
      meta: { nextCursor: null },
    })
    await secondLoad
    expect(loading()).toBe(false)
    expect(conversationStore.ids).toEqual(["trashed"])
  })

  it("resetMailConversationStore clears state", async () => {
    const { conversationStore, handleConversationEvent, resetMailConversationStore } = await import(
      "~/modules/mail/mail-conversation-store"
    )

    handleConversationEvent("create", {
      id: "c1",
      accountId: "mail-1",
      subject: "Test",
      snippet: "...",
      isRead: false,
      isStarred: false,
      status: "open",
      lastMessageAt: "2026-01-01T00:00:00.000Z",
      messageCount: 1,
      assignedTo: null,
      contactId: null,
      internalThreadId: null,
      labels: [],
      senderName: "Alice",
      senderEmail: "alice@example.com",
    })
    resetMailConversationStore()
    expect(conversationStore.ids).toEqual([])
  })

  it("invalidates conversation previews for update and delete events", async () => {
    vi.resetModules()
    const invalidatePreview = vi.fn()
    vi.doMock("~/modules/shell/entity-preview/entity-preview-store", () => ({ invalidatePreview }))

    const { handleConversationEvent } = await import("~/modules/mail/mail-conversation-store")

    handleConversationEvent("update", { id: "conv-1" })
    handleConversationEvent("delete", { id: "conv-2" })

    expect(invalidatePreview).toHaveBeenCalledWith("mail", "conversation", "conv-1")
    expect(invalidatePreview).toHaveBeenCalledWith("mail", "conversation", "conv-2")

    vi.doUnmock("~/modules/shell/entity-preview/entity-preview-store")
  })
  it("personal view asks the server for the user's own mailboxes and drops shared-box events", async () => {
    const accounts = await import("~/modules/mail/mail-account-store")
    await accounts.loadAccounts({
      get: vi.fn().mockResolvedValue([
        { id: "acc-personal", ownerType: "user", emailAddress: "me@example.com" },
        { id: "acc-shared", ownerType: "org", emailAddress: "contact@example.com" },
      ]),
    } as any)
    const api = { getEnvelope: vi.fn().mockResolvedValue({ data: [], meta: { nextCursor: null } }) }
    const { conversationStore, handleConversationEvent, loadConversations, setView } = await import(
      "~/modules/mail/mail-conversation-store"
    )
    setView("inbox:personal")
    await loadConversations(api)
    expect(api.getEnvelope).toHaveBeenCalledWith(
      "/mail/conversations?status=open&ownership=personal&limit=25",
    )

    const base = {
      subject: "s",
      snippet: "",
      isRead: false,
      isStarred: false,
      status: "open",
      lastMessageAt: "2026-01-01T00:00:00.000Z",
      messageCount: 1,
      labels: [],
    }
    handleConversationEvent("create", { ...base, id: "shared-1", accountId: "acc-shared" })
    handleConversationEvent("create", { ...base, id: "mine-1", accountId: "acc-personal" })
    expect(conversationStore.ids).toEqual(["mine-1"])
  })

  it("a personal Gmail account view asks for Primary by default and the remembered choice after", async () => {
    localStorage.clear()
    const accounts = await import("~/modules/mail/mail-account-store")
    await accounts.loadAccounts({
      get: vi.fn().mockResolvedValue([
        { id: "acc-mine", ownerType: "user", provider: "gmail", emailAddress: "m@example.com" },
        { id: "acc-imap", ownerType: "org", provider: "imap", emailAddress: "i@example.com" },
      ]),
    } as any)
    const api = { getEnvelope: vi.fn().mockResolvedValue({ data: [], meta: { nextCursor: null } }) }
    const { loadConversations, setView } = await import("~/modules/mail/mail-conversation-store")
    const { setMailCategory } = await import("~/modules/mail/mail-category")

    setView("inbox:acc-mine")
    await loadConversations(api)
    expect(api.getEnvelope).toHaveBeenLastCalledWith(
      "/mail/conversations?status=open&accountId=acc-mine&category=primary&limit=25",
    )
    setMailCategory("acc-mine", "other")
    await loadConversations(api)
    expect(api.getEnvelope).toHaveBeenLastCalledWith(
      "/mail/conversations?status=open&accountId=acc-mine&category=other&limit=25",
    )
    // A non-Gmail mailbox has no categories: nothing is filtered.
    setView("inbox:acc-imap")
    await loadConversations(api)
    expect(api.getEnvelope).toHaveBeenLastCalledWith(
      "/mail/conversations?status=open&accountId=acc-imap&limit=25",
    )
  })

  it("A45: a shared Gmail account view defaults to All (no filter), Primary only when chosen", async () => {
    localStorage.clear()
    const accounts = await import("~/modules/mail/mail-account-store")
    await accounts.loadAccounts({
      get: vi
        .fn()
        .mockResolvedValue([
          { id: "acc-gmail", ownerType: "org", provider: "gmail", emailAddress: "g@example.com" },
        ]),
    } as any)
    const api = { getEnvelope: vi.fn().mockResolvedValue({ data: [], meta: { nextCursor: null } }) }
    const { loadConversations, setView } = await import("~/modules/mail/mail-conversation-store")
    const { setMailCategory } = await import("~/modules/mail/mail-category")

    setView("inbox:acc-gmail")
    await loadConversations(api)
    expect(api.getEnvelope).toHaveBeenLastCalledWith(
      "/mail/conversations?status=open&accountId=acc-gmail&limit=25",
    )
    setMailCategory("acc-gmail", "primary")
    await loadConversations(api)
    expect(api.getEnvelope).toHaveBeenLastCalledWith(
      "/mail/conversations?status=open&accountId=acc-gmail&category=primary&limit=25",
    )
  })
})
