// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S9 / A16: the web store routes a reply to its reply thread, never to the
// channel list unless it was also sent there, and keeps the root's summary
// ("N replies", repliers, last reply time) in step with every create, edit,
// delete and reaction the socket delivers.

import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  getAgentStream,
  getMessage,
  getMessages,
  getReplies,
  getReplyRoot,
  handleWsAgentStreamEvent,
  handleWsMessageEvent,
  handleWsReactionEvent,
  loadMessagesIntoStore,
  loadReplies,
  type Message,
  resetMessageStore,
  sendMessage,
} from "~/modules/threads/message-store"

const threadId = "11111111-1111-4111-8111-111111111111"
const rootId = "22222222-2222-4222-8222-222222222222"
const replyId = "33333333-3333-4333-8333-333333333333"

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: rootId,
    threadId,
    authorId: "u-root",
    authorName: "Alice",
    authorAvatarUrl: null,
    authorType: "user",
    authorAgentId: null,
    content: "Root question",
    mentions: null,
    metadata: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-09-28T10:00:00.000Z",
    replyRootId: null,
    alsoInChannel: false,
    replyCount: 0,
    lastReplyAt: null,
    replyAuthors: [],
    ...overrides,
  }
}

function replyEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: replyId,
    threadId,
    authorId: "u-bob",
    authorName: "Bob",
    authorType: "user",
    authorAgentId: null,
    parentMessageId: null,
    replyRootId: rootId,
    alsoInChannel: false,
    followerIds: ["u-root", "u-bob"],
    content: "An answer in the thread",
    createdAt: "2026-09-28T10:05:00.000Z",
    ...overrides,
  }
}

function apiReturning(root: Message, replies: Message[]) {
  return {
    get: vi.fn(async () => ({ root, replies })),
    getEnvelope: vi.fn(async () => ({
      data: { root, replies },
      meta: { hasMore: false, cursor: null, hiddenRuns: [] },
    })),
  }
}

beforeEach(() => {
  resetMessageStore()
  loadMessagesIntoStore(threadId, [msg()])
})

describe("reply routing (S9)", () => {
  it("keeps a reply without 'also send to channel' out of the channel list and bumps the root", () => {
    handleWsMessageEvent("create", replyEvent())

    expect(getMessages(threadId).map((m) => m.id)).toEqual([rootId])
    const root = getMessage(threadId, rootId)!
    expect(root.replyCount).toBe(1)
    expect(root.lastReplyAt).toBe("2026-09-28T10:05:00.000Z")
    expect(root.replyAuthors?.map((a) => a.name)).toEqual(["Bob"])
  })

  it("puts a reply sent to the channel too in both the channel list and the reply thread", async () => {
    await loadReplies(apiReturning(msg(), []) as never, threadId, rootId)
    handleWsMessageEvent("create", replyEvent({ alsoInChannel: true }))

    expect(getMessages(threadId).map((m) => m.id)).toEqual([rootId, replyId])
    expect(getMessage(threadId, replyId)?.alsoInChannel).toBe(true)
    expect(getReplies(rootId).map((m) => m.id)).toEqual([replyId])
    expect(getMessage(threadId, rootId)?.replyCount).toBe(1)
  })

  it("routes a reply into an open reply thread and counts a replayed create once", async () => {
    await loadReplies(apiReturning(msg(), []) as never, threadId, rootId)
    handleWsMessageEvent("create", replyEvent())
    handleWsMessageEvent("create", replyEvent())

    expect(getReplies(rootId).map((m) => m.content)).toEqual(["An answer in the thread"])
    expect(getMessage(threadId, rootId)?.replyCount).toBe(1)
    expect(getReplyRoot(rootId)?.replyCount).toBe(1)
  })

  it("routes edits, reactions and deletes to the reply copy and recomputes the summary", async () => {
    await loadReplies(
      apiReturning(msg({ replyCount: 1, lastReplyAt: "2026-09-28T10:05:00.000Z" }), [
        msg({
          id: replyId,
          replyRootId: rootId,
          authorId: "u-bob",
          authorName: "Bob",
          content: "v1",
        }),
      ]) as never,
      threadId,
      rootId,
    )
    loadMessagesIntoStore(threadId, [
      msg({ replyCount: 1, lastReplyAt: "2026-09-28T10:05:00.000Z" }),
    ])

    handleWsMessageEvent("update", { id: replyId, threadId, replyRootId: rootId, content: "v2" })
    expect(getReplies(rootId)[0]?.content).toBe("v2")

    handleWsReactionEvent("add", {
      threadId,
      messageId: replyId,
      replyRootId: rootId,
      emoji: "👍",
      userId: "u-carol",
      userName: "Carol",
    })
    expect(getReplies(rootId)[0]?.reactions.map((r) => r.emoji)).toEqual(["👍"])

    handleWsMessageEvent("delete", {
      id: replyId,
      threadId,
      replyRootId: rootId,
      deletedAt: "2026-09-28T10:07:00.000Z",
    })
    expect(getReplies(rootId)[0]?.deletedAt).toBe("2026-09-28T10:07:00.000Z")
    expect(getMessage(threadId, rootId)?.replyCount).toBe(0)
    expect(getMessage(threadId, rootId)?.lastReplyAt).toBeNull()
    // The reply never leaked into the channel list on the way.
    expect(getMessages(threadId).map((m) => m.id)).toEqual([rootId])
  })

  it("routes a reaction on the root to the panel's copy too", async () => {
    await loadReplies(apiReturning(msg(), []) as never, threadId, rootId)
    handleWsReactionEvent("add", {
      threadId,
      messageId: rootId,
      emoji: "🎉",
      userId: "u-carol",
      userName: "Carol",
    })
    expect(getReplyRoot(rootId)?.reactions.map((r) => r.emoji)).toEqual(["🎉"])
    expect(getMessage(threadId, rootId)?.reactions.map((r) => r.emoji)).toEqual(["🎉"])
  })

  it("marks an agent stream started in a reply thread with its root", () => {
    handleWsAgentStreamEvent("start", { threadId, agentId: "ag-1", replyRootId: rootId })
    expect(getAgentStream(threadId, "ag-1").replyRootId).toBe(rootId)
  })
})

// QA THR-10: an agent mentioned in a hidden reply posts its seat line
// ("Taylor added Base") in the reply thread. A system line is not a reply:
// the panel counter and the root summary read "3 replies" for two.
describe("a system line in a reply thread is not a reply", () => {
  const seatLine = "44444444-4444-4444-8444-444444444444"

  it("does not bump the root's summary when the thread is not loaded", () => {
    handleWsMessageEvent("create", replyEvent())
    handleWsMessageEvent(
      "create",
      replyEvent({
        id: seatLine,
        authorType: "system",
        authorName: null,
        content: "Bob added Base",
        createdAt: "2026-09-28T10:06:00.000Z",
      }),
    )
    const root = getMessage(threadId, rootId)!
    expect(root.replyCount).toBe(1)
    expect(root.lastReplyAt).toBe("2026-09-28T10:05:00.000Z")
  })

  it("leaves it out of the exact recompute when the whole thread is loaded", async () => {
    await loadReplies(apiReturning(msg(), []) as never, threadId, rootId)
    handleWsMessageEvent("create", replyEvent())
    handleWsMessageEvent(
      "create",
      replyEvent({
        id: seatLine,
        authorType: "system",
        authorName: null,
        content: "Bob added Base",
        createdAt: "2026-09-28T10:06:00.000Z",
      }),
    )
    expect(getReplies(rootId).map((m) => m.id)).toEqual([replyId, seatLine])
    for (const root of [getMessage(threadId, rootId)!, getReplyRoot(rootId)!]) {
      expect(root.replyCount).toBe(1)
      expect(root.lastReplyAt).toBe("2026-09-28T10:05:00.000Z")
      expect(root.replyAuthors?.map((a) => a.name)).toEqual(["Bob"])
    }
  })

  it("deleting a system line does not take a reply off the count", async () => {
    // The server's count already leaves the seat line out; the panel holds a
    // partial page (older replies not loaded), so the summary moves by one.
    const root = msg({ replyCount: 1, lastReplyAt: "2026-09-28T10:05:00.000Z" })
    const seat = msg({
      id: seatLine,
      authorId: "u-bob",
      authorName: "",
      authorType: "system",
      content: "Bob added Base",
      createdAt: "2026-09-28T10:06:00.000Z",
      replyRootId: rootId,
    })
    const api = {
      get: vi.fn(async () => ({ root, replies: [seat] })),
      getEnvelope: vi.fn(async () => ({
        data: { root, replies: [seat] },
        meta: { hasMore: true, cursor: "older", hiddenRuns: [] },
      })),
    }
    loadMessagesIntoStore(threadId, [root])
    await loadReplies(api as never, threadId, rootId)
    handleWsMessageEvent("delete", { id: seatLine, threadId, replyRootId: rootId })
    expect(getMessage(threadId, rootId)?.replyCount).toBe(1)
  })
})

describe("sending a reply", () => {
  it("posts replyRootId and the quote, and shows the reply in the thread only", async () => {
    await loadReplies(apiReturning(msg(), []) as never, threadId, rootId)
    let resolvePost: (v: unknown) => void = () => {}
    const post = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve
        }),
    )
    const sent = sendMessage(
      { post } as never,
      threadId,
      "My reply",
      { id: "u-me", name: "Me" },
      {
        replyRootId: rootId,
        quote: { messageId: rootId, excerpt: "Root", authorName: "Alice" },
      },
    )

    await vi.waitFor(() => expect(post).toHaveBeenCalled())
    const [path, body] = post.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(path).toBe(`/threads/${threadId}/messages`)
    expect(body.replyRootId).toBe(rootId)
    expect(body).not.toHaveProperty("alsoSendToChannel")
    expect(body.quote).toEqual({ messageId: rootId, excerpt: "Root" })
    // Optimistic: in the reply thread, not in the channel.
    expect(getReplies(rootId).map((m) => m.content)).toEqual(["My reply"])
    expect(getMessages(threadId).map((m) => m.id)).toEqual([rootId])

    resolvePost({
      data: {
        ...msg({ id: replyId, replyRootId: rootId, content: "My reply", authorId: "u-me" }),
      },
    })
    await sent
    expect(getReplies(rootId).map((m) => m.id)).toEqual([replyId])
    expect(getMessage(threadId, rootId)?.replyCount).toBe(1)
    expect(getMessages(threadId).map((m) => m.id)).toEqual([rootId])
  })
})
