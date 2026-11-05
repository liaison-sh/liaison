// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { ChatsTab } from "~/modules/shell/ChatsTab"
import { DOCK_BADGE_CLASS, DOCK_TAB_WIDTH, resetDockStore } from "~/modules/shell/dock-store"
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

function renderInShell(ui: () => any) {
  return render(() => (
    <Router>
      <Route path="/*" component={() => <ApiProvider>{ui()}</ApiProvider>} />
    </Router>
  ))
}

function seedThread(overrides: Record<string, unknown> = {}) {
  addThread({
    id: "t1",
    handle: "@thread-1",
    title: "Test Thread",
    isPinned: false,
    isMuted: false,
    participants: [{ id: "me", name: "Me", avatarUrl: null }],
    updatedAt: new Date().toISOString(),
    ...overrides,
  })
}

describe("ChatsTab - the Chats pill (P4c-T07)", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetDockStore()
  })
  afterEach(() => cleanup())

  it("the Chats item is the bar's item: chat icon, semibold label, red unread badge", () => {
    seedThread({ id: "t1", title: "Alpha", unreadCount: 3 })
    renderInShell(() => <ChatsTab />)
    const item = screen.getByLabelText("Chats")
    expect(item).toHaveAttribute("data-dock-pill")
    expect(item.className).toContain("h-full")
    expect(item.className).not.toContain("border")
    expect(item.querySelector("svg.lucide-message-circle, svg")).toBeTruthy()
    expect(screen.getByText("Chats").className).toContain("font-semibold")
    // The count badge: the dock's one red badge.
    const badge = screen.getByLabelText("3 unread")
    expect(badge).toHaveTextContent("3")
    expect(badge.className).toBe(DOCK_BADGE_CLASS)
  })

  it("the Chats pill shows the unread total", () => {
    seedThread({ id: "t1", title: "Alpha", unreadCount: 3 })
    seedThread({ id: "t2", title: "Beta", unreadCount: 2 })
    renderInShell(() => <ChatsTab />)
    expect(screen.getByLabelText("5 unread")).toHaveTextContent("5")
  })

  it("shows no badge when nothing is unread", () => {
    seedThread({ id: "t1", title: "Alpha", unreadCount: 0 })
    renderInShell(() => <ChatsTab />)
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("a muted thread's unread count never reaches the pill total", () => {
    seedThread({ id: "t1", title: "Alpha", unreadCount: 4, isMuted: true })
    renderInShell(() => <ChatsTab />)
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("clicking the pill opens the panel hosting the dock-variant sidebar", () => {
    seedThread({ id: "t1", title: "Alpha" })
    renderInShell(() => <ChatsTab />)
    expect(screen.queryByTestId("chats-panel")).not.toBeInTheDocument()

    screen.getByLabelText("Chats").click()

    expect(screen.getByTestId("chats-panel")).toBeInTheDocument()
    expect(screen.getByText("Alpha")).toBeInTheDocument()
  })

  it("the roster opens as the dock's floating window, above the item", () => {
    seedThread({ id: "t1", title: "Alpha" })
    renderInShell(() => <ChatsTab />)
    screen.getByLabelText("Chats").click()

    const panel = screen.getByTestId("chats-panel")
    expect(panel).toHaveAttribute("data-dock-window")
    expect(panel.style.width).toBe(`${DOCK_TAB_WIDTH}px`)
    expect(panel.style.bottom).toContain("100%")
    expect(panel.className).toContain("border-border-strong")
    expect(screen.getByLabelText("Chats")).toHaveAttribute("aria-expanded", "true")
  })
})
