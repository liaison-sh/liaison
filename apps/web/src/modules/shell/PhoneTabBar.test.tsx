// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M1-A T2: five FIXED seats. The bar this replaces seated the first four
// registry entries and reshuffled as apps registered, so the same thumb
// position meant a different app on every reload.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerActivityBarEntry, registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { attentionStore } from "~/modules/shell/attention-store"
import { resetChatsRootStore, setChatsThreadId } from "~/modules/shell/chats-root-store"
import { chatsOpen, resetDockStore } from "~/modules/shell/dock-store"
import { PhoneTabBar } from "~/modules/shell/PhoneTabBar"
import { openTab, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal("fetch", vi.fn())

const renderBar = () =>
  render(() => (
    <Router>
      <Route path="/*" component={() => <PhoneTabBar />} />
    </Router>
  ))

describe("PhoneTabBar", () => {
  beforeEach(() => {
    resetTabStore()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    resetDockStore()
    resetChatsRootStore()
    resetThreadStore()
    attentionStore._setForTest({ items: [] })
  })
  afterEach(() => cleanup())

  it("seats exactly five tabs, in the fixed order, whatever else is registered", () => {
    // Eight extra apps: the old bar dropped four of them into an overflow and
    // re-sorted the row. These seats do not move.
    for (let i = 0; i < 8; i++) {
      registerTabType(`app-${i}:home`, {
        component: () => null,
        sidebar: null,
        icon: () => null,
        urlPattern: `/app-${i}`,
        defaultLabel: `App${i}`,
      })
      registerActivityBarEntry({
        id: `app-${i}`,
        icon: () => null,
        label: `App${i}`,
        order: i,
        appId: `app-${i}`,
        tabAction: { type: `app-${i}:home`, entityId: `app-${i}`, label: `App${i}` },
      })
    }
    renderBar()
    const bar = screen.getByTestId("phone-tab-bar")
    const seats = [...bar.querySelectorAll("button")]
    expect(seats.map((s) => s.getAttribute("data-testid"))).toEqual([
      "phone-tab-home",
      "phone-tab-chats",
      "phone-tab-work",
      "phone-tab-search",
      "phone-tab-you",
    ])
    expect(seats.map((s) => s.getAttribute("aria-label"))).toEqual([
      "Home",
      "Chats",
      "Work",
      "Search",
      "You",
    ])
    // The overflow sheet is gone: nothing here opens one.
    expect(screen.queryByTestId("activity-more")).toBeNull()
  })

  it("every seat carries the 44px minimum hit area", () => {
    renderBar()
    const seats = [...screen.getByTestId("phone-tab-bar").querySelectorAll("button")]
    expect(seats.length).toBe(5)
    for (const seat of seats) {
      expect(seat.classList.contains("min-h-11")).toBe(true)
      expect(seat.classList.contains("min-w-11")).toBe(true)
    }
  })

  // D21: the Home seat carries the Home badge (what needs you, the desktop
  // rail's number); Chats the unread total; Work, a launcher, none.
  it("badges Home with what needs you, Chats with the unread total, Work with nothing", () => {
    addThread({ id: "t1", name: "One", type: "channel", unreadCount: 3, participants: [] })
    addThread({ id: "t2", name: "Two", type: "channel", unreadCount: 4, participants: [] })
    attentionStore._setForTest({
      items: [
        {
          id: "a1",
          app: "kernel",
          entity: "approval_request",
          entityId: "a1",
          kind: "approval_pending",
          summary: "Approve",
          urgency: 50,
          occurredAt: "2026-10-12T08:00:00.000Z",
          action: { type: "decide_approval", approvalId: "a1" },
        },
        {
          id: "q1",
          app: "projects",
          entity: "task",
          entityId: "q1",
          kind: "task_overdue",
          summary: "Overdue",
          urgency: 40,
          occurredAt: "2026-10-12T08:00:00.000Z",
        } as any,
      ],
    })
    renderBar()
    expect(screen.getByTestId("phone-tab-badge-chats").textContent).toBe("7")
    expect(screen.getByTestId("phone-tab-badge-home").textContent).toBe("1")
    expect(screen.queryByTestId("phone-tab-badge-work")).toBeNull()
    expect(screen.queryByTestId("phone-tab-badge-search")).toBeNull()
  })

  // F3: Chats is a root SCREEN, so the seat opens its tab like every other
  // seat. It used to open a full-screen sheet that covered this very bar.
  it("tapping Chats opens the Chats tab and leaves the sheet alone", () => {
    renderBar()
    fireEvent.click(screen.getByTestId("phone-tab-chats"))
    const chats = tabStore.tabs.find((t) => t.type === "kernel:chats")
    expect(chats).toBeDefined()
    expect(tabStore.activeTabId).toBe(chats?.id)
    expect(chatsOpen()).toBe(false)
    expect(screen.getByTestId("phone-tab-chats").getAttribute("aria-current")).toBe("page")
  })

  it("keeps the Chats seat lit on a conversation pushed from Chats", () => {
    setChatsThreadId("t-9")
    openTab({ type: "thread", entityId: "t-9", label: "Nine", preview: false })
    renderBar()
    expect(screen.getByTestId("phone-tab-chats").getAttribute("aria-current")).toBe("page")

    // A thread reached from somewhere else is not inside the Chats stack.
    openTab({ type: "thread", entityId: "t-other", label: "Other", preview: false })
    expect(screen.getByTestId("phone-tab-chats").getAttribute("aria-current")).toBeNull()
  })

  it("tapping Work opens the Work tab and highlights the seat", () => {
    renderBar()
    fireEvent.click(screen.getByTestId("phone-tab-work"))
    const work = tabStore.tabs.find((t) => t.type === "kernel:work")
    expect(work).toBeDefined()
    expect(tabStore.activeTabId).toBe(work?.id)
    expect(screen.getByTestId("phone-tab-work").getAttribute("aria-current")).toBe("page")
    expect(screen.getByTestId("phone-tab-search").getAttribute("aria-current")).toBeNull()
  })

  it("You lands on the user's own settings section", () => {
    renderBar()
    fireEvent.click(screen.getByTestId("phone-tab-you"))
    const settings = tabStore.tabs.find((t) => t.type === "kernel:settings")
    expect(settings).toBeDefined()
    expect(settings?.routePath).toBe("/settings")
  })
})
