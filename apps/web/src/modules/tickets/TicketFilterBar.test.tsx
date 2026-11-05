// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn() } as any,
  inboxes: [
    { id: "ibx1", name: "Support", archivedAt: null },
    { id: "ibx2", name: "Bug reports", archivedAt: null },
    { id: "ibx3", name: "Archived", archivedAt: "2026-01-01T00:00:00Z" },
  ],
  inboxesLoaded: true,
  categories: [
    { id: "cat1", name: "Shipping", archivedAt: null },
    { id: "cat2", name: "Billing", archivedAt: null },
  ],
  categoriesLoaded: true,
  // Teams are free text with no id, so the label IS the key. The leading-space
  // entry is not a typo in this fixture: it is what a real desk looks like, and
  // the menu has to stay usable when one exists.
  teams: [
    { team: "Support EU", openCount: 4, totalCount: 9 },
    { team: " Support US", openCount: 0, totalCount: 2 },
  ],
  teamsLoaded: true,
  params: { smartFilter: "all-open" } as any,
  loadInboxes: vi.fn(),
  loadCategories: vi.fn(),
  loadTeams: vi.fn(),
  setStatusFilter: vi.fn(),
  setPriorityFilter: vi.fn(),
  setInboxFilter: vi.fn(),
  setCategoryFilter: vi.fn(),
  setTeamFilter: vi.fn(),
  setAudienceFilter: vi.fn(),
  setSortMode: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
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
  loadCategories: state.loadCategories,
  ticketCategoryStore: {
    get categories() {
      return state.categories
    },
    get loaded() {
      return state.categoriesLoaded
    },
  },
}))
vi.mock("~/modules/tickets/ticket-team-store", () => ({
  loadTeams: state.loadTeams,
  ticketTeamStore: {
    get teams() {
      return state.teams
    },
    get loaded() {
      return state.teamsLoaded
    },
  },
}))
vi.mock("~/modules/tickets/ticket-list-store", () => ({
  // The bar only reads ticketListStore.params + calls the setters (mocked here).
  setStatusFilter: state.setStatusFilter,
  setPriorityFilter: state.setPriorityFilter,
  setInboxFilter: state.setInboxFilter,
  setCategoryFilter: state.setCategoryFilter,
  setTeamFilter: state.setTeamFilter,
  setAudienceFilter: state.setAudienceFilter,
  setSortMode: state.setSortMode,
  ticketListStore: {
    get params() {
      return state.params
    },
  },
}))

// Flatten PopupMenu for unit tests: render the trigger and the content inline
// (no portal, no Kobalte focus traps) so fireEvent.click works and every option
// is in the DOM without opening the menu. Mirrors TicketDetail.test.tsx.
vi.mock("~/ui/PopupMenu", () => {
  const Root = (props: any) => <>{props.children}</>
  const Trigger = (props: any) => <>{props.children}</>
  const Content = (props: any) => <div role="menu">{props.children}</div>
  const Group = (props: any) => <>{props.children}</>
  const Item = (props: any) => (
    <div
      role="menuitem"
      tabindex="0"
      onClick={() => props.onSelect?.()}
      onKeyDown={(e: any) => {
        if (e.key === "Enter" || e.key === " ") props.onSelect?.()
      }}
    >
      {props.children}
    </div>
  )
  const Label = (props: any) => <div>{props.children}</div>
  const Separator = () => <hr />
  const PopupMenu = Object.assign(Root, { Trigger, Content, Group, Item, Label, Separator })
  return { PopupMenu }
})

import { TicketFilterBar } from "./TicketFilterBar"

describe("TicketFilterBar", () => {
  beforeEach(() => {
    state.setStatusFilter.mockReset()
    state.setPriorityFilter.mockReset()
    state.setInboxFilter.mockReset()
    state.setCategoryFilter.mockReset()
    state.setTeamFilter.mockReset()
    state.setAudienceFilter.mockReset()
    state.setSortMode.mockReset()
    state.loadInboxes.mockReset()
    state.loadCategories.mockReset()
    state.loadTeams.mockReset()
    state.params = { smartFilter: "all-open" }
    state.inboxesLoaded = true
    state.categoriesLoaded = true
    state.teamsLoaded = true
    state.teams = [
      { team: "Support EU", openCount: 4, totalCount: 9 },
      { team: " Support US", openCount: 0, totalCount: 2 },
    ]
  })

  it("renders the seven filter/sort controls", () => {
    render(() => <TicketFilterBar />)
    expect(screen.getByTestId("tickets-filter-chip-status")).toBeTruthy()
    expect(screen.getByTestId("tickets-filter-chip-priority")).toBeTruthy()
    expect(screen.getByTestId("tickets-filter-chip-inbox")).toBeTruthy()
    expect(screen.getByTestId("tickets-filter-chip-team")).toBeTruthy()
    expect(screen.getByTestId("tickets-filter-chip-audience")).toBeTruthy()
    expect(screen.getByTestId("tickets-filter-chip-category")).toBeTruthy()
    expect(screen.getByTestId("tickets-filter-chip-sort")).toBeTruthy()
  })

  it("loads inboxes, categories and teams on mount when not already loaded", () => {
    state.inboxesLoaded = false
    state.categoriesLoaded = false
    state.teamsLoaded = false
    render(() => <TicketFilterBar />)
    expect(state.loadInboxes).toHaveBeenCalledWith(state.api)
    expect(state.loadCategories).toHaveBeenCalledWith(state.api)
    expect(state.loadTeams).toHaveBeenCalledWith(state.api)
  })

  it("unchecking a status narrows to the remaining in-scope statuses", () => {
    render(() => <TicketFilterBar />)
    // all-open shows open + awaiting_customer + awaiting_followup checked; clicking
    // "open" toggles it OFF, leaving the other two.
    fireEvent.click(screen.getByTestId("tickets-filter-status-option-open"))
    expect(state.setStatusFilter).toHaveBeenCalledWith(state.api, [
      "awaiting_customer",
      "awaiting_followup",
    ])
  })

  it("only offers in-scope statuses for the active view (closed => closed only)", () => {
    state.params = { smartFilter: "closed" }
    render(() => <TicketFilterBar />)
    expect(screen.getByTestId("tickets-filter-status-option-closed")).toBeTruthy()
    expect(screen.queryByTestId("tickets-filter-status-option-open")).toBeNull()
  })

  it("selecting a priority sets that priority filter", () => {
    render(() => <TicketFilterBar />)
    fireEvent.click(screen.getByTestId("tickets-filter-priority-option-urgent"))
    expect(state.setPriorityFilter).toHaveBeenCalledWith(state.api, ["urgent"])
  })

  it("adds to the existing priority selection", () => {
    state.params = { smartFilter: "all-open", priority: ["high"] }
    render(() => <TicketFilterBar />)
    fireEvent.click(screen.getByTestId("tickets-filter-priority-option-urgent"))
    expect(state.setPriorityFilter).toHaveBeenCalledWith(state.api, ["high", "urgent"])
  })

  it("picking an inbox scopes to it; only non-archived inboxes are offered", () => {
    render(() => <TicketFilterBar />)
    expect(screen.queryByTestId("tickets-filter-inbox-option-ibx3")).toBeNull()
    fireEvent.click(screen.getByTestId("tickets-filter-inbox-option-ibx1"))
    expect(state.setInboxFilter).toHaveBeenCalledWith(state.api, "ibx1")
  })

  it("choosing All inboxes clears the inbox filter", () => {
    state.params = { smartFilter: "all-open", sourceInboxId: "ibx1" }
    render(() => <TicketFilterBar />)
    fireEvent.click(screen.getByTestId("tickets-filter-inbox-option-all"))
    expect(state.setInboxFilter).toHaveBeenCalledWith(state.api, null)
  })

  it("picking a team scopes to it, passing the label VERBATIM", () => {
    render(() => <TicketFilterBar />)
    fireEvent.click(screen.getByTestId("tickets-filter-team-option-Support EU"))
    expect(state.setTeamFilter).toHaveBeenCalledWith(state.api, "Support EU")
  })

  it("passes a label with a leading space through untouched — trimming it would match nothing", () => {
    render(() => <TicketFilterBar />)
    fireEvent.click(screen.getByTestId("tickets-filter-team-option- Support US"))
    expect(state.setTeamFilter).toHaveBeenCalledWith(state.api, " Support US")
  })

  it("choosing All teams clears the team filter", () => {
    state.params = { smartFilter: "all-open", team: ["Support EU"] }
    render(() => <TicketFilterBar />)
    fireEvent.click(screen.getByTestId("tickets-filter-team-option-all"))
    expect(state.setTeamFilter).toHaveBeenCalledWith(state.api, null)
  })

  it("the chip names the active team, and reads 'Team' when none is set", () => {
    render(() => <TicketFilterBar />)
    expect(screen.getByTestId("tickets-filter-chip-team").textContent).toContain("Team")
    state.params = { smartFilter: "all-open", team: ["Support EU"] }
    render(() => <TicketFilterBar />)
    expect(
      screen
        .getAllByTestId("tickets-filter-chip-team")
        .some((c) => (c.textContent ?? "").includes("Support EU")),
    ).toBe(true)
  })

  it("shows each team's live count, so an empty desk is visible before clicking it", () => {
    render(() => <TicketFilterBar />)
    const option = screen.getByTestId("tickets-filter-team-option-Support EU")
    expect(option.textContent).toContain("4")
  })

  it("hides the team control entirely on a desk that uses no teams", () => {
    // An org with no team labels must not carry a permanently empty menu.
    state.teams = []
    render(() => <TicketFilterBar />)
    expect(screen.queryByTestId("tickets-filter-chip-team")).toBeNull()
  })

  it("picking an audience scopes to it", () => {
    render(() => <TicketFilterBar />)
    fireEvent.click(screen.getByTestId("tickets-filter-audience-option-b2b"))
    expect(state.setAudienceFilter).toHaveBeenCalledWith(state.api, "b2b")
  })

  it("the audience chip is ALWAYS shown, unlike Team", () => {
    // Team hides itself on a desk with no teams because the set is discovered.
    // Audience is a closed set of two that exists for every desk, so the chip
    // is how an operator learns the split is available at all.
    state.teams = []
    render(() => <TicketFilterBar />)
    expect(screen.queryByTestId("tickets-filter-chip-team")).toBeNull()
    expect(screen.getByTestId("tickets-filter-chip-audience")).toBeTruthy()
  })

  it("offers exactly two audiences and nothing else", () => {
    render(() => <TicketFilterBar />)
    expect(screen.getByTestId("tickets-filter-audience-option-b2b")).toBeTruthy()
    expect(screen.getByTestId("tickets-filter-audience-option-b2c")).toBeTruthy()
    expect(screen.queryByTestId("tickets-filter-audience-option-B2B")).toBeNull()
  })

  it("picking a category filters by it", () => {
    render(() => <TicketFilterBar />)
    fireEvent.click(screen.getByTestId("tickets-filter-category-option-cat1"))
    expect(state.setCategoryFilter).toHaveBeenCalledWith(state.api, "cat1")
  })

  it("the sort toggle shows newest-first and flips to oldest-first on click", () => {
    state.params = { smartFilter: "all-open", sort: "activity_newest" }
    render(() => <TicketFilterBar />)
    const toggle = screen.getByTestId("tickets-filter-chip-sort")
    expect(toggle.textContent).toContain("Newest first")
    fireEvent.click(toggle)
    expect(state.setSortMode).toHaveBeenCalledWith(state.api, "activity_oldest")
  })

  it("the sort toggle shows oldest-first (e.g. Needs attention) and flips to newest-first", () => {
    state.params = { smartFilter: "needs-attention", sort: "activity_oldest" }
    render(() => <TicketFilterBar />)
    const toggle = screen.getByTestId("tickets-filter-chip-sort")
    expect(toggle.textContent).toContain("Oldest first")
    fireEvent.click(toggle)
    expect(state.setSortMode).toHaveBeenCalledWith(state.api, "activity_newest")
  })
})
