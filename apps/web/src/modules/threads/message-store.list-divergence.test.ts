// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The phone bug: the owner's own latest message was the thread LIST row's
// preview, but opening the thread did not show it. Two causes, one test each:
//
// 1. A page read before the message existed landed AFTER the message's socket
//    frame (or after its own send settled). The merge treated the row as
//    deleted server-side and dropped it, while the list kept it as preview.
// 2. A cached conversation is reused on open, and the list can be refreshed
//    without it (pull-to-refresh, a reload): nothing read the page again when
//    the list knew of a newer message.
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  getMessages,
  handleWsMessageEvent,
  isThreadBehindList,
  loadMessages,
  loadMessagesIntoStore,
  reconcileThreadWithList,
  resetMessageStore,
} from "~/modules/threads/message-store"

const threadId = "t-div"

function msg(id: string, createdAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    threadId,
    authorId: "owner",
    authorName: "Owner",
    authorAvatarUrl: null,
    authorType: "user",
    authorAgentId: null,
    content: `content ${id}`,
    mentions: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    createdAt,
    ...overrides,
  }
}

/** An api whose page answers only when the test says so (API order is DESC). */
function deferredPage() {
  let resolve!: (rows: any[]) => void
  const api = {
    get: vi.fn(
      () =>
        new Promise((r) => {
          resolve = (rows) => r({ data: [...rows].reverse() })
        }),
    ),
  }
  return { api, answer: (rows: any[]) => resolve(rows) }
}

beforeEach(() => resetMessageStore())

describe("loadMessages keeps rows that arrived while the page was in flight", () => {
  it("a socket create that lands before a stale page answers survives the merge", async () => {
    loadMessagesIntoStore(threadId, [msg("m1", "2026-10-01T10:00:00Z")] as any)
    const { api, answer } = deferredPage()
    const load = loadMessages(api as any, threadId) // resume resync, request on the wire

    // The owner's message, sent from another device, arrives by socket.
    handleWsMessageEvent("create", msg("m2", "2026-10-01T10:05:00Z"))
    expect(getMessages(threadId).map((m) => m.id)).toEqual(["m1", "m2"])

    // The page was read before m2 existed.
    answer([msg("m1", "2026-10-01T10:00:00Z")])
    await load

    expect(getMessages(threadId).map((m) => m.id)).toEqual(["m1", "m2"])
  })

  it("still drops a row the server no longer returns when it was there before the request", async () => {
    loadMessagesIntoStore(threadId, [
      msg("m1", "2026-10-01T10:00:00Z"),
      msg("m2", "2026-10-01T10:05:00Z"),
    ] as any)
    const { api, answer } = deferredPage()
    const load = loadMessages(api as any, threadId)
    answer([msg("m1", "2026-10-01T10:00:00Z")])
    await load
    expect(getMessages(threadId).map((m) => m.id)).toEqual(["m1"])
  })
})

describe("reconcileThreadWithList", () => {
  it("reads the page again when the list's preview is newer than the cached conversation", async () => {
    loadMessagesIntoStore(threadId, [msg("m1", "2026-10-01T10:00:00Z")] as any)
    const api = {
      get: vi.fn().mockResolvedValue({
        data: [msg("m2", "2026-10-01T10:05:00Z"), msg("m1", "2026-10-01T10:00:00Z")],
      }),
    }
    expect(isThreadBehindList(threadId, "2026-10-01T10:05:00Z")).toBe(true)

    reconcileThreadWithList(api as any, threadId, "2026-10-01T10:05:00Z")
    await vi.waitFor(() => expect(getMessages(threadId).map((m) => m.id)).toEqual(["m1", "m2"]))
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(isThreadBehindList(threadId, "2026-10-01T10:05:00Z")).toBe(false)
  })

  it("does nothing when the conversation is current, and reads once per preview stamp", async () => {
    loadMessagesIntoStore(threadId, [msg("m1", "2026-10-01T10:00:00Z")] as any)
    const api = { get: vi.fn().mockResolvedValue({ data: [msg("m1", "2026-10-01T10:00:00Z")] }) }

    reconcileThreadWithList(api as any, threadId, "2026-10-01T10:00:00Z")
    expect(api.get).not.toHaveBeenCalled()

    // A preview the page can never contain costs one read, not a loop.
    reconcileThreadWithList(api as any, threadId, "2026-10-01T11:00:00Z")
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1))
    reconcileThreadWithList(api as any, threadId, "2026-10-01T11:00:00Z")
    await Promise.resolve()
    expect(api.get).toHaveBeenCalledTimes(1)
  })

  it("leaves a thread that was never loaded to its first open", () => {
    const api = { get: vi.fn() }
    reconcileThreadWithList(api as any, "never-opened", "2026-10-01T11:00:00Z")
    expect(api.get).not.toHaveBeenCalled()
  })
})
