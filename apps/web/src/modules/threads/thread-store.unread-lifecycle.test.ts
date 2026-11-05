// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The unread count's lifecycle client side (LIF-26): a bump on a message, a
// clear on a read mark (this device or another one's `kernel:read_state`
// frame), and the list reload that brings the server's counts back. A list
// response composed BEFORE a read or a message landed must never put back the
// count that read or message already moved.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

import { handleReadStateEvent } from "~/modules/threads/read-state-sync"
import {
  getThread,
  handleMessageEvent,
  loadThreads,
  markThreadRead,
  resetThreadStore,
  totalUnreadCount,
} from "~/modules/threads/thread-store"

function row(id: string, unreadCount: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    handle: id,
    title: id,
    participants: [],
    updatedAt: "2026-10-15T10:00:00.000Z",
    unreadCount,
    ...extra,
  }
}

/** An api whose list answer is held until the test releases it. */
function heldApi() {
  let release: (rows: unknown[]) => void = () => {}
  const api = {
    get: vi.fn(
      () =>
        new Promise((resolve) => {
          release = (rows) => resolve({ data: rows })
        }),
    ),
  }
  return { api, release: (rows: unknown[]) => release(rows) }
}

async function seed(rows: unknown[]) {
  await loadThreads({ get: vi.fn(async () => ({ data: rows })) }, { fresh: true })
}

const noDeps = { reloadAttention: () => {} }

vi.mock("~/modules/threads/unread-count-store", () => ({
  requestUnreadCountRefresh: () => {},
}))

describe("unread lifecycle", () => {
  beforeEach(() => {
    resetThreadStore()
  })

  it("a read on another device during a list reload is not undone by the stale list", async () => {
    await seed([row("t1", 3)])
    const { api, release } = heldApi()
    const reload = loadThreads(api, { fresh: true })
    // The other device read it while the list was on the wire.
    handleReadStateEvent("update", { kind: "thread", threadId: "t1", unreadCount: 0 }, noDeps)
    expect(getThread("t1")?.unreadCount).toBe(0)
    // The list answer was composed before that read.
    release([row("t1", 3)])
    await reload
    expect(getThread("t1")?.unreadCount).toBe(0)
    expect(totalUnreadCount()).toBe(0)
  })

  it("a read on this device during a list reload is not undone by the stale list", async () => {
    await seed([row("t1", 2)])
    const { api, release } = heldApi()
    const reload = loadThreads(api, { fresh: true })
    markThreadRead({ patch: vi.fn(async () => ({})) }, "t1")
    release([row("t1", 2)])
    await reload
    expect(getThread("t1")?.unreadCount).toBe(0)
  })

  // A status line ("Routine X is running") is never unread, live or on the server.
  it("a routine's 'is running' line raises nobody's count; the next message does", async () => {
    await seed([row("t1", 0)])
    handleMessageEvent("create", {
      // Fresh ids: the store counts a message id once, across retries too.
      id: `run-line-${crypto.randomUUID()}`,
      threadId: "t1",
      content: "Routine prospects is running.",
      authorId: "u2",
      authorType: "system",
      metadata: { type: "routine-run", routineRun: { status: "running" } },
      createdAt: "2026-10-15T10:01:00.000Z",
    })
    expect(getThread("t1")?.unreadCount).toBe(0)
    handleMessageEvent("create", {
      id: `summary-${crypto.randomUUID()}`,
      threadId: "t1",
      content: "Brief.",
      authorId: "u2",
      authorType: "agent",
      createdAt: "2026-10-15T10:02:00.000Z",
    })
    expect(getThread("t1")?.unreadCount).toBe(1)
  })

  it("a message counted during a list reload is kept, not counted twice", async () => {
    await seed([row("t1", 0)])
    const { api, release } = heldApi()
    const reload = loadThreads(api, { fresh: true })
    handleMessageEvent("create", {
      id: "m1",
      threadId: "t1",
      content: "hi",
      authorId: "u2",
      authorType: "user",
      createdAt: "2026-10-15T10:01:00.000Z",
    })
    expect(getThread("t1")?.unreadCount).toBe(1)
    // Composed before the message: 0. Composed after: 1. Either way, 1.
    release([row("t1", 0)])
    await reload
    expect(getThread("t1")?.unreadCount).toBe(1)
  })

  it("a message during a reload adds to the server's count, not to a stale local one", async () => {
    // The local count is stale (0); the server has 6. One message lands while
    // the list is on the wire, after the newest message that list carries.
    await seed([row("t1", 0)])
    const { api, release } = heldApi()
    const reload = loadThreads(api, { fresh: true })
    handleMessageEvent("create", {
      id: "m7",
      threadId: "t1",
      content: "hi",
      authorId: "u2",
      authorType: "user",
      createdAt: "2026-10-15T10:05:00.000Z",
    })
    release([
      row("t1", 6, { lastMessage: { content: "x", createdAt: "2026-10-15T10:04:00.000Z" } }),
    ])
    await reload
    expect(getThread("t1")?.unreadCount).toBe(7)
  })

  it("a message the server's answer already counted is not added again", async () => {
    await seed([row("t1", 0)])
    const { api, release } = heldApi()
    const reload = loadThreads(api, { fresh: true })
    handleMessageEvent("create", {
      id: "m6",
      threadId: "t1",
      content: "hi",
      authorId: "u2",
      authorType: "user",
      createdAt: "2026-10-15T10:05:00.000Z",
    })
    // Composed after the message landed: its newest message is that one.
    release([
      row("t1", 6, { lastMessage: { content: "hi", createdAt: "2026-10-15T10:05:00.000Z" } }),
    ])
    await reload
    expect(getThread("t1")?.unreadCount).toBe(6)
  })

  it("a read then a message during a reload keep the local count", async () => {
    await seed([row("t1", 4)])
    const { api, release } = heldApi()
    const reload = loadThreads(api, { fresh: true })
    markThreadRead({ patch: vi.fn(async () => ({})) }, "t1")
    handleMessageEvent("create", {
      id: "m9",
      threadId: "t1",
      content: "hi",
      authorId: "u2",
      authorType: "user",
      createdAt: "2026-10-15T10:05:00.000Z",
    })
    release([row("t1", 4)])
    await reload
    expect(getThread("t1")?.unreadCount).toBe(1)
  })

  it("a reload with nothing moved meanwhile takes the server's counts", async () => {
    await seed([row("t1", 0), row("t2", 4)])
    const { api, release } = heldApi()
    const reload = loadThreads(api, { fresh: true })
    release([row("t1", 5), row("t2", 0)])
    await reload
    expect(getThread("t1")?.unreadCount).toBe(5)
    expect(getThread("t2")?.unreadCount).toBe(0)
  })

  it("a touch during one reload does not pin the count for the next one", async () => {
    await seed([row("t1", 3)])
    const first = heldApi()
    const reload = loadThreads(first.api, { fresh: true })
    handleReadStateEvent("update", { kind: "thread", threadId: "t1", unreadCount: 0 }, noDeps)
    first.release([row("t1", 3)])
    await reload
    // A later reload, composed after a new message arrived elsewhere.
    await seed([row("t1", 1)])
    expect(getThread("t1")?.unreadCount).toBe(1)
  })

  it("the reader's own message and a message in the visible open thread never count", () => {
    return seed([row("t1", 0)]).then(() => {
      const base = {
        threadId: "t1",
        content: "x",
        authorId: "me",
        authorType: "user",
        createdAt: "2026-10-15T10:02:00.000Z",
      }
      handleMessageEvent("create", { ...base, id: "own" }, { isOwnAction: true })
      handleMessageEvent(
        "create",
        { ...base, id: "seen", authorId: "u2" },
        { isVisibleActiveThread: true },
      )
      expect(getThread("t1")?.unreadCount).toBe(0)
    })
  })

  it("a read_state frame for a thread the list does not hold changes nothing", async () => {
    await seed([row("t1", 2)])
    handleReadStateEvent("update", { kind: "thread", threadId: "ghost", unreadCount: 0 }, noDeps)
    expect(getThread("ghost")).toBeUndefined()
    expect(getThread("t1")?.unreadCount).toBe(2)
  })
})
