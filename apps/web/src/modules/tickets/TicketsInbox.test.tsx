// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn() } as any,
  ws: { status: () => "connected" as const },
  inboxes: [
    { id: "ibx1", name: "Support", archivedAt: null },
    { id: "ibx2", name: "Bug reports (API)", archivedAt: null },
  ],
  inboxesLoaded: true,
  loadInboxes: vi.fn(),
  ids: ["t1", "t2"],
  byId: {
    t1: {
      id: "t1",
      handle: "ticket-1",
      subject: "First",
      status: "open",
      priority: "normal",
      unread: true,
      snippet: "Customer needs help",
      contact: { id: "c1", name: "Alice", email: "alice@test.local" },
      assignee: { id: "u1", name: "Bob", avatarUrl: null },
      category: { id: "cat1", name: "Billing" },
      team: "Support EU",
      slaDeadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      firstResponseAt: null,
    },
    t2: {
      id: "t2",
      handle: "ticket-2",
      subject: "Second",
      status: "awaiting_customer",
      priority: "high",
      unread: false,
      team: null,
    },
  } as Record<string, any>,
  selection: {} as Record<string, boolean>,
  loaded: true,
  hasMore: false,
  loading: false,
  params: { smartFilter: "all-open" } as any,
  tabs: [{ id: "tickets:inbox", type: "tickets:inbox", routePath: "/tickets?filter=all-open" }],
  activeTabId: "tickets:inbox",
  loadTickets: vi.fn(),
  setListParams: vi.fn(),
  toggleSelection: vi.fn((id: string) => {
    state.selection[id] = !state.selection[id]
    if (!state.selection[id]) delete state.selection[id]
  }),
  clearSelection: vi.fn(),
  selectedIds: vi.fn(() => Object.keys(state.selection)),
  openTab: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/shell/WsContext", () => ({ useWs: () => state.ws }))
vi.mock("~/modules/tickets/ticket-inbox-store", () => ({
  loadInboxes: state.loadInboxes,
  ticketInboxStore: {
    get inboxes() {
      return state.inboxes
    },
    get loaded() {
      return state.inboxesLoaded
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
      return state.tabs
    },
    get activeTabId() {
      return state.activeTabId
    },
  },
}))
vi.mock("~/modules/tickets/ticket-list-store", () => ({
  loadTickets: state.loadTickets,
  paramsFromRoutePath: (routePath?: string) => {
    const filter = routePath?.includes("follow-ups") ? "follow-ups" : "all-open"
    return { smartFilter: filter }
  },
  searchOverridesView: () => false,
  filterRoutePath: (filter: string) => `/tickets?filter=${filter}`,
  paramsForSmartFilter: (filter: string) => ({ smartFilter: filter }),
  refreshFilterCounts: vi.fn(),
  ticketFilterCountStore: { countByFilter: {} },
  setListParams: state.setListParams,
  setReloadHook: vi.fn(),
  setStatusFilter: vi.fn(),
  setPriorityFilter: vi.fn(),
  setInboxFilter: vi.fn(),
  setCategoryFilter: vi.fn(),
  setSortMode: vi.fn(),
  toggleSelection: state.toggleSelection,
  clearSelection: state.clearSelection,
  selectedIds: state.selectedIds,
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
      return state.loading
    },
    get loaded() {
      return state.loaded
    },
    get hasMore() {
      return state.hasMore
    },
    get params() {
      return state.params
    },
  },
}))

import { TicketsInbox } from "./TicketsInbox"

describe("TicketsInbox", () => {
  beforeEach(() => {
    state.loadTickets.mockReset()
    state.setListParams.mockReset()
    state.toggleSelection.mockClear()
    state.openTab.mockReset()
    state.clearSelection.mockReset()
    state.loadInboxes.mockReset()
    state.selection = {}
    state.loaded = true
    state.inboxesLoaded = true
    state.params = { smartFilter: "all-open" }
    state.tabs = [
      { id: "tickets:inbox", type: "tickets:inbox", routePath: "/tickets?filter=all-open" },
    ]
  })

  it("tickets-row.checkbox is a glyph in a 44px hit area, not a 44px checkbox", () => {
    // At 820px the tier's touch floor inflated the checkbox ITSELF to a 44px
    // square (index.css listed `input` flatly), four times its desktop size.
    // The control opts out and a label around it carries the finger target.
    render(() => <TicketsInbox />)
    const box = screen.getByTestId("tickets-row-checkbox-t1")
    expect(box.getAttribute("data-touch-dense")).not.toBeNull()
    const hit = box.closest("label")
    expect(hit).not.toBeNull()
    expect(hit!.className).toContain("h-11")
    expect(hit!.className).toContain("w-11")
    // The glyph itself stays a glyph at every tier.
    expect(box.className).not.toContain("h-11")
  })

  it("[SC3] renders rows for each ticket", () => {
    render(() => <TicketsInbox />)
    expect(screen.getByTestId("tickets-list-row-t1")).toBeTruthy()
    expect(screen.getByTestId("tickets-list-row-t2")).toBeTruthy()
    expect(screen.getByTestId("tickets-unread-dot-t1")).toBeTruthy()
    expect(screen.getByTestId("tickets-row-contact-t1").textContent).toContain("Alice")
    expect(screen.getByTestId("tickets-row-snippet-t1").textContent).toContain("Customer")
    expect(screen.getByTestId("tickets-row-status-t1").textContent).toContain("Open")
    expect(screen.getByTestId("tickets-row-priority-t1").textContent).toContain("Normal")
    expect(screen.getByTestId("tickets-row-category-t1").textContent).toContain("Billing")
    expect(screen.getByTestId("tickets-row-assignee-t1").textContent).toContain("Bob")
    expect(screen.getByTestId("tickets-filter-chip-status")).toBeTruthy()
    expect(screen.getByTestId("tickets-filter-chip-priority")).toBeTruthy()
    expect(screen.getByTestId("tickets-filter-chip-inbox")).toBeTruthy()
    expect(screen.getByTestId("tickets-filter-chip-category")).toBeTruthy()
  })

  it("renders every ticket through ResponsiveList as a desktop row plus a phone card", () => {
    render(() => <TicketsInbox />)
    const row = screen.getByTestId("tickets-list-row-t1").closest("[data-responsive=row]")
    expect(row).toBeTruthy()
    expect(row?.className).toContain("md:table-row")
    const card = screen.getByTestId("tickets-card-t1").closest("[data-responsive=card]")
    expect(card).toBeTruthy()
    expect(card?.className).toContain("md:hidden")
  })

  it("anchors the phone card on the ticket subject", () => {
    render(() => <TicketsInbox />)
    const card = screen.getByTestId("tickets-card-t1")
    expect(card.textContent).toContain("First")
    expect(screen.getByTestId("tickets-card-subject-t1").textContent).toContain("First")
  })

  it("puts the walk's detail entry point on the phone card, not only the hidden row", () => {
    render(() => <TicketsInbox />)
    // Both markups exist per item and one of them is hidden by a breakpoint, so
    // the entry point has to be on the card as well: a driver at phone width
    // that finds only the row's copy clicks something nothing can see.
    const entryPoints = document.querySelectorAll('[data-testid="tickets-tab-detail"]')
    expect(entryPoints.length).toBe(2)
    const card = screen.getByTestId("tickets-card-t1")
    expect(card.querySelector('[data-testid="tickets-tab-detail"]')).not.toBeNull()
  })

  it("opens the ticket detail from the phone card too", () => {
    render(() => <TicketsInbox />)
    fireEvent.click(screen.getByTestId("tickets-card-t1"))
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tickets:ticket", entityId: "t1" }),
    )
  })

  it("shows the owning team on the row, and nothing where there is none", () => {
    render(() => <TicketsInbox />)
    // Which desk owns a ticket is the first thing a multi-desk operator needs
    // from a list row, and it was the one routing field the row never showed.
    expect(screen.getByTestId("tickets-row-team-t1").textContent).toContain("Support EU")
    // An untagged ticket gets no badge rather than an empty pill or "No team":
    // a desk that uses no teams would otherwise carry a meaningless chip on
    // every single row.
    expect(screen.queryByTestId("tickets-row-team-t2")).toBeNull()
  })

  it("clicking a row opens the ticket detail tab", () => {
    render(() => <TicketsInbox />)
    fireEvent.click(screen.getByTestId("tickets-list-row-t1"))
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tickets:ticket", entityId: "t1" }),
    )
  })

  it("checkbox click invokes toggleSelection store action", () => {
    render(() => <TicketsInbox />)
    fireEvent.click(screen.getByTestId("tickets-row-checkbox-t1"))
    fireEvent.click(screen.getByTestId("tickets-row-checkbox-t2"))
    expect(state.toggleSelection).toHaveBeenCalledTimes(2)
    expect(state.toggleSelection).toHaveBeenNthCalledWith(1, "t1")
    expect(state.toggleSelection).toHaveBeenNthCalledWith(2, "t2")
  })

  it("no inline 'Merge | Clear' toolbar exists; BulkActionToolbar takes over selection UI", () => {
    state.selection = { t1: true, t2: true }
    state.selectedIds.mockImplementation(() => Object.keys(state.selection))
    render(() => <TicketsInbox />)
    expect(screen.queryByTestId("tickets-multiselect-toolbar")).toBeNull()
    expect(screen.queryByTestId("tickets-merge-button")).toBeNull()
    // "Move to inbox…" is likewise not an inline TicketsInbox-owned control —
    // it is the manifest-driven `bulk.move` action rendered by
    // BulkActionToolbar (see BulkActionToolbar.test.tsx), consistent with
    // how merge/assign/close are dispatched.
    expect(screen.queryByTestId("tickets-bulk-move-bar")).toBeNull()
  })

  it("typing in search calls setListParams + loadTickets with the query", () => {
    render(() => <TicketsInbox />)
    const input = screen.getByTestId("tickets-search-input") as HTMLInputElement
    fireEvent.input(input, { target: { value: "alpha" } })
    expect(state.setListParams).toHaveBeenCalledWith(expect.objectContaining({ query: "alpha" }))
    expect(state.loadTickets).toHaveBeenCalled()
  })

  it("initializes list params from the active inbox tab URL", () => {
    state.tabs = [
      { id: "tickets:inbox", type: "tickets:inbox", routePath: "/tickets?filter=follow-ups" },
    ]
    render(() => <TicketsInbox />)
    expect(state.setListParams).toHaveBeenCalledWith(
      expect.objectContaining({ smartFilter: "follow-ups" }),
    )
    expect(state.loadTickets).toHaveBeenCalled()
  })

  it("loads the inbox list on mount so the Move-to-inbox bulk form has options", () => {
    state.inboxesLoaded = false
    render(() => <TicketsInbox />)
    expect(state.loadInboxes).toHaveBeenCalledWith(state.api)
  })

  it("does not reload inboxes on mount when already loaded", () => {
    state.inboxesLoaded = true
    render(() => <TicketsInbox />)
    expect(state.loadInboxes).not.toHaveBeenCalled()
  })
})

// At 820 px the ticket rows cut the preview mid-word at the window edge and the
// timestamp scrolled out of sight: `truncate` on a flex item does nothing while
// the item still has `min-width: auto`, so the row grew past its container and
// the list's `overflow-y-auto` turned into a horizontal scroller.
describe("TicketsInbox: a row shrinks instead of overflowing", () => {
  it("lets the subject, the contact and the preview shrink so the row never overflows", () => {
    render(() => <TicketsInbox />)
    // `min-w-0` is what makes the ellipsis actually engage.
    expect(screen.getByTestId("tickets-row-subject-t1").className).toContain("min-w-0")
    expect(screen.getByTestId("tickets-row-subject-t1").className).toContain("truncate")
    expect(screen.getByTestId("tickets-row-snippet-t1").className).toContain("min-w-0")
    expect(screen.getByTestId("tickets-row-snippet-t1").className).toContain("truncate")
    // The contact is bounded rather than unbounded, so a long address cannot
    // push the preview out of the row.
    const contact = screen.getByTestId("tickets-row-contact-t1")
    expect(contact.className).toContain("truncate")
    expect(contact.className).toContain("max-w-[16rem]")
    // Both text lines can shrink: a flex row that cannot is the whole bug.
    expect((contact.parentElement as HTMLElement).className).toContain("min-w-0")
    expect(
      (screen.getByTestId("tickets-row-subject-t1").parentElement as HTMLElement).className,
    ).toContain("min-w-0")
  })

  it("keeps the timestamp in the row, never pushed off the end", () => {
    render(() => <TicketsInbox />)
    const received = screen.getByTestId("tickets-row-received-t1")
    // The right-hand block never shrinks; the body beside it is what gives way.
    expect((received.parentElement as HTMLElement).className).toContain("shrink-0")
    const body = screen.getByTestId("tickets-row-subject-t1").closest(".flex-1") as HTMLElement
    expect(body.className).toContain("min-w-0")
  })
})

// F6. The 584ad15d pass asserted classes on the row's own children, and every
// one of them was already right: `min-w-0` and `truncate` cannot engage while
// the table CELL around them is sized by its content. Measured at 820px the row
// came out 2633px wide with the timestamp at x=2621; with the list laid out
// fixed the row is 820px, the timestamp ends at 808px and the preview
// truncates inside its track.
describe("TicketsInbox at tablet width", () => {
  it("lays its list out fixed, so the row cannot outgrow the window", () => {
    const { container } = render(() => <TicketsInbox />)
    const list = container.querySelector('[data-responsive="list"]') as HTMLElement
    expect(list.className).toContain("md:table-fixed")
  })

  it("keeps the row checkbox a 22px glyph inside a 44px target", () => {
    render(() => <TicketsInbox />)
    const box = screen.getByTestId("tickets-row-checkbox-t1")
    // Opted out of the tier's 44px floor: a 44px checkbox is not a target, it
    // is a 44px checkbox. The floor lives on the label around it.
    expect(box.hasAttribute("data-touch-dense")).toBe(true)
    expect(box.className).toContain("h-[22px]")
    expect(box.className).toContain("w-[22px]")
    const hit = screen.getByTestId("tickets-row-checkbox-hit-t1")
    expect(hit.className).toContain("h-11")
    expect(hit.className).toContain("w-11")
  })
})
