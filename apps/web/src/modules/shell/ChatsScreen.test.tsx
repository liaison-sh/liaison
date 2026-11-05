// SPDX-License-Identifier: FSL-1.1-ALv2
//
// F3. Chats is a root screen at phone tier, not an overlay. The seat opens the
// `kernel:chats` tab, the tab bar stays on screen, there is no sheet header,
// and picking a conversation pushes `/threads/:id` so both the OS back gesture
// and the top bar's back control return to `/chats`.
import { Route, Router, useLocation } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    length: 0,
    key: () => null,
  } as any
})

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return {
    ...actual,
    hasScope: () => true,
    userFromToken: () => ({
      userId: "me",
      orgId: "o1",
      name: "Tester",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  }
})

import { getTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { ChatsScreen } from "~/modules/shell/ChatsScreen"
import { chatsThreadId, resetChatsRootStore } from "~/modules/shell/chats-root-store"
import {
  DESKTOP_QUERY,
  PHONE_QUERY,
  type ShellTier,
  syncShellTier,
  TABLET_QUERY,
} from "~/modules/shell/shell-tier"
import { resetTabStore } from "~/modules/shell/tab-store"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

function setTier(next: ShellTier) {
  const answer = next === "phone" ? PHONE_QUERY : next === "tablet" ? TABLET_QUERY : DESKTOP_QUERY
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === answer,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
  syncShellTier()
}

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

function renderScreen() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => {
          const location = useLocation()
          return (
            <ApiProvider>
              <div data-testid="path">{location.pathname}</div>
              <ChatsScreen />
            </ApiProvider>
          )
        }}
      />
    </Router>
  ))
}

describe("the phone Chats root", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetChatsRootStore()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    window.history.pushState({}, "", "/chats")
    setTier("phone")
    addThread({
      id: "t-eng",
      handle: "@eng",
      title: "Engineering",
      discoverable: true,
      participants: [{ id: "me", name: "Me", avatarUrl: null }],
      lastMessage: {
        content: "Ship it",
        authorName: "Me",
        authorId: "me",
        createdAt: new Date().toISOString(),
      },
      unreadCount: 1,
      updatedAt: new Date().toISOString(),
    })
  })
  afterEach(() => {
    cleanup()
    setTier("desktop")
  })

  it("is a registered tab type on /chats with no desktop activity bar entry", () => {
    const reg = getTabType("kernel:chats")
    expect(reg).toBeTruthy()
    expect(reg?.urlPattern).toBe("/chats")
    expect(reg?.singleton).toBe(true)
  })

  // F3: this root screen owns its own large title, so it hides the phone top
  // bar entirely rather than sharing it via `phoneHeader` — the old
  // `phoneHeader`-only bar showed just the workspace name above the screen's
  // own "Chats" h1, a second header row for one word.
  it("hides the phone top bar entirely instead of customizing it", () => {
    const reg = getTabType("kernel:chats")
    expect(reg?.hidePhoneTopBar).toBe(true)
    expect(reg?.phoneHeader).toBeUndefined()
  })

  it("renders the list itself, with no sheet header over it", () => {
    renderScreen()
    expect(screen.getByTestId("chats-screen")).toBeTruthy()
    expect(screen.getByTestId("chats-title").textContent).toBe("Chats")
    // The sheet chrome the seat used to open: gone from this screen.
    expect(document.querySelector("[data-overlay-sheet]")).toBeNull()
    expect(screen.queryByTestId("chats-sheet-back")).toBeNull()
  })

  it("picking a conversation pushes the thread route", async () => {
    renderScreen()
    const row = await waitFor(() => screen.getAllByTestId("chat-row")[0])
    fireEvent.click(row)
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/threads/t-eng"))
    // The seat stays lit on the pushed conversation.
    expect(chatsThreadId()).toBe("t-eng")
  })
})

// Owner, 2026-10-12: the Messages app "doesn't have the sidebar as a sidebar".
// At desktop and tablet width the conversation list is the app's REAL sidebar
// (the same registered component a conversation tab shows, in the shell's
// sidebar column or tablet drawer), and the main panel waits for a pick. Only
// the phone keeps the list as the whole screen.
describe("the desktop Messages app", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetChatsRootStore()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    window.history.pushState({}, "", "/chats")
    addThread({
      id: "t-eng",
      handle: "@eng",
      title: "Engineering",
      participants: [{ id: "me", name: "Me", avatarUrl: null }],
      unreadCount: 1,
      updatedAt: new Date().toISOString(),
    })
  })
  afterEach(() => {
    cleanup()
    setTier("desktop")
  })

  it("registers the conversation list as its sidebar, the same one a conversation shows", () => {
    const chats = getTabType("kernel:chats")
    const thread = getTabType("kernel:thread")
    expect(chats?.sidebar).toBeTruthy()
    expect(chats?.sidebar).toBe(thread?.sidebar)
  })

  it("desktop: the main panel waits for a pick instead of repeating the list", () => {
    setTier("desktop")
    renderScreen()
    expect(screen.getByTestId("chats-pick")).toBeTruthy()
    expect(screen.queryByTestId("chat-row")).toBeNull()
    expect(screen.queryByTestId("chats-title")).toBeNull()
    expect(screen.queryByTestId("chats-show-list")).toBeNull()
  })

  it("tablet: the pick screen opens the sidebar drawer", async () => {
    setTier("tablet")
    const { tabletSidebarOpen, closeTabletSidebar } = await import(
      "~/modules/shell/tablet-sidebar-store"
    )
    closeTabletSidebar()
    renderScreen()
    expect(screen.queryByTestId("chat-row")).toBeNull()
    fireEvent.click(screen.getByTestId("chats-show-list"))
    expect(tabletSidebarOpen()).toBe(true)
    closeTabletSidebar()
  })
})
