// SPDX-License-Identifier: FSL-1.1-ALv2
import { PERSONAL_AGENT_DISPLAY_NAME } from "@liaison/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import {
  _pendingAttachmentUpdatesSize,
  _pendingSubRunUpdatesSize,
  _setLoadingMore,
  addOptimisticMessage,
  addReaction,
  editMessage,
  getAgentStream,
  getHiddenRuns,
  getLiveAgentStreams,
  getMessage,
  getMessages,
  handleWsAgentStreamEvent,
  handleWsMessageEvent,
  handleWsReactionEvent,
  handleWsSubRunUpdate,
  holdTurnScopeUntilAgentTurnEnds,
  loadMessages,
  loadMessagesIntoStore,
  loadMoreMessages,
  MAX_PENDING_SUB_RUN_UPDATES,
  messageStore,
  removeReaction,
  resetMessageStore,
  sendMessage,
  setHiddenRuns,
} from "~/modules/threads/message-store"

const threadId = "t-test"

function makeSeedMessage(overrides: Partial<any> = {}) {
  return {
    id: "m1",
    threadId,
    authorId: "u1",
    authorName: "Alice",
    authorAvatarUrl: null,
    authorType: "user",
    authorAgentId: null,
    content: "Hello",
    mentions: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function makeMessage(overrides: Partial<any> = {}) {
  return makeSeedMessage(overrides)
}

describe("message store — stateful", () => {
  beforeEach(() => {
    resetMessageStore()
    loadMessagesIntoStore(threadId, [makeSeedMessage()])
  })

  it("WS create appends new message", () => {
    handleWsMessageEvent("create", {
      id: "m2",
      threadId,
      content: "World",
      authorId: "u2",
      authorName: "Bob",
      createdAt: "2026-01-01T00:01:00Z",
    })
    expect(getMessages(threadId)).toHaveLength(2)
    expect(getMessage(threadId, "m2")?.content).toBe("World")
  })

  it("WS update modifies existing message content", () => {
    handleWsMessageEvent("update", {
      id: "m1",
      threadId,
      content: "Hello (edited)",
      editedAt: "2026-01-01T00:02:00Z",
    })
    expect(getMessage(threadId, "m1")?.content).toBe("Hello (edited)")
    expect(getMessage(threadId, "m1")?.editedAt).toBeTruthy()
  })

  // A message's files are reparented onto it AFTER the insert, so the
  // `message:create` event carries no attachments. Without the follow-up
  // update every participant other than the sender saw the message bare until
  // they reloaded the page.
  it("WS update applies attachments to a message that arrived without them", () => {
    handleWsMessageEvent("create", {
      id: "m2",
      threadId,
      content: "see attached",
      authorId: "u2",
      authorName: "Morgan",
      createdAt: "2026-01-01T00:01:00Z",
    })
    expect(getMessage(threadId, "m2")?.attachments ?? []).toHaveLength(0)

    handleWsMessageEvent("update", {
      id: "m2",
      threadId,
      attachments: [{ id: "f1", filename: "spec.pdf", mimeType: "application/pdf", sizeBytes: 12 }],
    })
    expect(getMessage(threadId, "m2")?.attachments).toHaveLength(1)
    expect(getMessage(threadId, "m2")?.attachments?.[0].filename).toBe("spec.pdf")
    // Content is untouched by an attachments-only update.
    expect(getMessage(threadId, "m2")?.content).toBe("see attached")
  })

  it("WS attachments update that outruns its create is replayed on the create", () => {
    handleWsMessageEvent("update", {
      id: "m2",
      threadId,
      attachments: [{ id: "f1", filename: "spec.pdf", mimeType: "application/pdf", sizeBytes: 12 }],
    })
    expect(_pendingAttachmentUpdatesSize()).toBe(1)

    handleWsMessageEvent("create", {
      id: "m2",
      threadId,
      content: "see attached",
      authorId: "u2",
      authorName: "Morgan",
      createdAt: "2026-01-01T00:01:00Z",
    })
    expect(getMessage(threadId, "m2")?.attachments).toHaveLength(1)
    expect(_pendingAttachmentUpdatesSize()).toBe(0)
  })

  it("WS attachments update for an unloaded thread is not buffered", () => {
    handleWsMessageEvent("update", {
      id: "m9",
      threadId: "t-not-loaded",
      attachments: [{ id: "f1", filename: "spec.pdf", mimeType: "application/pdf", sizeBytes: 12 }],
    })
    expect(_pendingAttachmentUpdatesSize()).toBe(0)
  })

  it("WS delete nulls content and sets deletedAt", () => {
    handleWsMessageEvent("delete", { id: "m1", threadId })
    expect(getMessage(threadId, "m1")?.content).toBeNull()
    expect(getMessage(threadId, "m1")?.deletedAt).toBeTruthy()
  })

  it("WS create deduplicates by message id", () => {
    handleWsMessageEvent("create", {
      id: "m1",
      threadId,
      content: "Duplicate",
      authorId: "u1",
      authorName: "Alice",
      createdAt: "2026-01-01T00:00:00Z",
    })
    expect(getMessages(threadId)).toHaveLength(1)
  })

  it("WS create is no-op for unloaded thread", () => {
    handleWsMessageEvent("create", {
      id: "msg-x",
      threadId: "t-not-loaded",
      content: "hello",
      authorId: "u1",
      authorName: "Alice",
      createdAt: new Date().toISOString(),
    })
    expect(messageStore.threads["t-not-loaded"]).toBeUndefined()
  })

  it("evictThreadMessages drops messages + agent stream for the thread only", async () => {
    const { evictThreadMessages } = await import("~/modules/threads/message-store")
    loadMessagesIntoStore("other-thread", [
      makeSeedMessage({ id: "m-other", threadId: "other-thread" }),
    ])
    expect(getMessages(threadId)).toHaveLength(1)

    evictThreadMessages(threadId)

    expect(messageStore.threads[threadId]).toBeUndefined()
    expect(getAgentStream(threadId)).toEqual(getAgentStream("never-loaded"))
    // Other thread's data is untouched.
    expect(getMessages("other-thread")).toHaveLength(1)
  })
})

describe("handleWsReactionEvent — stateful", () => {
  beforeEach(() => {
    resetMessageStore()
    loadMessagesIntoStore(threadId, [makeSeedMessage()])
  })

  it("WS reaction add creates new reaction entry", () => {
    handleWsReactionEvent("add", {
      threadId,
      messageId: "m1",
      userId: "u2",
      emoji: "👍",
      userName: "Bob",
    })
    const msg = getMessage(threadId, "m1")!
    expect(msg.reactions).toHaveLength(1)
    expect(msg.reactions[0].emoji).toBe("👍")
    expect(msg.reactions[0].count).toBe(1)
  })

  it("WS reaction add increments existing reaction", () => {
    handleWsReactionEvent("add", {
      threadId,
      messageId: "m1",
      userId: "u2",
      emoji: "👍",
      userName: "Bob",
    })
    handleWsReactionEvent("add", {
      threadId,
      messageId: "m1",
      userId: "u3",
      emoji: "👍",
      userName: "Charlie",
    })
    const msg = getMessage(threadId, "m1")!
    expect(msg.reactions[0].count).toBe(2)
    expect(msg.reactions[0].users).toHaveLength(2)
  })

  it("WS reaction sets reacted flag for current user", () => {
    handleWsReactionEvent("add", { threadId, messageId: "m1", userId: "u1", emoji: "👍" }, "u1")
    expect(getMessage(threadId, "m1")!.reactions[0].reacted).toBe(true)
  })

  it("WS reaction does not set reacted flag for other user (J6)", () => {
    handleWsReactionEvent(
      "add",
      { threadId, messageId: "m1", userId: "u2", emoji: "👍", userName: "Bob" },
      "u1",
    )
    expect(getMessage(threadId, "m1")!.reactions[0].reacted).toBe(false)
  })

  it("WS reaction remove decrements and cleans up", () => {
    handleWsReactionEvent("add", { threadId, messageId: "m1", userId: "u1", emoji: "👍" }, "u1")
    handleWsReactionEvent("remove", { threadId, messageId: "m1", userId: "u1", emoji: "👍" }, "u1")
    expect(getMessage(threadId, "m1")!.reactions).toHaveLength(0)
  })

  it("WS reaction remove replayed does not take a second person off", () => {
    handleWsReactionEvent("add", { threadId, messageId: "m1", userId: "u2", emoji: "👍" }, "u1")
    handleWsReactionEvent("add", { threadId, messageId: "m1", userId: "u3", emoji: "👍" }, "u1")
    handleWsReactionEvent("remove", { threadId, messageId: "m1", userId: "u3", emoji: "👍" }, "u1")
    handleWsReactionEvent("remove", { threadId, messageId: "m1", userId: "u3", emoji: "👍" }, "u1")
    const msg = getMessage(threadId, "m1")!
    expect(msg.reactions[0].count).toBe(1)
    expect(msg.reactions[0].users.map((u) => u.id)).toEqual(["u2"])
  })

  it("does nothing for unloaded thread", () => {
    handleWsReactionEvent("add", {
      threadId: "unloaded",
      messageId: "msg1",
      userId: "u1",
      emoji: "👍",
    })
    expect(messageStore.threads.unloaded).toBeUndefined()
  })

  it("WS reaction dedup — same user+emoji replayed does not double count", () => {
    handleWsReactionEvent("add", {
      threadId,
      messageId: "m1",
      userId: "u2",
      emoji: "👍",
      userName: "Bob",
    })
    handleWsReactionEvent("add", {
      threadId,
      messageId: "m1",
      userId: "u2",
      emoji: "👍",
      userName: "Bob",
    })
    const msg = getMessage(threadId, "m1")!
    expect(msg.reactions[0].count).toBe(1)
    expect(msg.reactions[0].users).toHaveLength(1)
  })
})

describe("handleWsAgentStreamEvent", () => {
  beforeEach(() => {
    resetMessageStore()
  })

  it("accumulates deltas and tool updates for a thread", () => {
    handleWsAgentStreamEvent("start", { threadId })
    handleWsAgentStreamEvent("tool_call", {
      threadId,
      toolCallId: "tc1",
      toolName: "search_threads",
      args: { q: "demo" },
    })
    handleWsAgentStreamEvent("delta", { threadId, delta: "Hello " })
    handleWsAgentStreamEvent("delta", { threadId, delta: "world" })
    handleWsAgentStreamEvent("tool_result", {
      threadId,
      toolCallId: "tc1",
      result: { items: [] },
    })
    handleWsAgentStreamEvent("done", { threadId })

    expect(getAgentStream(threadId)).toMatchObject({
      state: "complete",
      content: "Hello world",
    })
    expect(getAgentStream(threadId).toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "tc1",
        toolName: "search_threads",
        status: "completed",
      }),
    ])
  })

  it("accumulates reasoning deltas and collapses when the answer begins", () => {
    handleWsAgentStreamEvent("start", { threadId })
    handleWsAgentStreamEvent("reasoning", { threadId, delta: "Let me " })
    handleWsAgentStreamEvent("reasoning", { threadId, delta: "think..." })

    // While reasoning streams, the live thinking block is "open".
    expect(getAgentStream(threadId)).toMatchObject({
      reasoning: "Let me think...",
      reasoningStreaming: true,
      content: "",
    })

    // The first answer delta collapses the thinking block but keeps the text.
    handleWsAgentStreamEvent("delta", { threadId, delta: "Answer" })
    expect(getAgentStream(threadId)).toMatchObject({
      reasoning: "Let me think...",
      reasoningStreaming: false,
      content: "Answer",
    })

    handleWsAgentStreamEvent("done", { threadId })
    expect(getAgentStream(threadId).reasoningStreaming).toBe(false)
    expect(getAgentStream(threadId).reasoning).toBe("Let me think...")
  })

  it("clears active stream when the final agent message arrives", () => {
    handleWsAgentStreamEvent("start", { threadId })
    handleWsAgentStreamEvent("delta", { threadId, delta: "Partial" })
    loadMessagesIntoStore(threadId, [])

    handleWsMessageEvent("create", {
      id: "m-agent",
      threadId,
      authorId: "u-agent",
      authorName: "Liaison",
      authorType: "agent",
      authorAgentId: null,
      content: "Final",
      createdAt: "2026-01-01T00:01:00Z",
    })

    expect(getAgentStream(threadId)).toMatchObject({ state: "idle", content: "" })
  })

  it("stores error state for failed streams", () => {
    handleWsAgentStreamEvent("start", { threadId })
    handleWsAgentStreamEvent("delta", { threadId, delta: "Partial" })
    handleWsAgentStreamEvent("error", {
      threadId,
      message: "Provider timeout",
      code: "timeout",
    })

    expect(getAgentStream(threadId)).toMatchObject({
      state: "error",
      content: "Partial",
      error: { message: "Provider timeout", code: "timeout" },
    })
  })
})

describe("WS create — correlation-based dedup", () => {
  beforeEach(() => {
    resetMessageStore()
    // Two pending messages with identical content (the ghost scenario)
    loadMessagesIntoStore(threadId, [
      makeSeedMessage({ id: "pending-1", content: "hello", pending: true }),
      makeSeedMessage({ id: "pending-2", content: "hello", pending: true }),
    ])
  })

  it("deduplicates by correlationId instead of content", () => {
    handleWsMessageEvent("create", {
      id: "real-1",
      threadId,
      content: "hello",
      authorId: "u1",
      authorName: "Alice",
      createdAt: "2026-01-01T00:01:00Z",
      correlationId: "pending-1",
    })
    const msgs = getMessages(threadId)
    // pending-1 should be replaced by real-1, pending-2 should remain
    expect(msgs).toHaveLength(2)
    expect(msgs[0].id).toBe("real-1")
    expect(msgs[0].pending).toBeFalsy()
    expect(msgs[1].id).toBe("pending-2")
    expect(msgs[1].pending).toBe(true)
  })

  it("second WS event replaces second pending by correlationId", () => {
    handleWsMessageEvent("create", {
      id: "real-1",
      threadId,
      content: "hello",
      authorId: "u1",
      authorName: "Alice",
      createdAt: "2026-01-01T00:01:00Z",
      correlationId: "pending-1",
    })
    handleWsMessageEvent("create", {
      id: "real-2",
      threadId,
      content: "hello",
      authorId: "u1",
      authorName: "Alice",
      createdAt: "2026-01-01T00:01:01Z",
      correlationId: "pending-2",
    })
    const msgs = getMessages(threadId)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].id).toBe("real-1")
    expect(msgs[1].id).toBe("real-2")
    expect(msgs.every((m) => !m.pending)).toBe(true)
  })

  it("falls back to content match when no correlationId", () => {
    handleWsMessageEvent("create", {
      id: "real-1",
      threadId,
      content: "hello",
      authorId: "u1",
      authorName: "Alice",
      createdAt: "2026-01-01T00:01:00Z",
      // no correlationId
    })
    const msgs = getMessages(threadId)
    // Content fallback replaces one of the pending messages
    expect(msgs).toHaveLength(2)
    expect(msgs.some((m) => m.id === "real-1")).toBe(true)
  })
})

describe("WS create — agent metadata upgrade on duplicate", () => {
  beforeEach(() => {
    resetMessageStore()
    // Seed an empty thread so the create handler (which requires an existing
    // thread) applies, and each test starts with no messages.
    loadMessagesIntoStore(threadId, [])
  })

  const agentCreate = (metadata: unknown) =>
    handleWsMessageEvent("create", {
      id: "agent-1",
      threadId,
      content: "Here is the answer.",
      authorId: "agent",
      authorName: "Liaison",
      authorType: "agent",
      authorAgentId: null,
      createdAt: "2026-01-01T00:01:00Z",
      metadata,
    })

  it("upgrades a metadata-less message when the richer duplicate arrives second", () => {
    // Outbox event lands first with null metadata (metadata is written after INSERT).
    agentCreate(null)
    // Finalize broadcast lands second with the full toolCalls + timeline.
    agentCreate({
      toolCalls: [{ toolCallId: "t1", toolName: "kernel__thread_search", status: "completed" }],
      timeline: [
        { kind: "reasoning", text: "think" },
        { kind: "tool", toolCallId: "t1" },
      ],
    })
    const msg = getMessages(threadId).find((m) => m.id === "agent-1")
    expect(msg?.metadata?.toolCalls).toHaveLength(1)
    expect(msg?.metadata?.timeline).toHaveLength(2)
  })

  it("never downgrades: a later null-metadata duplicate does not wipe rich metadata", () => {
    // Ephemeral (rich) wins the race first…
    agentCreate({
      toolCalls: [{ toolCallId: "t1", toolName: "kernel__thread_search", status: "completed" }],
      timeline: [{ kind: "tool", toolCallId: "t1" }],
    })
    // …then the metadata-less outbox event arrives — must NOT clobber it.
    agentCreate(null)
    const msg = getMessages(threadId).find((m) => m.id === "agent-1")
    expect(msg?.metadata?.toolCalls).toHaveLength(1)
    expect(msg?.metadata?.timeline).toHaveLength(1)
  })

  // Regression: a finished session's post-back (`kind`/`sessionId`, no turn
  // fields) whose outbox copy (label only) landed first kept the label-only
  // metadata, so its row never carried `data-session-result` and the guided
  // step anchored on it waited for a refetch.
  it("adds a post's own fields (kind, sessionId) the outbox copy lacked", () => {
    agentCreate({ agentAuthorLabel: "Ada's agent" })
    agentCreate({ agentAuthorLabel: "Ada's agent", kind: "node_session_result", sessionId: "s-1" })
    const meta = getMessages(threadId).find((m) => m.id === "agent-1")?.metadata as
      | Record<string, unknown>
      | undefined
    expect(meta?.kind).toBe("node_session_result")
    expect(meta?.sessionId).toBe("s-1")
    expect(meta?.agentAuthorLabel).toBe("Ada's agent")
  })

  it("adds a post's fields onto a null-metadata copy, and a later label-only copy keeps them", () => {
    agentCreate(null)
    agentCreate({ kind: "node_session_result", sessionId: "s-1" })
    agentCreate({ agentAuthorLabel: "Ada's agent" })
    const meta = getMessages(threadId).find((m) => m.id === "agent-1")?.metadata as
      | Record<string, unknown>
      | undefined
    expect(meta?.kind).toBe("node_session_result")
    expect(meta?.sessionId).toBe("s-1")
    expect(meta?.agentAuthorLabel).toBe("Ada's agent")
  })
})

describe("loadMessages background refetch (agent tab blank-flash regression)", () => {
  // Regression (ticket-9947): every resync bump refetched the open agent chat
  // and REPLACED the whole { ids, byId } thread object, breaking identity for
  // every message row — the list fully re-rendered (blank flash) and the
  // "Loading messages..." block flipped on. A background refetch must keep
  // row object identity for unchanged messages and never re-enter loading.
  const page = (msgs: any[]) => ({
    get: vi.fn().mockResolvedValue({ data: [...msgs].reverse() }), // API returns DESC
  })

  beforeEach(() => resetMessageStore())

  it("initial load sets loading, background refetch does not", async () => {
    const api = page([makeSeedMessage()])
    const p = loadMessages(api as any, threadId)
    expect(messageStore.loading[threadId]).toBe(true)
    await p
    expect(messageStore.loading[threadId]).toBe(false)

    const api2 = page([makeSeedMessage({ content: "Hello v2" })])
    const p2 = loadMessages(api2 as any, threadId)
    expect(messageStore.loading[threadId]).toBe(false) // background: no loading flip
    await p2
    expect(getMessage(threadId, "m1")?.content).toBe("Hello v2")
  })

  it("refetch preserves object identity of unchanged messages and keeps optimistic tails", async () => {
    await loadMessages(page([makeSeedMessage()]) as any, threadId)
    // A not-yet-echoed optimistic send must survive the refetch.
    addOptimisticMessage(
      threadId,
      makeSeedMessage({ id: "optimistic-msg-1", content: "sending..." }),
    )
    const before = getMessage(threadId, "m1")
    await loadMessages(
      page([makeSeedMessage(), makeSeedMessage({ id: "m2", content: "reply" })]) as any,
      threadId,
    )
    const after = getMessage(threadId, "m1")
    expect(after).toBe(before) // same object — rows keyed on it do not remount
    expect(getMessages(threadId).map((m) => m.id)).toEqual(["m1", "m2", "optimistic-msg-1"])
  })

  it("refetch drops messages the server no longer returns within the fetched window", async () => {
    await loadMessages(page([makeSeedMessage(), makeSeedMessage({ id: "m2" })]) as any, threadId)
    await loadMessages(page([makeSeedMessage()]) as any, threadId)
    expect(getMessages(threadId).map((m) => m.id)).toEqual(["m1"])
  })
})

describe("optimistic reactions", () => {
  const mockApi = {
    post: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  }

  beforeEach(() => {
    resetMessageStore()
    vi.clearAllMocks()
    loadMessagesIntoStore(threadId, [makeSeedMessage()])
  })

  it("addReaction applies optimistic update immediately", async () => {
    const promise = addReaction(mockApi as any, threadId, "m1", "👍", { id: "u1", name: "Alice" })
    // Optimistic: reaction visible before API resolves
    const reactions = getMessage(threadId, "m1")!.reactions
    expect(reactions).toHaveLength(1)
    expect(reactions[0].emoji).toBe("👍")
    expect(reactions[0].reacted).toBe(true)
    await promise
  })

  it("addReaction rolls back on API failure", async () => {
    mockApi.post.mockRejectedValueOnce(new Error("fail"))
    await addReaction(mockApi as any, threadId, "m1", "👍", { id: "u1", name: "Alice" })
    const reactions = getMessage(threadId, "m1")!.reactions
    expect(reactions).toHaveLength(0)
  })

  it("removeReaction applies optimistic update immediately", async () => {
    // Seed a reaction first
    loadMessagesIntoStore(threadId, [
      makeSeedMessage({
        reactions: [{ emoji: "👍", count: 1, users: [{ id: "u1", name: "Alice" }], reacted: true }],
      }),
    ])
    const promise = removeReaction(mockApi as any, threadId, "m1", "👍", {
      id: "u1",
      name: "Alice",
    })
    const reactions = getMessage(threadId, "m1")!.reactions
    expect(reactions).toHaveLength(0)
    await promise
  })

  it("removeReaction rolls back on API failure", async () => {
    loadMessagesIntoStore(threadId, [
      makeSeedMessage({
        reactions: [{ emoji: "👍", count: 1, users: [{ id: "u1", name: "Alice" }], reacted: true }],
      }),
    ])
    mockApi.delete.mockRejectedValueOnce(new Error("fail"))
    await removeReaction(mockApi as any, threadId, "m1", "👍", { id: "u1", name: "Alice" })
    const reactions = getMessage(threadId, "m1")!.reactions
    expect(reactions).toHaveLength(1)
    expect(reactions[0].reacted).toBe(true)
  })

  it("removeReaction rolls back when backend returns removed: false", async () => {
    loadMessagesIntoStore(threadId, [
      makeSeedMessage({
        reactions: [
          {
            emoji: "👍",
            count: 2,
            users: [
              { id: "u1", name: "Alice" },
              { id: "u2", name: "Bob" },
            ],
            reacted: true,
          },
        ],
      }),
    ])
    mockApi.delete.mockResolvedValueOnce({ removed: false })
    await removeReaction(mockApi as any, threadId, "m1", "👍", { id: "u1", name: "Alice" })
    const reactions = getMessage(threadId, "m1")!.reactions
    expect(reactions).toHaveLength(1)
    expect(reactions[0].count).toBe(2)
    expect(reactions[0].reacted).toBe(true)
  })

  it("removing your reaction next to someone else's keeps theirs when the WS echo arrives", async () => {
    loadMessagesIntoStore(threadId, [
      makeSeedMessage({
        reactions: [
          {
            emoji: "👌",
            count: 2,
            users: [
              { id: "u2", name: "Bob" },
              { id: "u1", name: "Alice" },
            ],
            reacted: true,
          },
        ],
      }),
    ])
    await removeReaction(mockApi as any, threadId, "m1", "👌", { id: "u1", name: "Alice" })
    // The server's echo of the same removal.
    handleWsReactionEvent("remove", { threadId, messageId: "m1", userId: "u1", emoji: "👌" }, "u1")
    const reactions = getMessage(threadId, "m1")!.reactions
    expect(reactions).toHaveLength(1)
    expect(reactions[0].count).toBe(1)
    expect(reactions[0].users).toEqual([{ id: "u2", name: "Bob" }])
    expect(reactions[0].reacted).toBe(false)
  })

  it("adding a reaction the viewer already has sends nothing: a repeat is never a toggle", async () => {
    loadMessagesIntoStore(threadId, [
      makeSeedMessage({
        reactions: [{ emoji: "👍", count: 1, users: [{ id: "u1", name: "Alice" }], reacted: true }],
      }),
    ])
    await addReaction(mockApi as any, threadId, "m1", "👍", { id: "u1", name: "Alice" })
    expect(mockApi.post).not.toHaveBeenCalled()
    expect(getMessage(threadId, "m1")!.reactions[0].count).toBe(1)
  })

  it("the same add delivered twice posts once", async () => {
    await Promise.all([
      addReaction(mockApi as any, threadId, "m1", "👍", { id: "u1", name: "Alice" }),
      addReaction(mockApi as any, threadId, "m1", "👍", { id: "u1", name: "Alice" }),
    ])
    expect(mockApi.post).toHaveBeenCalledTimes(1)
    expect(getMessage(threadId, "m1")!.reactions[0].count).toBe(1)
  })

  it("removing a reaction the viewer does not have sends nothing and takes no one off", async () => {
    loadMessagesIntoStore(threadId, [
      makeSeedMessage({
        reactions: [{ emoji: "👌", count: 1, users: [{ id: "u2", name: "Bob" }], reacted: false }],
      }),
    ])
    await removeReaction(mockApi as any, threadId, "m1", "👌", { id: "u1", name: "Alice" })
    expect(mockApi.delete).not.toHaveBeenCalled()
    expect(getMessage(threadId, "m1")!.reactions[0].count).toBe(1)
  })
})

describe("loadMoreMessages", () => {
  beforeEach(() => {
    resetMessageStore()
    loadMessagesIntoStore(threadId, [
      makeSeedMessage({ id: "m1", createdAt: "2026-01-01T00:00:00Z" }),
    ])
    messageStore.hasMore[threadId] // ensure keyed
  })

  it("prepends older messages in ASC order", async () => {
    const mockApi = {
      get: vi.fn().mockResolvedValue({
        data: [
          { ...makeSeedMessage({ id: "m-old2", createdAt: "2025-12-31T23:59:01Z" }) },
          { ...makeSeedMessage({ id: "m-old1", createdAt: "2025-12-31T23:59:00Z" }) },
        ],
      }),
    }
    // API returns DESC; store should receive them ASC (oldest first)
    await loadMoreMessages(mockApi as any, threadId)
    const ids = messageStore.threads[threadId].ids
    expect(ids[0]).toBe("m-old1")
    expect(ids[1]).toBe("m-old2")
    expect(ids[2]).toBe("m1")
  })

  it("sets hasMore=false when fewer than 50 messages returned", async () => {
    const mockApi = { get: vi.fn().mockResolvedValue({ data: [makeSeedMessage({ id: "m-old" })] }) }
    await loadMoreMessages(mockApi as any, threadId)
    expect(messageStore.hasMore[threadId]).toBe(false)
  })

  it("sets hasMore=true when exactly 50 messages returned", async () => {
    const msgs = Array.from({ length: 50 }, (_, i) => makeSeedMessage({ id: `m-old-${i}` }))
    const mockApi = { get: vi.fn().mockResolvedValue({ data: msgs }) }
    await loadMoreMessages(mockApi as any, threadId)
    expect(messageStore.hasMore[threadId]).toBe(true)
  })

  it("is a no-op when loadingMore is already true", async () => {
    _setLoadingMore(threadId, true)
    const mockApi = { get: vi.fn() }
    await loadMoreMessages(mockApi as any, threadId)
    expect(mockApi.get).not.toHaveBeenCalled()
  })

  it("deduplicates messages already in store", async () => {
    const mockApi = {
      get: vi.fn().mockResolvedValue({ data: [makeSeedMessage({ id: "m1" })] }), // m1 already exists
    }
    await loadMoreMessages(mockApi as any, threadId)
    const ids = messageStore.threads[threadId].ids
    expect(ids.filter((id) => id === "m1")).toHaveLength(1)
  })
})

describe("sendMessage — optimistic insert + rollback", () => {
  const user = { id: "u1", name: "Alice" }

  beforeEach(() => {
    resetMessageStore()
    loadMessagesIntoStore(threadId, [])
  })

  it("inserts pending message immediately before API resolves", async () => {
    let resolveSend!: (v: any) => void
    const mockApi = {
      post: vi.fn(
        () =>
          new Promise((r) => {
            resolveSend = r
          }),
      ),
    }

    const promise = sendMessage(mockApi as any, threadId, "hello", user)
    const msgs = getMessages(threadId)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe("hello")
    expect(msgs[0].pending).toBe(true)
    expect(msgs[0].id).toMatch(/^pending-/)

    resolveSend({
      data: {
        id: "real-1",
        threadId,
        content: "hello",
        authorId: user.id,
        authorName: user.name,
        createdAt: new Date().toISOString(),
        reactions: [],
        mentions: null,
        editedAt: null,
        deletedAt: null,
        authorAvatarUrl: null,
        authorType: "user",
        authorAgentId: null,
      },
    })
    await promise
    const finalMsgs = getMessages(threadId)
    expect(finalMsgs).toHaveLength(1)
    expect(finalMsgs[0].id).toBe("real-1")
    expect(finalMsgs[0].pending).toBeFalsy()
  })

  it("removes pending message on API failure and rethrows", async () => {
    const mockApi = { post: vi.fn().mockRejectedValue(new Error("Network error")) }
    await expect(sendMessage(mockApi as any, threadId, "hello", user)).rejects.toThrow(
      "Network error",
    )
    expect(getMessages(threadId)).toHaveLength(0)
  })

  // P4c-T10: parity with the retired agent panel. The thread send must carry the
  // view the user is actually looking at and the mailbox turn nonce, or a turn
  // started from a thread sees neither the app in front of the user nor their
  // encrypted mail.
  it("forwards currentView and turnNonce onto the wire, and omits what it was not given", async () => {
    const mockApi = { post: vi.fn().mockResolvedValue({ data: null }) }
    await sendMessage(mockApi as any, threadId, "hello", user, {
      currentView: { tabType: "ticket", entityId: "t-1" },
      turnNonce: "nonce-abcdef12",
    })
    expect(mockApi.post).toHaveBeenCalledWith(
      `/threads/${threadId}/messages`,
      expect.objectContaining({
        currentView: { tabType: "ticket", entityId: "t-1" },
        turnNonce: "nonce-abcdef12",
      }),
    )

    mockApi.post.mockClear()
    await sendMessage(mockApi as any, threadId, "hello again", user)
    const body = mockApi.post.mock.calls[0][1]
    expect(body).not.toHaveProperty("currentView")
    expect(body).not.toHaveProperty("turnNonce")
    expect(body).not.toHaveProperty("attachmentSessionId")
  })

  // P4c FX-B3 (D3): "Discuss with Liaison" reveals the DM, which MOUNTS the
  // thread view and fires loadMessages, and only then sends. The reload landed
  // while the POST was in flight, and the refetch merge kept only ids prefixed
  // `optimistic-` while this send mints `pending-`: the pending id left `ids`,
  // and the settle path (`if (idx >= 0)`) then dropped the REAL row on the
  // floor. The dock tab showed "No messages yet" with the row in the database.
  it("a message sent while the thread reloads survives the reload and settles to the real row", async () => {
    const reloadApi = { get: vi.fn().mockResolvedValue({ data: [] }) }
    let resolveSend!: (v: any) => void
    const sendApi = {
      post: vi.fn(
        () =>
          new Promise((r) => {
            resolveSend = r
          }),
      ),
    }

    const sent = sendMessage(sendApi as any, threadId, "I want to discuss X", user)
    const pendingId = getMessages(threadId)[0].id
    expect(pendingId).toMatch(/^pending-/)

    // The mount's loadMessages lands first, with a page that cannot yet
    // contain the row the POST is still creating.
    await loadMessages(reloadApi as any, threadId)
    expect(getMessages(threadId).map((m) => m.id)).toEqual([pendingId])

    resolveSend({
      data: {
        id: "real-1",
        threadId,
        content: "I want to discuss X",
        authorId: user.id,
        authorName: user.name,
        createdAt: new Date().toISOString(),
        reactions: [],
        mentions: null,
        editedAt: null,
        deletedAt: null,
        authorAvatarUrl: null,
        authorType: "user",
        authorAgentId: null,
      },
    })
    await sent

    const final = getMessages(threadId)
    expect(final.map((m) => m.id)).toEqual(["real-1"])
    expect(final[0].pending).toBeFalsy()
    expect(final[0].content).toBe("I want to discuss X")
  })
})

// P4c FX-B3 (D5): the api answers the send POST and only THEN dispatches the
// agent turn, so every mailbox decrypt request the turn makes arrives after the
// POST settled. Releasing the turn scope on settle shut the door on all of
// them. The scope now lives as long as the turn does.
describe("mailbox turn scope held across the agent turn", () => {
  beforeEach(() => resetMessageStore())

  it("the mailbox turn scope stays open until the agent turn completes", () => {
    const release = vi.fn()
    holdTurnScopeUntilAgentTurnEnds(threadId, release)

    // The POST has settled; the turn has not even started streaming yet.
    expect(release).not.toHaveBeenCalled()

    handleWsAgentStreamEvent("start", { threadId })
    handleWsAgentStreamEvent("delta", { threadId, delta: "thinking about it" })
    expect(release).not.toHaveBeenCalled()

    // A turn in a DIFFERENT thread ending must not release this scope.
    handleWsAgentStreamEvent("done", { threadId: "other-thread" })
    expect(release).not.toHaveBeenCalled()

    handleWsAgentStreamEvent("done", { threadId })
    expect(getAgentStream(threadId).state).toBe("complete")
    expect(release).toHaveBeenCalledTimes(1)

    // Once released, later frames never release it a second time.
    handleWsAgentStreamEvent("done", { threadId })
    expect(release).toHaveBeenCalledTimes(1)
  })

  // P4c FX-B4 (N2). ComposeBar is not disabled mid-stream, so a user can send
  // again while turn 1 streams. The first terminal frame used to release EVERY
  // scope held on the thread, so send 2 lost its mailbox decrypt permission
  // before its own turn was even dispatched.
  it("a terminal frame releases only the oldest held scope on that thread", () => {
    const first = vi.fn()
    const second = vi.fn()
    holdTurnScopeUntilAgentTurnEnds(threadId, first)
    holdTurnScopeUntilAgentTurnEnds(threadId, second)

    handleWsAgentStreamEvent("done", { threadId })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()

    handleWsAgentStreamEvent("done", { threadId })
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
  })

  it("two overlapping sends each keep their scope until their own turn ends", () => {
    vi.useFakeTimers()
    try {
      const turn1 = vi.fn()
      const turn2 = vi.fn()

      // Send 1: its turn starts streaming.
      holdTurnScopeUntilAgentTurnEnds(threadId, turn1, { timeoutMs: 10_000 })
      handleWsAgentStreamEvent("start", { threadId })
      handleWsAgentStreamEvent("delta", { threadId, delta: "working" })

      // Send 2 lands mid-stream, before turn 1 has ended.
      holdTurnScopeUntilAgentTurnEnds(threadId, turn2, { timeoutMs: 10_000 })

      // Turn 1 ends. Turn 2 has not even dispatched yet: its scope must stand.
      handleWsAgentStreamEvent("done", { threadId })
      expect(turn1).toHaveBeenCalledTimes(1)
      expect(turn2).not.toHaveBeenCalled()

      // Turn 2 now runs, and its own frames keep its scope alive past the
      // inactivity bound.
      handleWsAgentStreamEvent("start", { threadId })
      vi.advanceTimersByTime(9_000)
      handleWsAgentStreamEvent("delta", { threadId, delta: "still working" })
      vi.advanceTimersByTime(9_000)
      expect(turn2).not.toHaveBeenCalled()

      handleWsAgentStreamEvent("done", { threadId })
      expect(turn2).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("the scope is released on error and on the timeout", () => {
    vi.useFakeTimers()
    try {
      const onError = vi.fn()
      holdTurnScopeUntilAgentTurnEnds(threadId, onError)
      handleWsAgentStreamEvent("start", { threadId })
      handleWsAgentStreamEvent("error", { threadId, message: "provider timeout" })
      expect(getAgentStream(threadId).state).toBe("error")
      expect(onError).toHaveBeenCalledTimes(1)

      // A turn that never emits a terminal frame must not hold the scope open
      // forever: the inactivity bound releases it, re-armed by each frame.
      const onTimeout = vi.fn()
      holdTurnScopeUntilAgentTurnEnds(threadId, onTimeout, { timeoutMs: 1000 })
      vi.advanceTimersByTime(900)
      handleWsAgentStreamEvent("delta", { threadId, delta: "still alive" })
      vi.advanceTimersByTime(900)
      expect(onTimeout).not.toHaveBeenCalled()
      vi.advanceTimersByTime(200)
      expect(onTimeout).toHaveBeenCalledTimes(1)

      // The early release a caller holds (unmount, failed send) also works.
      const onUnmount = vi.fn()
      const release = holdTurnScopeUntilAgentTurnEnds(threadId, onUnmount, { timeoutMs: 1000 })
      release()
      expect(onUnmount).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(2000)
      expect(onUnmount).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("editMessage — optimistic update + rollback", () => {
  beforeEach(() => {
    resetMessageStore()
    loadMessagesIntoStore(threadId, [makeSeedMessage({ id: "m1", content: "original" })])
  })

  it("updates content optimistically before API resolves", async () => {
    let resolveEdit!: (v: any) => void
    const mockApi = {
      patch: vi.fn(
        () =>
          new Promise((r) => {
            resolveEdit = r
          }),
      ),
    }

    const promise = editMessage(mockApi as any, threadId, "m1", "edited")
    expect(getMessage(threadId, "m1")?.content).toBe("edited")
    expect(getMessage(threadId, "m1")?.editedAt).toBeTruthy()

    resolveEdit({})
    await promise
    expect(getMessage(threadId, "m1")?.content).toBe("edited")
  })

  it("rolls back content on API failure", async () => {
    const mockApi = { patch: vi.fn().mockRejectedValue(new Error("fail")) }
    await editMessage(mockApi as any, threadId, "m1", "edited")
    expect(getMessage(threadId, "m1")?.content).toBe("original")
    expect(getMessage(threadId, "m1")?.editedAt).toBeNull()
  })

  it("is a no-op for a message that does not exist", async () => {
    const mockApi = { patch: vi.fn() }
    await editMessage(mockApi as any, threadId, "nonexistent", "edited")
    expect(mockApi.patch).not.toHaveBeenCalled()
  })
})

describe("loadMessages — error state", () => {
  beforeEach(() => resetMessageStore())

  it("sets error on fetch failure", async () => {
    const mockApi = { get: vi.fn().mockRejectedValue(new Error("Network error")) }
    await loadMessages(mockApi as any, "t-err")
    expect(messageStore.error["t-err"]).toBe("Network error")
    expect(messageStore.loading["t-err"]).toBe(false)
  })

  it("clears error on successful fetch", async () => {
    const mockApi = { get: vi.fn().mockResolvedValue({ data: [] }) }
    await loadMessages(mockApi as any, "t-err")
    expect(messageStore.error["t-err"]).toBeNull()
  })
})

describe("loadMessages — eviction during in-flight load (C1.2)", () => {
  beforeEach(() => resetMessageStore())

  it("start load, evict mid-flight, resolve -> entry stays absent", async () => {
    const { evictThreadMessages } = await import("~/modules/threads/message-store")
    let resolveGet!: (v: any) => void
    const mockApi = {
      get: vi.fn(
        () =>
          new Promise((r) => {
            resolveGet = r
          }),
      ),
    }

    const loadPromise = loadMessages(mockApi as any, threadId)
    // Evict before the in-flight request resolves.
    evictThreadMessages(threadId)
    expect(messageStore.threads[threadId]).toBeUndefined()

    resolveGet({ data: [makeSeedMessage({ id: "m-late" })] })
    await loadPromise

    // The stale write-back must NOT resurrect the evicted entry.
    expect(messageStore.threads[threadId]).toBeUndefined()
    expect(messageStore.loading[threadId]).toBeUndefined()
  })

  it("loadMoreMessages: start load, evict mid-flight, resolve -> entry stays absent", async () => {
    const { evictThreadMessages } = await import("~/modules/threads/message-store")
    loadMessagesIntoStore(threadId, [makeSeedMessage({ id: "m1" })])

    let resolveGet!: (v: any) => void
    const mockApi = {
      get: vi.fn(
        () =>
          new Promise((r) => {
            resolveGet = r
          }),
      ),
    }

    const loadPromise = loadMoreMessages(mockApi as any, threadId)
    evictThreadMessages(threadId)
    expect(messageStore.threads[threadId]).toBeUndefined()

    resolveGet({ data: [makeSeedMessage({ id: "m-old" })] })
    await loadPromise

    expect(messageStore.threads[threadId]).toBeUndefined()
    expect(messageStore.loadingMore[threadId]).toBeUndefined()
  })
})

describe("dual-structure message store", () => {
  beforeEach(() => resetMessageStore())

  it("getMessage returns O(1) lookup by threadId + messageId", () => {
    loadMessagesIntoStore("t1", [makeMessage({ id: "m1", content: "hello" })])
    expect(getMessage("t1", "m1")?.content).toBe("hello")
  })

  it("getMessage returns undefined for non-existent thread", () => {
    expect(getMessage("nonexistent", "m1")).toBeUndefined()
  })

  it("getMessages preserves insertion order", () => {
    loadMessagesIntoStore("t1", [
      makeMessage({ id: "m1", createdAt: "2026-01-01T00:00:00Z" }),
      makeMessage({ id: "m2", createdAt: "2026-01-02T00:00:00Z" }),
    ])
    expect(getMessages("t1").map((m) => m.id)).toEqual(["m1", "m2"])
  })

  it("delete handler uses server timestamp over client clock", () => {
    loadMessagesIntoStore("t1", [makeMessage({ id: "m1" })])
    handleWsMessageEvent("delete", {
      threadId: "t1",
      id: "m1",
      deletedAt: "2026-03-15T12:00:00Z",
    })
    expect(getMessage("t1", "m1")?.deletedAt).toBe("2026-03-15T12:00:00Z")
  })

  it("getMessages for non-existent thread returns empty array", () => {
    expect(getMessages("nonexistent")).toEqual([])
  })
})

describe("pendingSubRunUpdates — leak sweep", () => {
  beforeEach(() => resetMessageStore())

  it("non-terminal update for an unloaded card buffers one entry", () => {
    handleWsSubRunUpdate({ runId: "run-1", status: "running" })
    expect(_pendingSubRunUpdatesSize()).toBe(1)
  })

  it("terminal update for an unloaded card is buffered and lands with the card", () => {
    handleWsSubRunUpdate({ runId: "run-done", status: "done", summary: "All set." })
    expect(_pendingSubRunUpdatesSize()).toBe(1)
    loadMessagesIntoStore(threadId, [makeSeedMessage()])
    handleWsMessageEvent("create", {
      id: "m-late",
      threadId,
      authorId: "u1",
      authorType: "agent",
      content: "",
      createdAt: "2026-03-15T12:00:00Z",
      metadata: {
        kind: "sub_run",
        subRun: {
          runId: "run-done",
          hiddenThreadId: "h1",
          agentType: "test",
          label: "Test",
          status: "queued",
          summary: null,
          usage: { promptTokens: 0, completionTokens: 0, creditCost: "0" },
        },
      },
    })
    expect(getMessage(threadId, "m-late")?.metadata?.subRun?.status).toBe("done")
    expect(getMessage(threadId, "m-late")?.metadata?.subRun?.summary).toBe("All set.")
    expect(_pendingSubRunUpdatesSize()).toBe(0)
  })

  it("the buffer is bounded: the oldest runs fall out first", () => {
    for (let i = 0; i < MAX_PENDING_SUB_RUN_UPDATES + 25; i++) {
      handleWsSubRunUpdate({ runId: `run-${i}`, status: i % 2 ? "done" : "running" })
    }
    expect(_pendingSubRunUpdatesSize()).toBe(MAX_PENDING_SUB_RUN_UPDATES)
  })

  it("terminal update matching a loaded card clears any pending entry for that runId", () => {
    loadMessagesIntoStore(threadId, [
      makeMessage({
        id: "m-sub",
        metadata: {
          kind: "sub_run",
          subRun: {
            runId: "run-2",
            hiddenThreadId: "h1",
            agentType: "test",
            label: "Test",
            status: "queued",
            summary: null,
            usage: { promptTokens: 0, completionTokens: 0, creditCost: "0" },
          },
        },
      }),
    ])
    handleWsSubRunUpdate({ runId: "run-2", status: "done" })
    expect(getMessage(threadId, "m-sub")?.metadata?.subRun?.status).toBe("done")
    expect(_pendingSubRunUpdatesSize()).toBe(0)
  })

  it("resetMessageStore clears the pending map", () => {
    handleWsSubRunUpdate({ runId: "run-3", status: "running" })
    expect(_pendingSubRunUpdatesSize()).toBe(1)
    resetMessageStore()
    expect(_pendingSubRunUpdatesSize()).toBe(0)
  })
})

describe("message store - agent authorship (P4b-T01)", () => {
  beforeEach(() => {
    resetMessageStore()
    loadMessagesIntoStore(threadId, [makeSeedMessage()])
  })

  it("handleMessageEvent carries authorAgentId when authorType is agent", () => {
    handleWsMessageEvent("create", {
      id: "m-agent",
      threadId,
      authorId: "agent-actor",
      authorName: "Support",
      authorType: "agent",
      authorAgentId: "33333333-3333-4333-8333-333333333333",
      content: "On it",
      createdAt: "2026-01-01T00:01:00Z",
    })
    const m = getMessage(threadId, "m-agent")!
    expect(m.authorAgentId).toBe("33333333-3333-4333-8333-333333333333")
  })

  it("a human message carries a null authorAgentId", () => {
    handleWsMessageEvent("create", {
      id: "m-human",
      threadId,
      authorId: "u1",
      authorName: "Alice",
      authorType: "user",
      authorAgentId: null,
      content: "Hi",
      createdAt: "2026-01-01T00:02:00Z",
    })
    expect(getMessage(threadId, "m-human")!.authorAgentId).toBeNull()
  })
})

describe("message store - agent author resolution (P4b-T05)", () => {
  beforeEach(async () => {
    resetMessageStore()
    resetAgentDirectory()
    loadMessagesIntoStore(threadId, [makeSeedMessage()])
    await loadAgentDirectory({
      get: async () => ({
        data: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            handle: "@finance",
            displayName: "Finance",
            avatarUrl: "/api/avatars/finance.png",
          },
        ],
      }),
    })
  })

  it("agent message resolves its author name from authorAgentId, not the Liaison fallback", () => {
    handleWsMessageEvent("create", {
      id: "m-finance",
      threadId,
      authorId: "agent-actor",
      authorType: "agent",
      authorAgentId: "77777777-7777-4777-8777-777777777777",
      content: "Booked",
      createdAt: "2026-01-01T00:03:00Z",
    })
    const m = getMessage(threadId, "m-finance")!
    expect(m.authorName).toBe("Finance")
    expect(m.authorAvatarUrl).toBe("/api/avatars/finance.png")
  })

  it("an agent message with no authorAgentId still falls back to the generic agent name", () => {
    handleWsMessageEvent("create", {
      id: "m-legacy",
      threadId,
      authorId: "agent-actor",
      authorType: "agent",
      content: "Legacy",
      createdAt: "2026-01-01T00:04:00Z",
    })
    expect(getMessage(threadId, "m-legacy")!.authorName).toBe(PERSONAL_AGENT_DISPLAY_NAME)
  })

  it("an explicit authorName from the server always wins over the directory", () => {
    handleWsMessageEvent("create", {
      id: "m-named",
      threadId,
      authorId: "agent-actor",
      authorName: "Finance Bot",
      authorType: "agent",
      authorAgentId: "77777777-7777-4777-8777-777777777777",
      content: "Named",
      createdAt: "2026-01-01T00:05:00Z",
    })
    expect(getMessage(threadId, "m-named")!.authorName).toBe("Finance Bot")
  })
})

describe("hidden-runs marker reads the real list envelope (P4b-E6)", () => {
  beforeEach(() => resetMessageStore())

  // The api client UNWRAPS `data` on `get`, so `meta` never reaches a caller
  // that only calls `get`: the gap descriptions have to come off the envelope.
  const envelopeApi = (msgs: any[], meta: Record<string, unknown>) => ({
    get: vi.fn().mockResolvedValue([...msgs].reverse()),
    getEnvelope: vi.fn().mockResolvedValue({ data: [...msgs].reverse(), meta }),
  })

  it("takes hiddenRuns off the envelope meta of the messages list", async () => {
    const api = envelopeApi([makeSeedMessage()], {
      cursor: null,
      hasMore: false,
      hiddenRuns: [{ afterMessageId: "m1", count: 3 }],
    })
    await loadMessages(api as any, threadId)
    expect(api.getEnvelope).toHaveBeenCalled()
    expect(getHiddenRuns(threadId)).toEqual([{ afterMessageId: "m1", count: 3 }])
  })

  it("an envelope that reports no gaps clears the previous answer", async () => {
    setHiddenRuns(threadId, [{ afterMessageId: "m1", count: 3 }])
    await loadMessages(
      envelopeApi([makeSeedMessage()], { cursor: null, hasMore: false, hiddenRuns: [] }) as any,
      threadId,
    )
    expect(getHiddenRuns(threadId)).toEqual([])
  })

  it("an envelope that says nothing about gaps keeps the previous answer", async () => {
    setHiddenRuns(threadId, [{ afterMessageId: "m1", count: 3 }])
    await loadMessages(envelopeApi([makeSeedMessage()], { cursor: null }) as any, threadId)
    expect(getHiddenRuns(threadId)).toEqual([{ afterMessageId: "m1", count: 3 }])
  })

  it("still loads the page from a client that has no envelope reader", async () => {
    const api = { get: vi.fn().mockResolvedValue({ data: [makeSeedMessage()] }) }
    await loadMessages(api as any, threadId)
    expect(getMessages(threadId).map((m) => m.id)).toEqual(["m1"])
  })
})

// spec-agents.md A29/A30: a message that names two agents gives BOTH a turn,
// and the two runs stream at once. Keyed on the thread alone, the second
// agent's `start` reset the slot the first was streaming into and the first's
// `done` completed the second, so the room drew one live turn and the other
// agent showed no state at all, not even after a reload.
describe("two agents streaming into one room", () => {
  const THREAD = "room-1"
  const ALPHA = "agent-alpha"
  const BETA = "agent-beta"

  beforeEach(() => {
    resetMessageStore()
  })

  it("keeps a live block each, with its own content", () => {
    handleWsAgentStreamEvent("start", { threadId: THREAD, agentId: ALPHA })
    handleWsAgentStreamEvent("delta", { threadId: THREAD, agentId: ALPHA, delta: "alpha says" })
    handleWsAgentStreamEvent("start", { threadId: THREAD, agentId: BETA })
    handleWsAgentStreamEvent("delta", { threadId: THREAD, agentId: BETA, delta: "beta says" })

    expect(getLiveAgentStreams(THREAD).length).toBe(2)
    expect(getAgentStream(THREAD, ALPHA).content).toBe("alpha says")
    expect(getAgentStream(THREAD, BETA).content).toBe("beta says")
  })

  it("one agent finishing leaves the other streaming", () => {
    handleWsAgentStreamEvent("start", { threadId: THREAD, agentId: ALPHA })
    handleWsAgentStreamEvent("start", { threadId: THREAD, agentId: BETA })
    handleWsAgentStreamEvent("done", { threadId: THREAD, agentId: ALPHA, finishReason: "stop" })

    expect(getAgentStream(THREAD, ALPHA).state).toBe("complete")
    expect(getAgentStream(THREAD, BETA).state).toBe("streaming")
  })

  it("one agent's reply landing does not clear the other's live block", () => {
    handleWsAgentStreamEvent("start", { threadId: THREAD, agentId: ALPHA })
    handleWsAgentStreamEvent("start", { threadId: THREAD, agentId: BETA })
    handleWsMessageEvent("create", {
      threadId: THREAD,
      id: "m-1",
      authorType: "agent",
      authorAgentId: ALPHA,
      content: "alpha's answer",
    })

    expect(getAgentStream(THREAD, ALPHA).state).toBe("idle")
    expect(getAgentStream(THREAD, BETA).state).toBe("streaming")
  })
})
