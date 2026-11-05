// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dock's three kinds of item (Chats, conversation, overflow) once drifted
// into three different pills: an outline `Button` at `rounded-sm` beside a
// conversation pill that took `rounded-lg` and a second border from its
// wrapper, so it also stood 2px taller. They are now items JOINED in one bar,
// and this is the drift guard: every element marked `data-dock-pill` wears the
// shared item geometry, and none sneaks back a border, radius or surface of
// its own (the bar owns those).
import { Route, Router } from "@solidjs/router"
import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { ChatDock } from "~/modules/shell/ChatDock"
import { ChatsTab } from "~/modules/shell/ChatsTab"
import ConversationTab from "~/modules/shell/ConversationTab"
import {
  DOCK_BADGE_CLASS,
  openConversation,
  resetDockStore,
  setVisibleCapacity,
} from "~/modules/shell/dock-store"
import { resetTabStore } from "~/modules/shell/tab-store"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: [] })),
    }),
  ),
)

function seedThread(id: string, title: string) {
  addThread({
    id,
    handle: `@${id}`,
    title,
    isPinned: false,
    isMuted: false,
    participants: [{ id: "me", name: "Me", avatarUrl: null }],
    updatedAt: new Date().toISOString(),
  })
}

function renderDock() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <ChatDock chatsTab={<ChatsTab />} renderTab={(tab) => <ConversationTab tab={tab} />} />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("dock bar items wear one class set", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetDockStore()
  })
  afterEach(() => cleanup())

  function seedTwoAndOverflowOne() {
    seedThread("t1", "Alpha")
    seedThread("t2", "Beta")
    openConversation("t1", { expand: false })
    openConversation("t2", { expand: false })
    setVisibleCapacity(1)
    renderDock()
    return Array.from(document.querySelectorAll("[data-dock-pill]")) as HTMLElement[]
  }

  it("the Chats item, a conversation item and the overflow item share the item geometry", () => {
    const items = seedTwoAndOverflowOne()
    // Every kind is on screen at once: Chats, one conversation, "+1" and the
    // collapse-all control.
    expect(items.length).toBe(4)
    for (const item of items) {
      for (const token of ["h-full", "inline-flex", "text-[12.5px]", "hover:bg-surface-hover"]) {
        expect(item.className.split(/\s+/)).toContain(token)
      }
    }
  })

  it("no item carries a border, a bar radius, a height or a font size of its own", () => {
    const items = seedTwoAndOverflowOne()
    expect(items.length).toBe(4)
    for (const item of items) {
      const tokens = item.className.split(/\s+/)
      expect(tokens.filter((t) => /^border/.test(t))).toEqual([])
      expect(tokens.filter((t) => /^rounded-(sm|md|lg|full)$/.test(t))).toEqual([])
      expect(tokens.filter((t) => /^h-/.test(t))).toEqual(["h-full"])
      expect(tokens.filter((t) => /^text-\[/.test(t))).toEqual(["text-[12.5px]"])
      expect(tokens.filter((t) => t === "bg-elevated" || t === "shadow-popover")).toEqual([])
    }
  })

  it("every item sits in the one bar, joined by dividers", () => {
    seedTwoAndOverflowOne()
    const bar = document.querySelector("[data-dock-bar]") as HTMLElement
    const slots = Array.from(bar.children) as HTMLElement[]
    expect(slots).toHaveLength(4)
    // Right to left: Chats first in the DOM (flex-row-reverse), then the
    // conversation, then the overflow, then the collapse-all control at the
    // far left. Every slot but Chats draws the divider on its right.
    expect(bar.className).toContain("flex-row-reverse")
    expect(slots[0].querySelector('[aria-label="Chats"]')).toBeTruthy()
    expect(slots[0].className).not.toContain("border-r")
    expect(slots[1].querySelector('[data-dock-tab="t2"]')).toBeTruthy()
    expect(slots[1].className).toContain("border-r")
    expect(slots[2].querySelector('[data-testid="dock-overflow"]')).toBeTruthy()
    expect(slots[2].className).toContain("border-r")
    expect(slots[3].querySelector('[data-testid="dock-collapse-all"]')).toBeTruthy()
    expect(slots[3].className).toContain("border-r")
  })

  it("a conversation item is not double bordered by its wrapper", () => {
    seedThread("t1", "Alpha")
    openConversation("t1", { expand: false })

    renderDock()

    const wrapper = document.querySelector('[data-dock-tab="t1"]') as HTMLElement
    expect(wrapper.getAttribute("data-expanded")).toBe("false")
    expect(wrapper.className).not.toContain("border")
    expect(wrapper.className).not.toContain("rounded")
    expect(wrapper.querySelector("[data-dock-pill]")).toBeTruthy()
  })

  it("the unread badge is the same red badge on the Chats and conversation items", () => {
    addThread({
      id: "t1",
      handle: "@t1",
      title: "Alpha",
      isPinned: false,
      isMuted: false,
      unreadCount: 3,
      participants: [{ id: "me", name: "Me", avatarUrl: null }],
      updatedAt: new Date().toISOString(),
    })
    openConversation("t1", { expand: false })

    renderDock()

    const chatsBadge = document.querySelector('[aria-label="3 unread"]') as HTMLElement
    const tabBadge = document.querySelector('[data-testid="dock-tab-unread"]') as HTMLElement
    for (const badge of [chatsBadge, tabBadge]) {
      expect(badge.className).toBe(DOCK_BADGE_CLASS)
      expect(badge.className).toContain("bg-danger")
    }
  })
})
