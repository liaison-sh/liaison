// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock localStorage for tab-store
vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

import {
  addParticipantToThread,
  addThread,
  allThreads,
  getThread,
  handleMessageEvent,
  handleParticipantEvent,
  handleThreadEvent,
  loadThreads,
  pinnedThreads,
  removeThread,
  resetThreadStore,
  resetUnreadCount,
  setThreadMuted,
  setThreadPinned,
  threadDisplayName,
  totalUnreadCount,
  unpinnedThreads,
  userPinnedThreads,
} from "~/modules/threads/thread-store"

function makeThread(
  overrides: Partial<{
    id: string
    handle: string
    title: string
    isPinned: boolean
    isPinnedByUser: boolean
    participants: any[]
    updatedAt: string
    unreadCount: number
  }> = {},
) {
  return {
    id: overrides.id ?? "t1",
    handle: overrides.handle ?? "thread-1",
    title: overrides.title ?? "Test Thread",
    isPinned: overrides.isPinned ?? false,
    isPinnedByUser: overrides.isPinnedByUser ?? false,
    participants: overrides.participants ?? [],
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    unreadCount: overrides.unreadCount ?? 0,
  }
}

describe("thread store", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetThreadStore()
  })

  it("exports initial state", () => {
    expect(allThreads()).toEqual([])
  })

  it("handleThreadEvent create adds new thread", () => {
    handleThreadEvent("create", {
      id: "t-new",
      handle: "thread-1",
      title: "New Thread",
      isPinned: false,
      participants: [],
    })
    expect(getThread("t-new")).toBeDefined()
    expect(getThread("t-new")?.title).toBe("New Thread")
  })

  it("handleThreadEvent update modifies thread metadata", () => {
    handleThreadEvent("create", {
      id: "t-upd",
      handle: "thread-upd",
      title: "Original",
      isPinned: false,
      participants: [],
    })
    handleThreadEvent("update", {
      id: "t-upd",
      changes: { title: "Updated Title", isPinned: true },
    })
    const thread = getThread("t-upd")
    expect(thread?.title).toBe("Updated Title")
    expect(thread?.isPinned).toBe(true)
    // Should have moved to pinned partition
    expect(pinnedThreads().map((t) => t.id)).toContain("t-upd")
  })

  it("handleMessageEvent create updates lastMessage and bumps unread", () => {
    handleThreadEvent("create", {
      id: "t-msg",
      handle: "thread-msg",
      title: "Message Test",
      isPinned: false,
      participants: [],
    })
    handleMessageEvent("create", {
      threadId: "t-msg",
      content: "Hello world",
      authorId: "u1",
      authorName: "Alice",
      createdAt: new Date().toISOString(),
    })

    const thread = getThread("t-msg")
    expect(thread?.lastMessage?.content).toBe("Hello world")
    expect(thread?.lastMessage?.authorName).toBe("Alice")
    expect(thread?.unreadCount).toBe(1)
  })

  // QA THR-09: a reply not also sent to the channel lives in its reply
  // thread. Live, it raised the channel's sidebar badge (none -> 1, then 3
  // with a mention's seat line) that a reload took away again.
  it("handleMessageEvent ignores a hidden reply and a reply-thread system line", () => {
    handleThreadEvent("create", {
      id: "t-hidden",
      handle: "thread-hidden",
      title: "Channel",
      isPinned: false,
      participants: [],
    })
    handleMessageEvent("create", {
      threadId: "t-hidden",
      content: "channel line",
      authorId: "u1",
      authorName: "Alice",
      createdAt: "2026-09-29T10:00:00.000Z",
    })
    for (const [authorType, content] of [
      ["user", "thread only"],
      ["system", "Bob added Personal agent"],
    ]) {
      handleMessageEvent("create", {
        threadId: "t-hidden",
        content,
        authorId: "u2",
        authorName: "Bob",
        authorType,
        replyRootId: "root-1",
        alsoInChannel: false,
        createdAt: "2026-09-29T10:05:00.000Z",
      })
    }
    const thread = getThread("t-hidden")
    expect(thread?.unreadCount).toBe(1)
    expect(thread?.lastMessage?.content).toBe("channel line")
    expect(totalUnreadCount()).toBe(1)
  })

  it("handleMessageEvent counts a reply also sent to the channel", () => {
    handleThreadEvent("create", {
      id: "t-also",
      handle: "thread-also",
      title: "Channel",
      isPinned: false,
      participants: [],
    })
    handleMessageEvent("create", {
      threadId: "t-also",
      content: "reply and channel",
      authorId: "u2",
      authorName: "Bob",
      authorType: "user",
      replyRootId: "root-1",
      alsoInChannel: true,
      createdAt: "2026-09-29T10:05:00.000Z",
    })
    expect(getThread("t-also")?.unreadCount).toBe(1)
    expect(getThread("t-also")?.lastMessage?.content).toBe("reply and channel")
  })

  it("handleMessageEvent create moves thread to top of unpinned list", () => {
    handleThreadEvent("create", {
      id: "t-older",
      handle: "thread-older",
      title: "Older",
      isPinned: false,
      participants: [],
    })
    handleThreadEvent("create", {
      id: "t-newer",
      handle: "thread-newer",
      title: "Newer",
      isPinned: false,
      participants: [],
    })

    handleMessageEvent("create", {
      threadId: "t-older",
      content: "New message",
      authorId: "u1",
      authorName: "Alice",
      createdAt: new Date().toISOString(),
    })

    expect(unpinnedThreads()[0].id).toBe("t-older")
  })

  it("handleMessageEvent create does not increment unread for active thread tab", () => {
    handleThreadEvent("create", {
      id: "t-active",
      handle: "thread-active",
      title: "Active Thread",
      isPinned: false,
      participants: [],
    })
    const before = getThread("t-active")?.unreadCount ?? 0
    handleMessageEvent(
      "create",
      {
        threadId: "t-active",
        content: "Read immediately",
        authorId: "u1",
        authorName: "Alice",
        createdAt: new Date().toISOString(),
      },
      { isVisibleActiveThread: true },
    )

    const after = getThread("t-active")?.unreadCount ?? 0
    expect(after).toBe(before)
  })

  it("a message seen arriving in the open thread persists the read mark, others do not", () => {
    handleThreadEvent("create", {
      id: "t-seen",
      handle: "thread-seen",
      title: "Seen Thread",
      isPinned: false,
      participants: [],
    })
    const onReadWhileVisible = vi.fn()
    const msg = (content: string, extra: Record<string, unknown> = {}) => ({
      threadId: "t-seen",
      content,
      authorId: "u1",
      authorName: "Alice",
      createdAt: new Date().toISOString(),
      ...extra,
    })
    handleMessageEvent("create", msg("seen"), {
      isVisibleActiveThread: true,
      onReadWhileVisible,
    })
    expect(onReadWhileVisible).toHaveBeenCalledTimes(1)
    expect(onReadWhileVisible).toHaveBeenCalledWith("t-seen")

    // Background tab, own message, hidden reply: nothing to mark.
    handleMessageEvent("create", msg("background"), {
      isVisibleActiveThread: false,
      onReadWhileVisible,
    })
    handleMessageEvent("create", msg("mine"), {
      isVisibleActiveThread: true,
      isOwnAction: true,
      onReadWhileVisible,
    })
    handleMessageEvent("create", msg("reply", { replyRootId: "root-1" }), {
      isVisibleActiveThread: true,
      onReadWhileVisible,
    })
    expect(onReadWhileVisible).toHaveBeenCalledTimes(1)
  })

  it("an agent's reply in the reader's own turn is news to them, read on sight, counted once", () => {
    // Demo walk 2026-10-12 (thread d4de2865): every agent row is broadcast with
    // the reader as its actor (the person whose turn it is), so the client took
    // the agent's answer for the reader's own message. Watched arriving on the
    // desktop, it never posted the read mark, and the server kept it unread in
    // the badge for good. The server counts an agent row as news
    // (computeBadgeCount, listThreads); the client must agree.
    for (const id of ["t-agent-open", "t-agent-bg"]) {
      handleThreadEvent("create", { id, handle: id, title: id, isPinned: false, participants: [] })
    }
    const onReadWhileVisible = vi.fn()
    const reply = (threadId: string, id: string) => ({
      id,
      threadId,
      content: "the answer",
      authorId: "me",
      authorName: "Me",
      authorType: "agent",
      createdAt: new Date().toISOString(),
    })
    handleMessageEvent("create", reply("t-agent-open", "m-open"), {
      isVisibleActiveThread: true,
      isOwnAction: true,
      onReadWhileVisible,
    })
    expect(onReadWhileVisible).toHaveBeenCalledWith("t-agent-open")
    expect(getThread("t-agent-open")?.unreadCount).toBe(0)

    // In a background thread it raises the pill, once although the same row
    // arrives twice (the low-latency copy and the outbox event).
    handleMessageEvent("create", reply("t-agent-bg", "m-bg"), {
      isVisibleActiveThread: false,
      isOwnAction: true,
    })
    handleMessageEvent("create", reply("t-agent-bg", "m-bg"), {
      isVisibleActiveThread: false,
      isOwnAction: true,
    })
    expect(getThread("t-agent-bg")?.unreadCount).toBe(1)
  })

  it("resetUnreadCount sets unread to 0", () => {
    handleThreadEvent("create", {
      id: "t-unread",
      handle: "thread-unread",
      title: "Unread Test",
      isPinned: false,
      participants: [],
    })
    handleMessageEvent("create", {
      threadId: "t-unread",
      content: "bump",
      authorId: "u1",
      authorName: "Alice",
      createdAt: new Date().toISOString(),
    })
    expect(getThread("t-unread")?.unreadCount).toBe(1)

    resetUnreadCount("t-unread")
    expect(getThread("t-unread")?.unreadCount).toBe(0)
  })

  it("handleMessageEvent create does not increment unread for own action (A4)", () => {
    handleThreadEvent("create", {
      id: "t-own",
      handle: "thread-own",
      title: "Own Action Test",
      isPinned: false,
      participants: [],
    })
    handleMessageEvent(
      "create",
      {
        threadId: "t-own",
        content: "My own message",
        authorId: "me",
        authorName: "Me",
        createdAt: new Date().toISOString(),
      },
      { isVisibleActiveThread: false, isOwnAction: true },
    )
    expect(getThread("t-own")?.unreadCount).toBe(0)
  })

  it("handleMessageEvent create increments unread for other user's action (A4)", () => {
    handleThreadEvent("create", {
      id: "t-other",
      handle: "thread-other",
      title: "Other Action Test",
      isPinned: false,
      participants: [],
    })
    handleMessageEvent(
      "create",
      {
        threadId: "t-other",
        content: "Someone else's message",
        authorId: "u2",
        authorName: "Alice",
        createdAt: new Date().toISOString(),
      },
      { isVisibleActiveThread: false, isOwnAction: false },
    )
    expect(getThread("t-other")?.unreadCount).toBe(1)
  })

  it("handleMessageEvent create does not throw for unknown thread", () => {
    handleMessageEvent("create", {
      threadId: "t-nonexistent",
      content: "test",
      authorId: "u1",
      authorName: "Alice",
      createdAt: new Date().toISOString(),
    })
    // Should not throw
  })

  it("handleParticipantEvent remove filters out thread for current user", () => {
    handleThreadEvent("create", {
      id: "t-remove",
      handle: "thread-2",
      title: "Will be removed",
      isPinned: false,
      participants: [],
    })
    removeThread("t-remove")
    expect(getThread("t-remove")).toBeUndefined()
  })

  it("handleParticipantEvent remove updates participant list", () => {
    handleThreadEvent("create", {
      id: "t-remove-tab",
      handle: "thread-rt",
      title: "Tab Remove",
      isPinned: false,
      participants: [
        { id: "me", name: "Me", avatarUrl: null },
        { id: "u2", name: "Teammate", avatarUrl: null },
      ],
    })

    handleParticipantEvent("remove", { threadId: "t-remove-tab", userId: "u2" })
    expect(getThread("t-remove-tab")?.participants.map((p) => p.id)).toEqual(["me"])
  })

  it("addParticipantToThread can restore a participant at the original index", () => {
    handleThreadEvent("create", {
      id: "t-order",
      handle: "thread-order",
      title: "Participant Order",
      isPinned: false,
      participants: [
        { id: "u1", name: "One", avatarUrl: null },
        { id: "u2", name: "Two", avatarUrl: null },
      ],
    })

    handleParticipantEvent("remove", { threadId: "t-order", userId: "u1" })
    addParticipantToThread("t-order", { id: "u1", name: "One", avatarUrl: null }, 0)

    expect(getThread("t-order")?.participants.map((p) => p.id)).toEqual(["u1", "u2"])
  })

  // --- threadDisplayName ---
  describe("threadDisplayName", () => {
    it("returns the thread title when set", () => {
      const t = { title: "Team Alpha", participants: [{ id: "u1", name: "Alice" }] }
      expect(threadDisplayName(t, "u1")).toBe("Team Alpha")
    })

    it("returns first names of other participants when no title", () => {
      const t = {
        title: null,
        participants: [
          { id: "me", name: "Alice Smith" },
          { id: "u2", name: "Bob Jones" },
          { id: "u3", name: "Charlie Brown" },
        ],
      }
      expect(threadDisplayName(t, "me")).toBe("Bob, Charlie")
    })

    it("returns 'Just you' when current user is the only participant", () => {
      const t = { title: null, participants: [{ id: "me", name: "Alice" }] }
      expect(threadDisplayName(t, "me")).toBe("Just you")
    })
  })

  // --- addParticipantToThread dedup ---
  describe("addParticipantToThread dedup", () => {
    it("does not add a participant who is already in the thread", () => {
      handleThreadEvent("create", {
        id: "t-dedup",
        handle: "thread-dedup",
        title: null,
        isPinned: false,
        participants: [{ id: "u1", name: "Alice", avatarUrl: null }],
      })
      addParticipantToThread("t-dedup", { id: "u1", name: "Alice", avatarUrl: null })
      expect(getThread("t-dedup")?.participants).toHaveLength(1)
    })
  })

  // --- Dual-structure tests ---
  describe("dual-structure thread store", () => {
    it("getThread returns O(1) lookup", () => {
      addThread(makeThread({ id: "t1", title: "First" }))
      expect(getThread("t1")?.title).toBe("First")
      expect(getThread("nonexistent")).toBeUndefined()
    })

    it("addThread preserves existing lastMessage and unreadCount when detail payload omits them", () => {
      // Simulate the list-fetch path: thread arrives with lastMessage + unreadCount.
      addThread({
        id: "t1",
        handle: "thread-1",
        title: "Alice",
        isPinned: false,
        isPinnedByUser: false,
        participants: [],
        lastMessage: {
          content: "chaos message",
          authorId: "u-alice",
          authorName: "Alice Chen",
          createdAt: "2026-05-08T00:18:00.000Z",
        },
        unreadCount: 1,
        updatedAt: "2026-05-08T00:18:00.000Z",
      })
      // Now the user clicks the thread. The detail endpoint
      // (`GET /threads/:id`) does not return `lastMessage` or `unreadCount`;
      // these fields are simply absent from the payload.
      addThread({
        id: "t1",
        handle: "thread-1",
        title: "Alice",
        type: "thread",
        isPinned: false,
        isPinnedByUser: false,
        participants: [],
        updatedAt: "2026-05-08T00:18:00.000Z",
      })
      const t = getThread("t1")
      expect(t?.lastMessage?.content).toBe("chaos message")
      expect(t?.unreadCount).toBe(1)
    })

    it("pinned threads appear in pinnedThreads()", () => {
      addThread(makeThread({ id: "t1", isPinned: true }))
      addThread(makeThread({ id: "t2", isPinned: false }))
      expect(pinnedThreads().map((t) => t.id)).toEqual(["t1"])
      expect(unpinnedThreads().map((t) => t.id)).toEqual(["t2"])
    })

    it("handleMessageEvent moves unpinned thread to top of unpinnedIds", () => {
      addThread(makeThread({ id: "t1", isPinned: false, updatedAt: "2026-01-01" }))
      addThread(makeThread({ id: "t2", isPinned: false, updatedAt: "2026-01-02" }))
      handleMessageEvent(
        "create",
        {
          threadId: "t1",
          content: "new",
          authorId: "u1",
          authorName: "U",
          createdAt: new Date().toISOString(),
        },
        {},
      )
      expect(unpinnedThreads()[0].id).toBe("t1")
    })

    it("handleMessageEvent does NOT move pinned thread", () => {
      addThread(makeThread({ id: "t1", isPinned: true }))
      addThread(makeThread({ id: "t2", isPinned: true }))
      addThread(makeThread({ id: "t3", isPinned: false }))
      const pinnedBefore = pinnedThreads().map((t) => t.id)
      handleMessageEvent(
        "create",
        {
          threadId: "t2",
          content: "msg",
          authorId: "u1",
          authorName: "U",
          createdAt: new Date().toISOString(),
        },
        {},
      )
      // Pinned order is unchanged
      expect(pinnedThreads().map((t) => t.id)).toEqual(pinnedBefore)
    })

    it("setThreadPinned moves thread between partitions", () => {
      addThread(makeThread({ id: "t1", isPinned: false }))
      expect(unpinnedThreads().map((t) => t.id)).toEqual(["t1"])
      setThreadPinned("t1", true)
      expect(pinnedThreads().map((t) => t.id)).toEqual(["t1"])
      expect(unpinnedThreads()).toEqual([])
    })

    it("userPinnedThreads separates from org-pinned", () => {
      addThread(makeThread({ id: "t1", isPinned: true }))
      addThread(makeThread({ id: "t2", isPinnedByUser: true }))
      addThread(makeThread({ id: "t3" }))
      expect(pinnedThreads().map((t) => t.id)).toEqual(["t1"])
      expect(userPinnedThreads().map((t) => t.id)).toEqual(["t2"])
      expect(unpinnedThreads().map((t) => t.id)).toEqual(["t3"])
    })
  })

  // --- totalUnreadCount (Task 3) ---
  describe("totalUnreadCount", () => {
    it("sums unreadCount across all threads", () => {
      addThread(makeThread({ id: "t1", unreadCount: 2 }))
      addThread(makeThread({ id: "t2", unreadCount: 3 }))
      expect(totalUnreadCount()).toBe(5)
    })

    it("excludes muted threads from the sum", () => {
      addThread(makeThread({ id: "t1", unreadCount: 2 }))
      addThread(makeThread({ id: "t2", unreadCount: 3 }))
      setThreadMuted("t2", true)
      expect(totalUnreadCount()).toBe(2)
    })

    it("is 0 for an empty store", () => {
      expect(totalUnreadCount()).toBe(0)
    })

    it("removeThread (the archive path) drops its unreadCount from the total", () => {
      addThread(makeThread({ id: "t1", unreadCount: 2 }))
      addThread(makeThread({ id: "t2", unreadCount: 4 }))
      expect(totalUnreadCount()).toBe(6)
      removeThread("t2")
      expect(totalUnreadCount()).toBe(2)
    })

    it("increments on a WS message for a background thread and clears on markThreadRead-equivalent reset", () => {
      addThread(makeThread({ id: "t1", unreadCount: 0 }))
      handleMessageEvent(
        "create",
        {
          threadId: "t1",
          content: "hi",
          authorId: "u2",
          authorName: "Bob",
          createdAt: new Date().toISOString(),
        },
        { isVisibleActiveThread: false, isOwnAction: false },
      )
      expect(totalUnreadCount()).toBe(1)
      resetUnreadCount("t1")
      expect(totalUnreadCount()).toBe(0)
    })
  })
})

describe("thread store - agent participants and discoverability (P4b-T01)", () => {
  beforeEach(() => {
    resetThreadStore()
  })

  it("loadThreads carries participantType and agentId on each thread participant", async () => {
    const api = {
      get: async () => ({
        data: [
          {
            id: "t-agent",
            handle: "@support",
            title: "Support",
            discoverable: true,
            participants: [
              { id: "u1", name: "Alice", avatarUrl: null },
              {
                id: "a1",
                name: "Support",
                avatarUrl: null,
                participantType: "agent",
                agentId: "11111111-1111-4111-8111-111111111111",
              },
            ],
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
    }
    await loadThreads(api)
    const t = getThread("t-agent")!
    expect(t.discoverable).toBe(true)
    expect(t.participants[0].participantType).toBe("user")
    expect(t.participants[0].agentId).toBeNull()
    expect(t.participants[1].participantType).toBe("agent")
    expect(t.participants[1].agentId).toBe("11111111-1111-4111-8111-111111111111")
  })

  it("handleThreadEvent create normalizes participantType on the websocket path", () => {
    handleThreadEvent("create", {
      id: "t-ws",
      handle: "@ws",
      title: "Ws",
      discoverable: false,
      participants: [
        {
          id: "a2",
          name: "Logistics",
          avatarUrl: null,
          participantType: "agent",
          agentId: "22222222-2222-4222-8222-222222222222",
        },
      ],
    })
    const t = getThread("t-ws")!
    expect(t.discoverable).toBe(false)
    expect(t.participants[0].participantType).toBe("agent")
    expect(t.participants[0].agentId).toBe("22222222-2222-4222-8222-222222222222")
  })
})

// P4c-T51: only the thread read model carries the agent context boundary. A
// listing refresh says nothing about it, so a merge that let absence win would
// erase the position a moment after it was read.
describe("thread store — agentContextFrom", () => {
  beforeEach(() => resetThreadStore())

  it("keeps a known agentContextFrom when a later write omits the field", async () => {
    addThread({
      id: "t-cp",
      handle: "@cp",
      title: null,
      participants: [{ id: "u1", name: "User", avatarUrl: null }],
      agentContextFrom: "m-42",
    })
    expect(getThread("t-cp")?.agentContextFrom).toBe("m-42")

    addThread({ id: "t-cp", handle: "@cp", title: null, participants: [] })
    expect(getThread("t-cp")?.agentContextFrom).toBe("m-42")

    // A listing refresh rebuilds the store wholesale and carries no boundary
    // at all: the open thread must not lose the one it was told.
    const api = {
      get: async () => ({
        data: [{ id: "t-cp", handle: "@cp", title: null, participants: [] }],
      }),
    }
    await loadThreads(api)
    expect(getThread("t-cp")?.agentContextFrom).toBe("m-42")

    // An explicit null is the read model saying "no checkpoint" and does win.
    addThread({ id: "t-cp", handle: "@cp", title: null, participants: [], agentContextFrom: null })
    expect(getThread("t-cp")?.agentContextFrom).toBeNull()
  })
})

// The composer's model chip resolves "Default (...)" against the seated
// agent's own default. Two surfaces can show one conversation at once (the
// dock and the main panel), so the pair lives on the store: a listing refresh,
// which carries neither field, must not erase what a detail read established.
describe("the thread's model pair", () => {
  beforeEach(() => {
    resetThreadStore()
  })

  it("keeps the agent's default model from the detail read", () => {
    addThread({
      id: "t-model",
      handle: "model",
      type: "thread",
      participants: [],
      agentModelId: null,
      agentDefaultModelId: "gemini-flash-lite-latest",
    })
    expect(getThread("t-model")?.agentDefaultModelId).toBe("gemini-flash-lite-latest")
  })

  it("a listing refresh that carries neither field erases neither", () => {
    addThread({
      id: "t-model",
      handle: "model",
      type: "thread",
      participants: [],
      agentModelId: "claude-opus-4-5",
      agentDefaultModelId: "gemini-flash-lite-latest",
    })
    // What `loadThreads` hands back: no model fields at all.
    addThread({ id: "t-model", handle: "model", type: "thread", participants: [] })
    expect(getThread("t-model")?.agentDefaultModelId).toBe("gemini-flash-lite-latest")
    expect(getThread("t-model")?.agentModelId).toBe("claude-opus-4-5")
  })
})
