// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Rule 6, one badge, one meaning: the desktop dock and the browser tab title
// show the SAME number, the unread things that ask for the person, and it is
// the number the server sends the phone (`GET /notifications/badge`, the count
// every push carries). Channel traffic that names nobody is not in it. The Home
// entry shows its own number instead, the rows of its Needs you section
// (home-action-count.ts), as the phone's Home tab does.
import type { AttentionItem } from "@liaison/shared"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DESKTOP_BRIDGE_KEY, DESKTOP_BRIDGE_VERSION } from "~/lib/desktop-shell-contract"
import HomeIconWithDot from "~/modules/approvals/HomeIconWithDot"
import {
  appBadgeCount,
  localAppBadgeCount,
  refreshAppBadge,
  resetAppBadgeStore,
  startAppBadgeSync,
} from "~/modules/notifications/app-badge-store"
import { DesktopBadgeTestAccess, startDesktopBadge } from "~/modules/notifications/desktop-badge"
import { startTabBadge, TabBadgeTestAccess } from "~/modules/notifications/tab-badge"
import { attentionStore } from "~/modules/shell/attention-store"
import { homeActionCount } from "~/modules/shell/home-action-count"
import { addThread, markThreadRead, resetThreadStore } from "~/modules/threads/thread-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const dock: number[] = []
let serverBadge = 0
const api = {
  get: vi.fn(async (path: string) => {
    if (path === "/notifications/badge") return { count: serverBadge, unreadThreadIds: [] }
    throw new Error(`unexpected GET ${path}`)
  }),
  patch: vi.fn(async () => ({ data: { ok: true } })),
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

function row(id: string, kind: string, extra: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    app: "kernel",
    entity: "thread",
    entityId: id,
    kind: kind as AttentionItem["kind"],
    summary: id,
    urgency: 50,
    occurredAt: "2026-11-03T10:00:00Z",
    action: { type: "open_entity", tabType: "kernel:thread", entityId: id },
    ...extra,
  }
}

const homeBadge = () => screen.queryByTestId("activity-bar-home-badge")?.textContent ?? "0"
const tabNumber = () => /^\((\d+\+?)\) /.exec(document.title)?.[1] ?? "0"
const dockNumber = () => String(dock.at(-1) ?? 0)

function startAll(): void {
  ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY] = {
    version: DESKTOP_BRIDGE_VERSION,
    setUnreadBadge: async (count: number) => {
      dock.push(count)
    },
  }
  document.title = "Liaison"
  startTabBadge()
  startDesktopBadge()
  render(() => <HomeIconWithDot />)
}

describe("one badge on every surface (rule 6)", () => {
  beforeEach(() => {
    dock.length = 0
    serverBadge = 0
    resetThreadStore()
    resetAppBadgeStore()
    attentionStore._setForTest({ items: [], errors: [], loading: false })
  })
  afterEach(() => {
    cleanup()
    TabBadgeTestAccess.reset()
    DesktopBadgeTestAccess.reset()
    resetAppBadgeStore()
    delete (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY]
  })

  it("the dock and the tab title show the direct asks, and only them; Home its Needs you rows", () => {
    addThread(thread("dm", 2, null))
    addThread(thread("channel", 9, "support"))
    attentionStore._setForTest({
      items: [
        row("m1", "mention", { entityId: "channel" }),
        row("ap1", "approval_pending", {
          entity: "approval_request",
          action: { type: "decide_approval", approvalId: "ap1" },
        }),
        row("r1", "thread_reply", { entityId: "channel" }),
        row("sla", "sla_risk", { app: "tickets", entity: "ticket", urgency: 90 }),
      ],
    })
    startAll()
    expect(localAppBadgeCount()).toBe(4)
    expect(tabNumber()).toBe("4")
    expect(dockNumber()).toBe("4")
    // The approval and the SLA risk: a mention and unread messages are Messages things.
    expect(homeActionCount()).toBe(2)
    expect(homeBadge()).toBe("2")
  })

  it("the dock and the tab take the server's number, the phone's, and follow a read together", async () => {
    addThread(thread("dm", 2, null))
    serverBadge = 12 // a direct conversation outside the list the client holds
    startAppBadgeSync(api)
    await refreshAppBadge()
    startAll()
    expect(appBadgeCount()).toBe(12)
    expect([tabNumber(), dockNumber()]).toEqual(["12", "12"])
    // Unread conversations are not Home rows: its entry shows no number.
    expect(homeBadge()).toBe("0")

    markThreadRead(api, "dm")
    expect(appBadgeCount()).toBe(10)
    expect([tabNumber(), dockNumber()]).toEqual(["10", "10"])
  })
})
