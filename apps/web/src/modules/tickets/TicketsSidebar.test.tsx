// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  ),
)

const state = vi.hoisted(() => ({
  api: { post: vi.fn(), getEnvelope: vi.fn() } as any,
  ws: { status: () => "connected" as const },
  inboxes: [
    {
      id: "i1",
      connectedAccountId: "ca",
      name: "Support",
      emailAddress: "s@x",
      defaultTeam: null,
      defaultSensitivity: "internal",
      fromDisplayName: null,
      isDefaultForCreate: true,
      archivedAt: null,
    },
    {
      id: "i3",
      kind: "api",
      connectedAccountId: null,
      name: "Bug reports",
      emailAddress: null,
      defaultTeam: null,
      defaultSensitivity: "internal",
      fromDisplayName: null,
      isDefaultForCreate: false,
      archivedAt: null,
    },
  ],
  unread: { i1: 4, i3: 1 },
  // The server's total: more than the per-inbox sum (5) because tickets with
  // no source inbox are unread too.
  totalUnread: 9,
  categories: [{ id: "c1", parentId: null, name: "Bugs", sortOrder: 0, archivedAt: null }],
  loadInboxes: vi.fn(),
  loadCategories: vi.fn(),
  refreshInboxCounts: vi.fn(),
  refreshFilterCounts: vi.fn(),
  filterCounts: {
    "needs-attention": 3,
    "awaiting-customer": 84,
    "follow-ups": 2,
    closed: 7,
    "all-open": 61,
  } as Record<string, number>,
  loadTickets: vi.fn(),
  setListParams: vi.fn(),
  openTab: vi.fn(),
  listParams: {
    smartFilter: "all-open" as const,
    inboxId: null as string | null,
    categoryId: null as string | null,
  },
  tabs: [{ id: "tickets:inbox", type: "tickets:inbox", routePath: "/tickets?filter=all-open" }],
  activeTabId: "tickets:inbox",
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/shell/WsContext", () => ({ useWs: () => state.ws }))
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: state.openTab,
  tabStore: {
    get tabs() {
      return state.tabs
    },
    get activeTabId() {
      return state.activeTabId
    },
  },
}))
vi.mock("~/modules/tickets/ticket-inbox-store", () => ({
  loadInboxes: state.loadInboxes,
  refreshInboxCounts: state.refreshInboxCounts,
  totalUnreadAcrossInboxes: () => state.totalUnread,
  ticketInboxStore: {
    get inboxes() {
      return state.inboxes
    },
    get unreadByInboxId() {
      return state.unread
    },
  },
}))
vi.mock("~/modules/tickets/ticket-category-store", () => ({
  loadCategories: state.loadCategories,
  ticketCategoryStore: {
    get categories() {
      return state.categories
    },
  },
}))
vi.mock("~/modules/tickets/ticket-list-store", () => ({
  loadTickets: state.loadTickets,
  setListParams: state.setListParams,
  refreshFilterCounts: state.refreshFilterCounts,
  COUNTED_SMART_FILTERS: [
    "needs-attention",
    "awaiting-customer",
    "follow-ups",
    "closed",
    "all-open",
  ],
  filterRoutePath: (filter: string, inboxId?: string) =>
    `/tickets?filter=${inboxId ? `inbox:${inboxId}` : filter}`,
  paramsForInbox: (inboxId: string) => ({ smartFilter: "all-open", inboxId }),
  paramsForSmartFilter: (smartFilter: string) => ({ smartFilter }),
  ticketListStore: {
    get params() {
      return state.listParams
    },
  },
  ticketFilterCountStore: {
    get countByFilter() {
      return state.filterCounts
    },
  },
}))

import { attentionStore } from "~/modules/shell/attention-store"
import { newTicketDialogOpen, setNewTicketDialogOpen } from "./new-ticket-dialog"
import { TicketsSidebar } from "./TicketsSidebar"

const ticketAttention = (id: string): AttentionItem => ({
  id,
  app: "tickets",
  entity: "ticket",
  entityId: id,
  kind: "sla_risk",
  summary: id,
  urgency: 70,
  occurredAt: "2026-05-06T12:00:00.000Z",
  action: { type: "open_entity", tabType: "tickets:ticket", entityId: id },
})

const projectAttention = (id: string): AttentionItem => ({
  id,
  app: "projects",
  entity: "task",
  entityId: id,
  kind: "task_overdue",
  summary: id,
  urgency: 50,
  occurredAt: "2026-05-06T12:00:00.000Z",
  action: { type: "open_entity", tabType: "projects:task", entityId: id },
})

describe("TicketsSidebar", () => {
  beforeEach(() => {
    state.loadInboxes.mockReset()
    state.loadCategories.mockReset()
    state.refreshInboxCounts.mockReset()
    state.refreshFilterCounts.mockReset()
    state.loadTickets.mockReset()
    state.setListParams.mockReset()
    state.openTab.mockReset()
    state.listParams = { smartFilter: "all-open", inboxId: null, categoryId: null }
    state.tabs = [
      { id: "tickets:inbox", type: "tickets:inbox", routePath: "/tickets?filter=all-open" },
    ]
    attentionStore._setForTest({
      items: [ticketAttention("a1"), ticketAttention("a2"), projectAttention("p1")],
      errors: [],
      loading: false,
    })
  })

  it("loads inboxes / categories / counts on mount", () => {
    render(() => <TicketsSidebar />)
    expect(state.loadInboxes).toHaveBeenCalled()
    expect(state.loadCategories).toHaveBeenCalled()
    expect(state.refreshInboxCounts).toHaveBeenCalled()
  })

  it("tickets.sidebar.attention-from-store", () => {
    render(() => <TicketsSidebar />)
    expect(screen.getByTestId("tickets-sidebar-inbox-i1")).toBeTruthy()
    expect(screen.getByTestId("tickets-inbox-unread-i1").textContent).toBe("4")
    // "All open work" shows the open count of the list it opens, not an
    // unread total (the walk: "4" over a list of many more open tickets).
    expect(screen.getByTestId("tickets-filter-count-all-open").textContent).toBe("61")
    expect(screen.queryByTestId("tickets-total-unread")).toBeNull()
  })

  it("renders count badges for the counted smart filters (needs-attention via the search count, not the flaky feed) and fetches them on mount", () => {
    render(() => <TicketsSidebar />)
    expect(state.refreshFilterCounts).toHaveBeenCalled()
    // Needs attention count comes from tickets:search (same query the list uses),
    // so it always matches the list and never shows a "Retry" fallback.
    expect(screen.getByTestId("tickets-filter-count-needs-attention").textContent).toBe("3")
    expect(screen.getByTestId("tickets-filter-count-awaiting-customer").textContent).toBe("84")
    expect(screen.getByTestId("tickets-filter-count-follow-ups").textContent).toBe("2")
    expect(screen.getByTestId("tickets-filter-count-closed").textContent).toBe("7")
    // The old attention-feed badge (which could render "Retry") is gone.
    expect(screen.queryByTestId("tickets-attention-count")).toBeNull()
  })

  it("New ticket opens the list tab and the dialog, not just the list", () => {
    setNewTicketDialogOpen(false)
    render(() => <TicketsSidebar />)
    fireEvent.click(screen.getByTestId("tickets-new-button"))
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tickets:inbox", entityId: "inbox" }),
    )
    expect(newTicketDialogOpen()).toBe(true)
    setNewTicketDialogOpen(false)
  })

  it("clicking a smart filter updates list params and opens the inbox tab", () => {
    render(() => <TicketsSidebar />)
    fireEvent.click(screen.getByTestId("tickets-filter-needs-attention"))
    expect(state.setListParams).toHaveBeenCalledWith(
      expect.objectContaining({ smartFilter: "needs-attention" }),
    )
    expect(state.openTab).toHaveBeenCalledWith(expect.objectContaining({ type: "tickets:inbox" }))
    expect(state.loadTickets).toHaveBeenCalled()
  })

  it("clicking an inbox row scopes the list to that inbox", () => {
    render(() => <TicketsSidebar />)
    fireEvent.click(screen.getByTestId("tickets-sidebar-inbox-i1"))
    expect(state.setListParams).toHaveBeenCalledWith(expect.objectContaining({ inboxId: "i1" }))
  })

  it("clicking a category dispatches a category-scoped list", () => {
    render(() => <TicketsSidebar />)
    fireEvent.click(screen.getByTestId("tickets-sidebar-category-c1"))
    expect(state.setListParams).toHaveBeenCalledWith(expect.objectContaining({ categoryId: "c1" }))
  })

  it("renders an 'All' entry above the inbox list with the total unread count", () => {
    render(() => <TicketsSidebar />)
    const all = screen.getByTestId("tickets-sidebar-inbox-all")
    expect(all).toBeTruthy()
    // The server total, not the per-inbox sum (5).
    expect(screen.getByTestId("tickets-inbox-unread-all").textContent).toBe("9")
  })

  it("clicking 'All' clears the inbox filter (smart-filter params carry no inboxId)", () => {
    state.listParams = { smartFilter: "all-open", inboxId: "i1", categoryId: null }
    render(() => <TicketsSidebar />)
    fireEvent.click(screen.getByTestId("tickets-sidebar-inbox-all"))
    expect(state.setListParams).toHaveBeenCalledWith({ smartFilter: "all-open" })
    expect(state.loadTickets).toHaveBeenCalled()
  })

  it("rows under 'All' add up to it: unread tickets with no inbox get their own row", () => {
    render(() => <TicketsSidebar />)
    // 9 total, 4 + 1 in the inbox rows: 4 belong to no inbox.
    expect(screen.getByTestId("tickets-inbox-unread-none").textContent).toBe("4")
    const rows = ["i1", "i3", "none"].map((id) =>
      Number(screen.getByTestId(`tickets-inbox-unread-${id}`).textContent),
    )
    expect(rows.reduce((a, b) => a + b, 0)).toBe(
      Number(screen.getByTestId("tickets-inbox-unread-all").textContent),
    )
    // The section says its numbers are unread, not open.
    expect(screen.getByTestId("tickets-inbox-count-legend").textContent).toBe("unread")
  })

  it("no 'no inbox' row when every unread ticket sits in an inbox", () => {
    const before = state.totalUnread
    state.totalUnread = 5
    try {
      render(() => <TicketsSidebar />)
      expect(screen.queryByTestId("tickets-sidebar-inbox-none")).toBeNull()
    } finally {
      state.totalUnread = before
    }
  })

  it("lists categories as the tree Settings shows, children under their parent", () => {
    const before = state.categories
    // The Acme shape: escalation levels as roots, the same child name under
    // several of them, returned in arbitrary order.
    state.categories = [
      {
        id: "l2-achat",
        parentId: "l2",
        name: "Achat non comptabilisé",
        sortOrder: 0,
        archivedAt: null,
      },
      { id: "l1", parentId: null, name: "L1", sortOrder: 0, archivedAt: null },
      {
        id: "l1-achat",
        parentId: "l1",
        name: "Achat non comptabilisé",
        sortOrder: 0,
        archivedAt: null,
      },
      { id: "l2", parentId: null, name: "L2", sortOrder: 1, archivedAt: null },
      { id: "l1-autre", parentId: "l1", name: "Autre", sortOrder: 1, archivedAt: null },
      { id: "gone", parentId: "l1", name: "Archivée", sortOrder: 2, archivedAt: "2026-09-01" },
    ] as any
    try {
      render(() => <TicketsSidebar />)
      const rows = [
        ...screen.getByTestId("tickets-sidebar-categories").querySelectorAll("button"),
      ].map((b) => `${b.getAttribute("data-depth")}:${b.textContent}`)
      expect(rows).toEqual([
        "0:L1",
        "1:Achat non comptabilisé",
        "1:Autre",
        "0:L2",
        "1:Achat non comptabilisé",
      ])
    } finally {
      state.categories = before
    }
  })

  it("renders a kind badge per inbox (Mailbox vs API)", () => {
    render(() => <TicketsSidebar />)
    expect(screen.getByTestId("tickets-inbox-kind-i1").textContent).toBe("Mailbox")
    expect(screen.getByTestId("tickets-inbox-kind-i3").textContent).toBe("API")
  })
})
