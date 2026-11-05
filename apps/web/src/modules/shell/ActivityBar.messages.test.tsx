// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S8, A14: the desktop and web rail has a Messages entry next to Home. It opens
// the chats list, and its badge is the server's unread total
// (`GET /threads/unread-count`), not the sum over the 50 threads the client
// list holds. Reading a thread clears it. The phone keeps its own five seats.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getActivityBarEntries, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { ActivityBar } from "~/modules/shell/ActivityBar"
import { openTab, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { Work } from "~/modules/shell/Work"
import { WsProvider } from "~/modules/shell/WsContext"
import {
  loadThreads,
  markThreadRead,
  resetThreadStore,
  totalUnreadCount,
} from "~/modules/threads/thread-store"
import {
  messagesUnreadCount,
  refreshUnreadCount,
  resetUnreadCountStore,
  setUnreadCountApi,
} from "~/modules/threads/unread-count-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const [wsStatus] = createSignal<"connected" | "disconnected">("connected")

function renderRail() {
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <WsProvider send={() => {}} status={wsStatus}>
            <ActivityBar />
          </WsProvider>
        )}
      />
    </Router>
  ))
}

/** The 50 threads the client list holds, one unread message each. */
const LISTED = Array.from({ length: 50 }, (_, i) => ({
  id: `t${i}`,
  handle: `thread-${i}`,
  title: `Thread ${i}`,
  isPinned: false,
  isPinnedByUser: false,
  participants: [],
  updatedAt: new Date(Date.now() - i * 1000).toISOString(),
  unreadCount: 1,
}))

let serverCount = 0
const api = {
  get: vi.fn(async (path: string) => {
    // The real client unwraps the envelope (api-client.ts get): `{ count }`.
    if (path === "/threads/unread-count") return { count: serverCount }
    if (path.startsWith("/threads?")) return { data: LISTED }
    throw new Error(`unexpected GET ${path}`)
  }),
  patch: vi.fn(async () => ({ data: { ok: true } })),
}

describe("Messages rail entry (S8, A14)", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn())
    resetRegistry()
    resetBootstrap()
    resetTabStore()
    resetThreadStore()
    resetUnreadCountStore()
    bootstrapKernelApps()
    api.get.mockClear()
    api.patch.mockClear()
    await loadThreads(api)
    setUnreadCountApi(api)
  })
  afterEach(() => {
    cleanup()
    resetUnreadCountStore()
  })

  it("sits next to Home and opens the chats list", () => {
    const top = getActivityBarEntries().filter((e) => e.position !== "bottom")
    const home = top.find((e) => e.label === "Home")
    const messages = top.find((e) => e.label === "Messages")
    expect(messages).toBeDefined()
    expect(messages!.labelKey).toBe("kernel.nav.messages")
    expect(messages!.order).toBeGreaterThan(home!.order)
    expect(top.filter((e) => e.order < messages!.order)).toEqual([home])

    renderRail()
    fireEvent.click(screen.getByTestId("activity-messages"))
    const active = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
    expect(active?.type).toBe("kernel:chats")
  })

  it("stays lit while a conversation from its sidebar is open", () => {
    renderRail()
    fireEvent.click(screen.getByTestId("activity-messages"))
    openTab({ type: "kernel:thread", entityId: "t3", label: "Thread 3", preview: false })
    const messages = screen.getByTestId("activity-messages")
    expect(messages.getAttribute("aria-current")).toBe("page")
    expect(screen.getByTestId("activity-home").getAttribute("aria-current")).toBeNull()
  })

  it("shows the server's unread total, past the 50 threads the list holds", async () => {
    serverCount = 75
    expect(totalUnreadCount()).toBe(50)
    await refreshUnreadCount()

    renderRail()
    const badge = await screen.findByTestId("activity-bar-badge-messages")
    expect(badge.textContent).toBe("75")
    expect(api.get).toHaveBeenCalledWith("/threads/unread-count")
  })

  it("reading a thread clears its part of the badge at once, and the server total follows", async () => {
    serverCount = 2
    // Only two unread anywhere: in the first listed thread, read below.
    await refreshUnreadCount()
    renderRail()
    expect((await screen.findByTestId("activity-bar-badge-messages")).textContent).toBe("2")

    // Reading lowers the local total; the badge drops without waiting for the
    // server. The server's own answer then agrees.
    serverCount = 0
    markThreadRead(api, "t0")
    markThreadRead(api, "t1")
    expect(messagesUnreadCount()).toBe(0)
    await waitFor(() => expect(screen.queryByTestId("activity-bar-badge-messages")).toBeNull())
    await refreshUnreadCount()
    expect(screen.queryByTestId("activity-bar-badge-messages")).toBeNull()
  })

  it("leaves the phone alone: the Work screen lists no Messages row", () => {
    render(() => <Work />)
    expect(screen.queryByLabelText("Messages")).toBeNull()
  })
})
