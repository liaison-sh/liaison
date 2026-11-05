// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Search at phone width (M2-3 T19): a large title, phone gutters, and a result
// row that leads with the entity's own mark so the kind is read before the
// text is.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(async () => ({})) },
  store: {
    query: "policy",
    hits: [] as any[],
    total: 0,
    offset: 0,
    limit: 20,
    loading: false,
    unavailable: false,
    filters: {} as Record<string, string[]>,
  },
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))
vi.mock("~/modules/shell/entity-opener", () => ({ openEntity: vi.fn() }))
vi.mock("~/modules/search/search-store", () => ({
  searchStore: mocks.store,
  clearFilters: vi.fn(),
  initFromUrlQuery: vi.fn(),
  setOffset: vi.fn(),
  setQuery: vi.fn(),
  toggleAppFilter: vi.fn(),
  toggleEntityTypeFilter: vi.fn(),
}))

import SearchTab, { entityIcon } from "~/modules/search/SearchTab"
import { setShellTier } from "~/tests/helpers/shell-tier"

function hit(over: Record<string, unknown>) {
  return {
    id: "h1",
    entity_id: "h1",
    app: "knowledge",
    entity_type: "document",
    title: "Return policy",
    body: "Refunds within 30 days",
    updated_at: new Date().toISOString(),
    ...over,
  }
}

describe("Search at phone width", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.store.query = "policy"
    mocks.store.hits = [hit({})]
    mocks.store.total = 1
    mocks.store.filters = {}
  })

  afterEach(() => {
    cleanup()
    setShellTier("desktop")
  })

  it("owns a large title at phone and leaves the desktop tab without one", () => {
    setShellTier("phone")
    render(() => <SearchTab entityId="search" />)
    expect(screen.getByTestId("search-title")).toHaveTextContent("Search")
    expect(screen.getByTestId("search-input")).toBeInTheDocument()
    cleanup()

    setShellTier("desktop")
    render(() => <SearchTab entityId="search" />)
    expect(screen.queryByTestId("search-title")).toBeNull()
  })

  it("uses the phone gutters instead of the 720px column", () => {
    setShellTier("phone")
    render(() => <SearchTab entityId="search" />)
    // Computed from the classes the component actually renders: a class-name
    // substring is inert in jsdom and passes even when the real padding or the
    // reading column has drifted.
    const style = document.createElement("style")
    style.textContent =
      ".px-4 { padding-left: 16px; padding-right: 16px; }\n" +
      ".px-6 { padding-left: 24px; padding-right: 24px; }\n" +
      ".max-w-\\[720px\\] { max-width: 720px; }"
    document.head.appendChild(style)

    const tab = screen.getByTestId("search-tab")
    expect(getComputedStyle(tab).paddingLeft).toBe("16px")
    expect(getComputedStyle(tab).maxWidth).not.toBe("720px")
    cleanup()

    // The desktop tab keeps its 720px reading column, which is the other half
    // of the same assertion.
    setShellTier("desktop")
    render(() => <SearchTab entityId="search" />)
    expect(getComputedStyle(screen.getByTestId("search-tab")).maxWidth).toBe("720px")
    style.remove()
  })

  it("draws a mark for every entity kind a result can be", () => {
    const kinds = ["thread", "message", "conversation", "ticket", "contact", "event", "document"]
    for (const kind of kinds) expect(entityIcon(kind)).toBeTruthy()
    // An unknown kind still gets a mark rather than an empty cell.
    expect(entityIcon("something-new")).toBe(entityIcon("document"))
  })

  it("renders a row with its icon, title and snippet for each entity kind", () => {
    mocks.store.hits = [
      hit({
        id: "t1",
        entity_id: "t1",
        app: "tickets",
        entity_type: "ticket",
        title: "Broken pad",
      }),
      hit({
        id: "c1",
        entity_id: "c1",
        app: "kernel",
        entity_type: "contact",
        title: "Alice Chen",
      }),
      hit({ id: "d1", entity_id: "d1" }),
    ]
    mocks.store.total = 3
    setShellTier("phone")
    render(() => <SearchTab entityId="search" />)
    expect(screen.getByTestId("search-result-tickets-ticket-t1")).toHaveTextContent("Broken pad")
    expect(screen.getByTestId("search-result-kernel-contact-c1")).toHaveTextContent("Alice Chen")
    expect(screen.getByTestId("search-result-knowledge-document-d1")).toHaveTextContent(
      "Refunds within 30 days",
    )
    expect(document.querySelectorAll("[data-testid^='search-result-icon-']").length).toBe(3)
  })

  it("keeps the entity type filter chips", () => {
    setShellTier("phone")
    render(() => <SearchTab entityId="search" />)
    expect(screen.getByTestId("search-filter-chips")).toBeInTheDocument()
    expect(screen.getByTestId("search-chip-type-document")).toBeInTheDocument()
  })
})
