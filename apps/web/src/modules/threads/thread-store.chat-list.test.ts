// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A routine's run log is never a chat row. Opening it from its routine (the
// view reads the detail and merges it into the store) or hearing of it on the
// socket must not put it in Channels, nor let its runs raise an unread count.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

import {
  addThread,
  allThreads,
  getThread,
  handleMessageEvent,
  handleThreadEvent,
  resetThreadStore,
  totalUnreadCount,
} from "~/modules/threads/thread-store"

const ME = "user-me"

function detail(id: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    handle: `${type}-${id}`,
    title: type === "routine" ? "support-on-message" : "general",
    type,
    hiddenFromList: false,
    discoverable: false,
    participants: [{ id: ME, name: "Me", participantType: "user" }],
    ...extra,
  }
}

function runMessage(threadId: string, id: string) {
  return {
    id,
    threadId,
    content: "Run finished: 2 tickets triaged",
    authorId: ME,
    authorName: "Support",
    authorType: "agent",
    createdAt: new Date().toISOString(),
  }
}

describe("chat lists hold chat rooms only", () => {
  beforeEach(() => resetThreadStore())

  it("a routine run thread opened by id stays out of the list, a channel goes in", () => {
    addThread(detail("routine-1", "routine"))
    addThread(detail("channel-1", "thread"))
    expect(allThreads().map((t) => t.id)).toEqual(["channel-1"])
    expect(getThread("routine-1")).toBeUndefined()
  })

  it("a routine run never raises the unread count", () => {
    addThread(detail("routine-1", "routine"))
    addThread(detail("channel-1", "thread"))
    handleMessageEvent("create", runMessage("routine-1", "m1"))
    handleMessageEvent("create", runMessage("channel-1", "m2"))
    expect(totalUnreadCount()).toBe(1)
  })

  it("a socket create for a run log or a sub-run adds no row", () => {
    handleThreadEvent("create", detail("routine-2", "routine"))
    handleThreadEvent("create", detail("subrun-1", "subrun"))
    handleThreadEvent("create", detail("channel-2", "thread"))
    expect(allThreads().map((t) => t.id)).toEqual(["channel-2"])
  })

  it("a row the detail says is hidden from the list is not added", () => {
    addThread(detail("approval-1", "approval", { hiddenFromList: true }))
    expect(allThreads()).toHaveLength(0)
  })

  it("a row already listed leaves when its detail turns out to be a run log", () => {
    addThread({ id: "routine-3", handle: "routine-3", title: "weekly review" })
    expect(allThreads().map((t) => t.id)).toEqual(["routine-3"])
    addThread(detail("routine-3", "routine"))
    expect(allThreads()).toHaveLength(0)
  })
})
