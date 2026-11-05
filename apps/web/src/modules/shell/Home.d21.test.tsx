// SPDX-License-Identifier: FSL-1.1-ALv2
// D21: Home's main panel. Conversations left it for Messages; a sidebar entry
// (or a phone chip) filters it to one slice and Overview brings the cards back.
import type { AttentionItem } from "@liaison/shared"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: () => true,
  userFromToken: () => ({ userId: "u-1", name: "Tester" }),
}))

const apiStub = {
  get: vi.fn(async () => []),
  getEnvelope: vi.fn(async () => ({ data: { items: [], errors: [] } })),
  post: vi.fn(async () => ({})),
  patch: vi.fn(async () => ({})),
  put: vi.fn(async () => ({})),
}
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiStub,
  useOptionalApi: () => apiStub,
}))

import { resetRegistry } from "~/framework/app-registry"
import { attentionStore } from "~/modules/shell/attention-store"
import Home from "~/modules/shell/Home"
import { resetHomeCardLayout } from "~/modules/shell/home-card-layout"
import { homeFilter, setHomeFilter } from "~/modules/shell/home-filter"
import { resetTabStore } from "~/modules/shell/tab-store"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"
import { setShellTier } from "~/tests/helpers/shell-tier"

const item = (over: Partial<AttentionItem> & { id: string }): AttentionItem => ({
  app: "tickets",
  entity: "ticket",
  entityId: over.id,
  kind: "sla_risk",
  summary: `summary ${over.id}`,
  urgency: 50,
  occurredAt: "2026-10-12T08:00:00.000Z",
  action: { type: "open_entity", tabType: "tickets:ticket", entityId: over.id },
  ...over,
})
const approval = (id: string, tool: string): AttentionItem =>
  item({
    id,
    app: "kernel",
    entity: "approval_request",
    kind: "approval_pending",
    summary: `approve ${id}`,
    action: { type: "decide_approval", approvalId: id },
    metadata: { toolName: tool, actionLabel: tool },
  })

const feed: AttentionItem[] = [
  approval("a1", "contacts:group_delete"),
  approval("a2", "mail:reply"),
  item({ id: "w1", kind: "awaiting_agent", urgency: 60 }),
  item({ id: "sys", app: "kernel", entity: "system", kind: "system_alert" }),
  item({ id: "m1", app: "kernel", entity: "thread", kind: "mention", urgency: 60 }),
]

beforeEach(() => {
  setShellTier("desktop")
  resetRegistry()
  resetTabStore()
  resetHomeCardLayout()
  resetThreadStore()
  setHomeFilter("overview")
  attentionStore._setForTest({ items: feed, errors: [], loading: false })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("Home (D21)", () => {
  it("the overview no longer lists conversations: no unread thread, no mention", () => {
    addThread({
      id: "t-dm",
      handle: "t-dm",
      title: "DM",
      isPinned: false,
      isPinnedByUser: false,
      isMuted: false,
      participants: [],
      updatedAt: new Date().toISOString(),
      unreadCount: 3,
    } as never)
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId("home-message-row-t-dm")).toBeNull()
    expect(screen.queryByTestId("home-unread-list")).toBeNull()
    expect(screen.queryByTestId("attention-row-kernel-thread-m1")).toBeNull()
    // The cards are still there.
    expect(screen.getByTestId("attention-row-kernel-approval_request-a1")).toBeTruthy()
  })

  // e2e attention-feed (2026-10-12): an approval expiring within the hour is
  // time-limited, and the overview drew it twice, in the Approvals card AND in
  // the alerts card. It is decided where the approvals are: once.
  it("an approval expiring within the hour renders once, in the Approvals card", () => {
    const soon = new Date(Date.now() + 30 * 60_000).toISOString()
    const expiring = {
      ...approval("a-exp", "test:approve"),
      metadata: { toolName: "test:approve", actionLabel: "test:approve", expiresAt: soon },
    }
    attentionStore._setForTest({ items: [...feed, expiring], errors: [], loading: false })
    render(() => <Home entityId="home" />)
    const rows = screen.getAllByTestId("attention-row-kernel-approval_request-a-exp")
    expect(rows).toHaveLength(1)
    expect(screen.getByTestId("home-card-body-approvals").contains(rows[0]!)).toBe(true)
  })

  it("a sidebar filter shows only its slice, and Overview brings the cards back", () => {
    render(() => <Home entityId="home" />)
    setHomeFilter("needs:approvals:mail:reply")
    expect(screen.getByTestId("home-slice").dataset.filter).toBe("needs:approvals:mail:reply")
    expect(screen.getByTestId("attention-row-kernel-approval_request-a2")).toBeTruthy()
    expect(screen.queryByTestId("attention-row-kernel-approval_request-a1")).toBeNull()
    expect(screen.queryByTestId("home-feed")).toBeNull()

    setHomeFilter("queue:tickets")
    expect(screen.getByTestId("attention-row-tickets-ticket-w1")).toBeTruthy()
    expect(screen.queryByTestId("attention-row-kernel-approval_request-a2")).toBeNull()

    fireEvent.click(screen.getByTestId("home-slice-back"))
    expect(homeFilter()).toBe("overview")
    expect(screen.getByTestId("home-feed")).toBeTruthy()
  })

  it("the status line counts what needs you, not tickets awaiting a reply", () => {
    render(() => <Home entityId="home" />)
    // Two approvals and the system alert; the awaiting ticket is queued.
    expect(screen.getByTestId("home-status").textContent).toContain("3")
    expect(screen.getByTestId("home-status").textContent).toMatch(/1\s+\S+/)
  })

  it("on a phone, chips under the greeting filter the feed", () => {
    setShellTier("phone")
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-chip-needs-count").textContent).toBe("3")
    expect(screen.getByTestId("home-chip-queues-count").textContent).toBe("1")
    // No agent row to show: no Agents chip opening an empty slice (walk 2026-10-12).
    expect(screen.queryByTestId("home-chip-agents")).toBeNull()
    fireEvent.click(screen.getByTestId("home-chip-queues"))
    expect(homeFilter()).toBe("queues")
    expect(screen.getByTestId("home-slice")).toBeTruthy()
    fireEvent.click(screen.getByTestId("home-chip-queues"))
    expect(homeFilter()).toBe("overview")
  })
})
