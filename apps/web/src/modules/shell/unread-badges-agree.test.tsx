// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S8, A14 follow-up: every unread-chat badge reads ONE source, the server's
// unread total (`GET /threads/unread-count`, adjusted locally on read). The
// dock's Chats pill and the phone's Chats seat used to sum the 50 threads the
// client list holds, so they disagreed with the Messages rail entry.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { TabBadgeTestAccess } from "~/modules/notifications/tab-badge"
import { ActivityBar } from "~/modules/shell/ActivityBar"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { attentionStore } from "~/modules/shell/attention-store"
import { ChatsTab } from "~/modules/shell/ChatsTab"
import { resetChatsRootStore } from "~/modules/shell/chats-root-store"
import { resetDockStore } from "~/modules/shell/dock-store"
import { PhoneTabBar } from "~/modules/shell/PhoneTabBar"
import { resetTabStore } from "~/modules/shell/tab-store"
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

/** The 50 threads the client list holds, one unread message each. */
const LISTED = Array.from({ length: 50 }, (_, i) => ({
  id: `t${i}`,
  handle: `thread-${i}`,
  title: `Thread ${i}`,
  isPinned: false,
  isPinnedByUser: false,
  isMuted: false,
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

function renderAllBadges() {
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <WsProvider send={() => {}} status={wsStatus}>
              <ActivityBar />
              <ChatsTab />
              <PhoneTabBar />
            </WsProvider>
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

const dockLabel = () => screen.getByTestId("dock-chats").querySelector('[role="status"]')
const phoneBadge = () => screen.getByTestId("phone-tab-badge-chats")
const railBadge = () => screen.getByTestId("activity-bar-badge-messages")

describe("unread-chat badges agree (S8, A14)", () => {
  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: () => Promise.resolve(JSON.stringify({ data: [] })),
        }),
      ),
    )
    resetRegistry()
    resetBootstrap()
    resetTabStore()
    resetDockStore()
    resetChatsRootStore()
    resetThreadStore()
    resetUnreadCountStore()
    attentionStore._setForTest({ items: [] })
    bootstrapKernelApps()
    api.get.mockClear()
    await loadThreads(api)
    setUnreadCountApi(api)
  })
  afterEach(() => {
    cleanup()
    TabBadgeTestAccess.reset()
    resetUnreadCountStore()
  })

  it("the dock pill, the phone seat and the Messages entry all show the server total", async () => {
    serverCount = 120
    expect(totalUnreadCount()).toBe(50)
    await refreshUnreadCount()
    renderAllBadges()

    expect(messagesUnreadCount()).toBe(120)
    expect(dockLabel()?.getAttribute("aria-label")).toBe("120 unread")
    expect(phoneBadge().getAttribute("aria-label")).toBe("120 Chats")
    // Displayed text is capped, identically on all three.
    expect(dockLabel()?.textContent).toBe("99+")
    expect(phoneBadge().textContent).toBe("99+")
    expect(railBadge().textContent).toBe("99+")
  })

  it("reading a thread lowers all three by the same amount", async () => {
    serverCount = 52
    await refreshUnreadCount()
    renderAllBadges()
    expect(dockLabel()?.textContent).toBe("52")
    expect(phoneBadge().textContent).toBe("52")
    expect(railBadge().textContent).toBe("52")

    markThreadRead(api, "t0")
    markThreadRead(api, "t1")
    markThreadRead(api, "t2")
    await waitFor(() => expect(railBadge().textContent).toBe("49"))
    expect(dockLabel()?.textContent).toBe("49")
    expect(dockLabel()?.getAttribute("aria-label")).toBe("49 unread")
    expect(phoneBadge().textContent).toBe("49")
    expect(phoneBadge().getAttribute("aria-label")).toBe("49 Chats")
  })

  it("Home and Messages count different things", async () => {
    serverCount = 7
    await refreshUnreadCount()
    attentionStore._setForTest({
      items: [
        {
          id: "ap-1",
          app: "kernel",
          entity: "approval_request",
          entityId: "ap-1",
          kind: "approval_pending",
          summary: "Delete contact group",
          urgency: 50,
          occurredAt: "2026-10-12T08:00:00.000Z",
          action: { type: "decide_approval", approvalId: "ap-1" },
        },
        {
          id: "reply-1",
          app: "kernel",
          entity: "thread",
          entityId: "t0",
          kind: "thread_reply",
          summary: "hi",
          urgency: 30,
          occurredAt: "2026-10-12T08:00:00.000Z",
          action: { type: "open_entity", tabType: "kernel:thread", entityId: "t0" },
        },
      ],
    })
    renderAllBadges()
    expect(railBadge().textContent).toBe("7")
    expect(screen.getByTestId("activity-bar-home-badge").textContent).toBe("1")

    // A new unread message moves Messages only.
    serverCount = 8
    await refreshUnreadCount()
    expect(railBadge().textContent).toBe("8")
    expect(screen.getByTestId("activity-bar-home-badge").textContent).toBe("1")
  })
})
