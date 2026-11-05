// SPDX-License-Identifier: FSL-1.1-ALv2
// The desktop app icon's badge: the page hands the shell the number of unread
// direct messages and mentions on every change, zero included.
import type { AttentionItem } from "@liaison/shared"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DESKTOP_BRIDGE_KEY, DESKTOP_BRIDGE_VERSION } from "~/lib/desktop-shell-contract"
import { attentionStore } from "~/modules/shell/attention-store"
import {
  addThread,
  handleMessageEvent,
  loadThreads,
  markThreadRead,
  removeThread,
  resetThreadStore,
} from "~/modules/threads/thread-store"
import { DesktopBadgeTestAccess, startDesktopBadge } from "./desktop-badge"

const sent: number[] = []

function installShell(withBadge = true): void {
  ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY] = {
    version: DESKTOP_BRIDGE_VERSION,
    ...(withBadge
      ? {
          setUnreadBadge: async (count: number) => {
            sent.push(count)
          },
        }
      : {}),
  }
}

function thread(id: string, unreadCount: number, title: string | null) {
  return {
    id,
    handle: id,
    title,
    type: "thread",
    isPinned: false,
    isPinnedByUser: false,
    isMuted: false,
    participants: [],
    updatedAt: "2026-11-03T10:00:00Z",
    unreadCount,
  }
}

function mention(id: string, threadId: string): AttentionItem {
  return {
    id,
    app: "kernel",
    entity: "thread",
    entityId: threadId,
    kind: "mention",
    summary: "mentioned you",
    urgency: 1,
    occurredAt: "2026-11-03T10:00:00Z",
    action: { type: "open_entity", tabType: "thread", entityId: threadId },
  }
}

describe("desktop badge", () => {
  beforeEach(() => {
    sent.length = 0
    resetThreadStore()
    attentionStore._setForTest({ items: [] })
    DesktopBadgeTestAccess.reset()
  })

  afterEach(() => {
    DesktopBadgeTestAccess.reset()
    delete (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY]
    resetThreadStore()
    attentionStore._setForTest({ items: [] })
  })

  it("sends the first reading even at zero, so an old badge comes down", () => {
    installShell()
    startDesktopBadge()
    expect(sent).toEqual([0])
  })

  it("follows direct messages and mentions, ignores channel traffic, and clears at zero", () => {
    installShell()
    startDesktopBadge()
    addThread(thread("d1", 2, null))
    expect(sent).toEqual([0, 2])
    // A channel's unread messages do not move the badge.
    addThread(thread("c1", 30, "#general"))
    expect(sent).toEqual([0, 2])
    // A mention in that channel does.
    attentionStore._setForTest({ items: [mention("m1", "c1")] })
    expect(sent).toEqual([0, 2, 3])
    attentionStore._setForTest({ items: [] })
    removeThread("d1")
    expect(sent).toEqual([0, 2, 3, 2, 0])
  })

  it("does nothing in a browser or a shell without the call", () => {
    startDesktopBadge()
    installShell(false)
    startDesktopBadge()
    addThread(thread("d1", 2, null))
    expect(sent).toEqual([])
  })

  it("drives the badge from the thread list the API answers, a live message, a read and a mention", async () => {
    installShell()
    startDesktopBadge()
    // The GET /threads answer as the server shapes it: a DM with two unread,
    // a muted DM with five (adds nothing), a channel with thirty (adds nothing).
    const person = (userId: string, displayName: string) => ({
      userId,
      participantType: "user",
      displayName,
      role: "member",
      joinedAt: "2026-11-01T08:00:00Z",
    })
    const listed = [
      {
        id: "dm-1",
        handle: "dm-1",
        title: null,
        type: "thread",
        isPinned: false,
        isPinnedByUser: false,
        isMuted: false,
        discoverable: false,
        topic: null,
        description: null,
        participants: [person("u-other", "Robin Example")],
        lastMessage: {
          content: "Can you check the order?",
          authorId: "u-other",
          authorType: "user",
        },
        unreadCount: 2,
        updatedAt: "2026-11-03T09:00:00Z",
      },
      {
        id: "dm-muted",
        handle: "dm-muted",
        title: null,
        type: "thread",
        isMuted: true,
        participants: [person("u-third", "Sam Example")],
        lastMessage: null,
        unreadCount: 5,
        updatedAt: "2026-11-03T08:00:00Z",
      },
      {
        id: "ch-1",
        handle: "general",
        title: "#general",
        type: "thread",
        isMuted: false,
        discoverable: true,
        participants: [person("u-other", "Robin Example"), person("u-third", "Sam Example")],
        lastMessage: null,
        unreadCount: 30,
        updatedAt: "2026-11-03T07:00:00Z",
      },
    ]
    const patched: string[] = []
    const api = {
      get: async (path: string) => {
        expect(path).toBe("/threads?limit=50")
        return { data: listed }
      },
      patch: async (path: string) => {
        patched.push(path)
        return {}
      },
    }
    await loadThreads(api)
    expect(sent).toEqual([0, 2])
    // A new message lands in the DM over the socket.
    handleMessageEvent("create", {
      id: "msg-9",
      threadId: "dm-1",
      content: "Also the invoice",
      authorId: "u-other",
      authorType: "user",
      createdAt: "2026-11-03T09:05:00Z",
    })
    expect(sent).toEqual([0, 2, 3])
    // The channel's own traffic never moves it; a mention there does.
    handleMessageEvent("create", {
      id: "msg-10",
      threadId: "ch-1",
      content: "lunch?",
      authorId: "u-third",
      authorType: "user",
      createdAt: "2026-11-03T09:06:00Z",
    })
    expect(sent).toEqual([0, 2, 3])
    attentionStore._setForTest({ items: [mention("m-ch", "ch-1")] })
    expect(sent).toEqual([0, 2, 3, 4])
    // A mention inside the DM is already in its unread count: not counted twice.
    attentionStore._setForTest({ items: [mention("m-ch", "ch-1"), mention("m-dm", "dm-1")] })
    expect(sent).toEqual([0, 2, 3, 4])
    // Reading the DM, then the mention leaving the feed, takes the badge down to zero.
    markThreadRead(api, "dm-1")
    expect(patched).toEqual(["/threads/dm-1/read"])
    expect(sent).toEqual([0, 2, 3, 4, 1])
    attentionStore._setForTest({ items: [] })
    expect(sent).toEqual([0, 2, 3, 4, 1, 0])
  })
})
