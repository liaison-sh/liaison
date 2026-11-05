// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-1 T10. The phone ticket list: the chip row, the state pills on a row, the
// swipe actions and the Select mode. Every assertion is on behaviour or on
// rendered text, never on a class string.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn(), get: vi.fn(), getEnvelope: vi.fn() } as any,
  ws: { status: () => "connected" as const },
  counts: {
    "needs-attention": 3,
    "awaiting-customer": 1,
    "follow-ups": 0,
    closed: 12,
    "all-open": 40,
  } as Record<string, number>,
  unreadByInboxId: { ibx1: 5 } as Record<string, number>,
  ids: ["t1", "t2"],
  byId: {} as Record<string, any>,
  selection: {} as Record<string, boolean>,
  params: { smartFilter: "all-open" } as any,
  drafts: new Set<string>(),
  loadTickets: vi.fn(),
  setListParams: vi.fn(),
  refreshFilterCounts: vi.fn(),
  toggleSelection: vi.fn(),
  openTab: vi.fn(),
  assignTicket: vi.fn(async () => {}),
  searchMentions: vi.fn(async () => [{ type: "user", id: "u9", label: "Dana Ops" }]),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/shell/WsContext", () => ({ useWs: () => state.ws }))
vi.mock("~/modules/auth/auth-store", () => ({
  hasScope: () => true,
  userFromToken: () => ({ userId: "u-1", name: "Tester" }),
}))
vi.mock("~/lib/mention-service", () => ({ searchMentions: state.searchMentions }))
vi.mock("~/modules/tickets/ticket-detail-store", () => ({ assignTicket: state.assignTicket }))
vi.mock("~/modules/tickets/ticket-agent-draft", () => ({
  hasAgentDraft: (id: string) => state.drafts.has(id),
}))
vi.mock("~/modules/tickets/TicketCloseDialog", () => ({
  TicketCloseDialog: (props: any) => (
    <div data-testid="ticket-close-dialog" data-ticket-id={props.ticketId} />
  ),
}))
vi.mock("~/modules/tickets/ticket-inbox-store", () => ({
  loadInboxes: vi.fn(),
  ticketInboxStore: {
    get inboxes() {
      return [{ id: "ibx1", name: "Support", archivedAt: null }]
    },
    get loaded() {
      return true
    },
    get unreadByInboxId() {
      return state.unreadByInboxId
    },
  },
}))
vi.mock("~/modules/tickets/ticket-category-store", () => ({
  loadCategories: vi.fn(),
  ticketCategoryStore: {
    get categories() {
      return [] as any[]
    },
    get loaded() {
      return true
    },
  },
}))
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: state.openTab,
  tabStore: {
    get tabs() {
      return [{ id: "tickets:inbox", type: "tickets:inbox", routePath: "/tickets?filter=all-open" }]
    },
    get activeTabId() {
      return "tickets:inbox"
    },
  },
}))
vi.mock("~/modules/tickets/ticket-list-store", () => ({
  loadTickets: state.loadTickets,
  paramsFromRoutePath: () => ({ smartFilter: "all-open" }),
  paramsForSmartFilter: (filter: string) => ({ smartFilter: filter }),
  filterRoutePath: (filter: string) => `/tickets?filter=${filter}`,
  refreshFilterCounts: state.refreshFilterCounts,
  searchOverridesView: () => false,
  setListParams: state.setListParams,
  setReloadHook: vi.fn(),
  setStatusFilter: vi.fn(),
  setPriorityFilter: vi.fn(),
  setInboxFilter: vi.fn(),
  setCategoryFilter: vi.fn(),
  setSortMode: vi.fn(),
  toggleSelection: state.toggleSelection,
  clearSelection: vi.fn(),
  selectedIds: () => Object.keys(state.selection),
  ticketFilterCountStore: {
    get countByFilter() {
      return state.counts
    },
  },
  ticketListStore: {
    get ids() {
      return state.ids
    },
    get byId() {
      return state.byId
    },
    get selection() {
      return state.selection
    },
    get loading() {
      return false
    },
    get loaded() {
      return true
    },
    get hasMore() {
      return false
    },
    get params() {
      return state.params
    },
  },
}))

import { closePhoneNavigator, phoneNavigatorOpen } from "~/modules/shell/phone-navigator-store"
import { PHONE_QUERY, syncShellTier } from "~/modules/shell/shell-tier"
import { TicketsInbox } from "./TicketsInbox"

function setTier(tier: "phone" | "desktop") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: tier === "phone" ? query === PHONE_QUERY : query === "(min-width: 1024px)",
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

const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString()

beforeEach(() => {
  state.loadTickets.mockReset()
  state.setListParams.mockReset()
  state.openTab.mockReset()
  state.toggleSelection.mockReset()
  state.assignTicket.mockClear()
  // The assign sheet reads the member directory; the people search is down.
  state.searchMentions.mockRejectedValue(new Error("Mention search unavailable"))
  state.api.getEnvelope = vi.fn(async (path: string) =>
    path.startsWith("/mentions/members")
      ? { data: [{ id: "u9", name: "Dana Ops", email: "dana@x.test" }], meta: { total: 1 } }
      : { data: [] },
  )
  state.selection = {}
  state.drafts = new Set(["t2"])
  state.params = { smartFilter: "all-open" }
  state.byId = {
    t1: {
      id: "t1",
      handle: "ticket-1",
      subject: "Pedal not detected",
      status: "open",
      priority: "normal",
      sourceInboxId: "ibx1",
      contact: { id: "c1", name: "Alice", email: "alice@test.local" },
      slaDeadline: soon,
      firstResponseAt: null,
      lastInboundAt: new Date(Date.now() - 60_000).toISOString(),
      lastOutboundAt: null,
      lastMessageAt: new Date(Date.now() - 60_000).toISOString(),
    },
    t2: {
      id: "t2",
      handle: "ticket-2",
      subject: "Refund request",
      status: "awaiting_customer",
      priority: "high",
      sourceInboxId: "ibx1",
      slaDeadline: null,
      firstResponseAt: new Date(Date.now() - 600_000).toISOString(),
      lastMessageAt: new Date(Date.now() - 600_000).toISOString(),
    },
  }
  setTier("phone")
})

afterEach(() => {
  cleanup()
  setTier("desktop")
})

describe("TicketsInbox at phone tier", () => {
  it("shows the screen title and one chip per saved view, with the store's counts", () => {
    render(() => <TicketsInbox />)
    expect(screen.getByTestId("tickets-phone-header").textContent).toContain("Tickets")
    expect(screen.getByTestId("tickets-chip-needs-attention").textContent).toContain(
      "Needs attention",
    )
    expect(screen.getByTestId("tickets-chip-count-needs-attention").textContent).toBe("3")
    expect(screen.getByTestId("tickets-chip-count-closed").textContent).toBe("12")
    // all-open reports the open count of the view, never the unread total (5).
    expect(screen.getByTestId("tickets-chip-count-all-open").textContent).toBe("40")
  })

  it("a chip switches the view through the store and the tab route", () => {
    render(() => <TicketsInbox />)
    fireEvent.click(screen.getByTestId("tickets-chip-closed"))
    expect(state.setListParams).toHaveBeenCalledWith({ smartFilter: "closed" })
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tickets:inbox", routePath: "/tickets?filter=closed" }),
    )
    expect(state.loadTickets).toHaveBeenCalled()
  })

  it("a row carries the state pills its data implies, and nothing it does not", () => {
    render(() => <TicketsInbox />)
    expect(screen.getByTestId("tickets-card-pill-sla-t1").textContent).toContain("SLA risk")
    expect(screen.getByTestId("tickets-card-pill-waiting-t1").textContent).toContain(
      "Waiting on us",
    )
    expect(screen.queryByTestId("tickets-card-pill-draft-t1")).toBeNull()
    // t2 has an agent draft pending and has been replied to.
    expect(screen.getByTestId("tickets-card-pill-draft-t2").textContent).toContain("Draft ready")
    expect(screen.getByTestId("tickets-card-pill-replied-t2").textContent).toContain("Replied")
    expect(screen.queryByTestId("tickets-card-pill-sla-t2")).toBeNull()
  })

  it("anchors the row on the subject and names sender, inbox and last activity", () => {
    render(() => <TicketsInbox />)
    expect(screen.getByTestId("tickets-card-subject-t1").textContent).toBe("Pedal not detected")
    expect(screen.getByTestId("tickets-card-contact-t1").textContent).toContain("Alice")
    // The separator travels WITH the inbox name, so it can never be left
    // hanging on its own.
    expect(screen.getByTestId("tickets-card-inbox-t1").textContent).toBe("\u00b7 Support")
    expect(screen.getByTestId("tickets-card-activity-t1").textContent).toContain("minute")
  })

  it("the Assign swipe action opens the picker and assigns through the store", async () => {
    render(() => <TicketsInbox />)
    const rail = screen.getByTestId("tickets-swipe-t1")
    fireEvent.click(rail.querySelector('[data-testid="swipe-action-assign"]')!)
    await waitFor(() => expect(screen.getByTestId("ticket-assign-sheet")).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId("ticket-assign-member-u9")).toBeTruthy())
    fireEvent.click(screen.getByTestId("ticket-assign-member-u9"))
    expect(state.assignTicket).toHaveBeenCalledWith(state.api, "t1", "u9", "Dana Ops")
  })

  it("the assign sheet says when teammates cannot be loaded, and retries", async () => {
    state.api.getEnvelope = vi.fn(async () => {
      throw new Error("boom")
    })
    render(() => <TicketsInbox />)
    const rail = screen.getByTestId("tickets-swipe-t1")
    fireEvent.click(rail.querySelector('[data-testid="swipe-action-assign"]')!)
    await waitFor(() => expect(screen.getByTestId("tickets-assignee-error")).toBeTruthy())
    state.api.getEnvelope = vi.fn(async () => ({
      data: [{ id: "u9", name: "Dana Ops", email: "dana@x.test" }],
      meta: { total: 1 },
    }))
    fireEvent.click(screen.getByTestId("tickets-assignee-retry"))
    await waitFor(() => expect(screen.getByTestId("ticket-assign-member-u9")).toBeTruthy())
  })

  it("the Close swipe action opens the existing close flow for that ticket", async () => {
    render(() => <TicketsInbox />)
    const rail = screen.getByTestId("tickets-swipe-t2")
    fireEvent.click(rail.querySelector('[data-testid="swipe-action-close"]')!)
    await waitFor(() => expect(screen.getByTestId("ticket-close-dialog")).toBeTruthy())
    expect(screen.getByTestId("ticket-close-dialog").getAttribute("data-ticket-id")).toBe("t2")
  })

  it("Select turns the rows into checkboxes that drive the store's selection", () => {
    render(() => <TicketsInbox />)
    expect(screen.queryByTestId("tickets-card-checkbox-t1")).toBeNull()
    fireEvent.click(screen.getByTestId("tickets-select-toggle"))
    expect(screen.getByTestId("tickets-card-checkbox-t1")).toBeTruthy()
    fireEvent.click(screen.getByTestId("tickets-card-checkbox-t1"))
    expect(state.toggleSelection).toHaveBeenCalledWith("t1")
    // With Select on, tapping the row selects rather than navigates.
    fireEvent.click(screen.getByTestId("tickets-card-t2"))
    expect(state.toggleSelection).toHaveBeenCalledWith("t2")
    expect(state.openTab).not.toHaveBeenCalled()
  })

  it("loads the chip counts when the window is narrowed into the phone tier", async () => {
    // The tab stays mounted across a resize, so reading the tier ONCE at mount
    // left a chip row whose counts had never been fetched: the desktop sidebar
    // that normally refreshes them is not mounted at phone width either.
    setTier("desktop")
    state.refreshFilterCounts.mockClear()
    render(() => <TicketsInbox />)
    expect(state.refreshFilterCounts).not.toHaveBeenCalled()

    setTier("phone")
    await waitFor(() => expect(state.refreshFilterCounts).toHaveBeenCalled())
    expect(screen.getByTestId("tickets-chip-count-needs-attention").textContent).toBe("3")
  })

  it("the large title opens the navigator, which is where the inboxes and saved views are", () => {
    // Hiding the phone top bar took the navigator opener with it, and the chip
    // row carries only the smart filters: per-inbox counts and saved views sit
    // in the registered sidebar, which had no way in at all on a phone.
    closePhoneNavigator()
    render(() => <TicketsInbox />)
    expect(phoneNavigatorOpen()).toBe(false)

    fireEvent.click(screen.getByTestId("tickets-phone-title"))
    expect(phoneNavigatorOpen()).toBe(true)
    closePhoneNavigator()
  })

  it("renders none of the phone chrome off the phone tier", () => {
    setTier("desktop")
    render(() => <TicketsInbox />)
    expect(screen.queryByTestId("tickets-phone-header")).toBeNull()
    expect(screen.queryByTestId("tickets-chip-row")).toBeNull()
  })
})

// F6 polish. The meta line carried a standalone "\u00b7" before a timestamp that
// `ml-auto` pushes to the far end of the row: at phone width the separator was
// left dangling in the middle of the line, next to nothing.
describe("TicketsInbox card meta separators", () => {
  it("never renders a separator on its own", () => {
    render(() => <TicketsInbox />)
    const line = screen.getByTestId("tickets-card-activity-t1").parentElement as HTMLElement
    const standalone = Array.from(line.children).filter(
      (el) => (el.textContent ?? "").trim() === "\u00b7",
    )
    expect(standalone).toHaveLength(0)
  })

  it("carries exactly one separator, the one attached to the inbox name", () => {
    render(() => <TicketsInbox />)
    const line = screen.getByTestId("tickets-card-activity-t1").parentElement as HTMLElement
    const dots = (line.textContent ?? "").split("\u00b7").length - 1
    expect(dots).toBe(1)
    expect(screen.getByTestId("tickets-card-inbox-t1").textContent).toContain("\u00b7")
  })
})
