// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ContactList } from "./ContactList"

const mocks = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  openTab: vi.fn(),
  setQuery: vi.fn(),
  setMode: vi.fn(),
  loadContacts: vi.fn(),
  loadMoreContacts: vi.fn(),
  setGroupFilter: vi.fn(),
  queryValue: "",
  modeValue: "people" as "people" | "all",
  groupFilterValue: null as string | null,
  contactListStore: { byId: {} as Record<string, any>, ids: [] as string[] },
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: mocks.openTab }))
vi.mock("~/modules/shell/entity-preview/EntityPreview", () => ({
  default: (props: any) => (
    <span
      data-testid="entity-preview"
      data-app={props.app}
      data-entity-type={props.entityType}
      data-entity-id={props.entityId}
      data-trigger={props.trigger ?? "click-or-hover"}
    >
      {props.children}
    </span>
  ),
}))
vi.mock("~/modules/contacts/contact-list-store", () => ({
  contactListStore: mocks.contactListStore,
  query: () => mocks.queryValue,
  mode: () => mocks.modeValue,
  groupFilter: () => mocks.groupFilterValue,
  setGroupFilter: mocks.setGroupFilter,
  total: () => mocks.contactListStore.ids.length,
  loading: () => false,
  loadingMore: () => false,
  hasMore: () => false,
  setQuery: mocks.setQuery,
  setMode: mocks.setMode,
  loadContacts: mocks.loadContacts,
  loadMoreContacts: mocks.loadMoreContacts,
}))

describe("ContactList", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.queryValue = ""
    mocks.modeValue = "people"
    mocks.groupFilterValue = null
    mocks.api = {}
    mocks.contactListStore.byId = {}
    mocks.contactListStore.ids = []
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it("debounces search input by 300ms before calling setQuery and loadContacts", async () => {
    render(() => <ContactList entityId="list" />)
    fireEvent.input(screen.getByTestId("contacts-search"), { target: { value: "Hans" } })
    expect(mocks.setQuery).not.toHaveBeenCalled()

    await new Promise((resolve) => setTimeout(resolve, 350))

    expect(mocks.setQuery).toHaveBeenCalledWith("Hans")
    expect(mocks.loadContacts).toHaveBeenCalledWith(mocks.api)
  })

  it("renders rows with name, email, company, and last-contacted timestamp", async () => {
    mocks.contactListStore.byId.c1 = {
      id: "c1",
      name: "Alice",
      email: "a@x.com",
      company: "Acme",
      createdAt: "2026-01-01T00:00:00Z",
      lastContactedAt: "2026-01-01T00:00:00Z",
    }
    mocks.contactListStore.ids = ["c1"]

    render(() => <ContactList entityId="list" />)

    expect(screen.getAllByText("Alice")[0]).toBeInTheDocument()
    expect(screen.getAllByText("a@x.com")[0]).toBeInTheDocument()
    expect(screen.getAllByText("Acme")[0]).toBeInTheDocument()
    // Last-contacted column is rendered (relative time string varies with `now`,
    // so just assert the cell exists and is not the "never" placeholder).
    const cell = screen.getByTestId("contact-row-last-contacted")
    expect(cell.textContent ?? "").not.toMatch(/^never$/i)
  })

  it("renders 'never' for contacts with no recorded mail activity", async () => {
    mocks.contactListStore.byId.c2 = {
      id: "c2",
      name: "Bob",
      email: "b@x.com",
      lastContactedAt: null,
    }
    mocks.contactListStore.ids = ["c2"]

    render(() => <ContactList entityId="list" />)

    expect(screen.getByTestId("contact-row-last-contacted").textContent?.trim()).toBe("never")
  })

  it("clicking a row opens the contact detail tab", async () => {
    mocks.contactListStore.byId.c1 = {
      id: "c1",
      name: "Alice",
      email: "a@x.com",
      company: "Acme",
      createdAt: "2026-01-01T00:00:00Z",
    }
    mocks.contactListStore.ids = ["c1"]

    render(() => <ContactList entityId="list" />)
    fireEvent.click(screen.getByTestId("contact-row-c1"))

    expect(mocks.openTab).toHaveBeenCalledWith({
      type: "contact-detail",
      entityId: "c1",
      label: "Alice",
    })
  })

  it("wraps contact rows with hover-only EntityPreview", async () => {
    mocks.contactListStore.byId.c1 = {
      id: "c1",
      name: "Alice",
      email: "a@x.com",
      company: "Acme",
      createdAt: "2026-01-01T00:00:00Z",
    }
    mocks.contactListStore.ids = ["c1"]

    render(() => <ContactList entityId="list" />)

    const preview = screen.getByTestId("entity-preview")
    expect(preview).toHaveAttribute("data-app", "kernel")
    expect(preview).toHaveAttribute("data-entity-type", "contact")
    expect(preview).toHaveAttribute("data-entity-id", "c1")
    expect(preview).toHaveAttribute("data-trigger", "hover")
  })

  it("renders empty and search-no-match states", async () => {
    const { unmount } = render(() => <ContactList entityId="list" />)
    expect(screen.getByText("No people in your workspace yet.")).toBeInTheDocument()
    unmount()

    mocks.queryValue = "Nope"
    render(() => <ContactList entityId="list" />)
    expect(screen.getByText(/No contacts match/)).toBeInTheDocument()
  })

  it("clicking the All tab calls setMode + reloads", async () => {
    render(() => <ContactList entityId="list" />)
    fireEvent.click(screen.getByTestId("contacts-mode-all"))
    expect(mocks.setMode).toHaveBeenCalledWith("all")
    expect(mocks.loadContacts).toHaveBeenCalledWith(mocks.api)
  })

  it("shows the auto badge in All mode for automated senders", async () => {
    mocks.modeValue = "all"
    mocks.contactListStore.byId.bot1 = {
      id: "bot1",
      name: "Notifications",
      email: "noreply@example.com",
      isAutomated: true,
    }
    mocks.contactListStore.ids = ["bot1"]

    render(() => <ContactList entityId="list" />)

    expect(screen.getByText("auto")).toBeInTheDocument()
  })

  it("shows the active group filter and clears it (S15)", async () => {
    const { resetContactGroupsStore, loadGroups } = await import("./contact-groups-store")
    resetContactGroupsStore()
    await loadGroups({
      get: vi.fn(async () => ({ data: [{ id: "g1", name: "VIP", memberCount: 2 }] })),
    } as any)
    mocks.groupFilterValue = "g1"

    render(() => <ContactList entityId="list" />)

    expect(screen.getByTestId("contacts-group-filter").textContent).toContain("VIP")
    fireEvent.click(screen.getByTestId("contacts-group-filter-clear"))
    expect(mocks.setGroupFilter).toHaveBeenCalledWith(null)
    expect(mocks.loadContacts).toHaveBeenCalledWith(mocks.api)
  })

  it("multi-select: picked contacts are added to a group from the selection bar (S15)", async () => {
    const { resetContactGroupsStore, loadGroups } = await import("./contact-groups-store")
    resetContactGroupsStore()
    const post = vi.fn(async () => ({
      data: { groupId: "g1", groupName: "VIP", changed: 2, unchanged: 0, notFound: [] },
    }))
    mocks.api = {
      get: vi.fn(async () => ({ data: [{ id: "g1", name: "VIP", memberCount: 0 }] })),
      post,
    }
    await loadGroups(mocks.api as any)
    for (const id of ["c1", "c2", "c3"]) {
      mocks.contactListStore.byId[id] = { id, name: id.toUpperCase(), email: `${id}@x.com` }
    }
    mocks.contactListStore.ids = ["c1", "c2", "c3"]

    render(() => <ContactList entityId="list" />)
    expect(screen.queryByTestId("contacts-selection-bar")).toBeNull()

    fireEvent.click(screen.getByTestId("contact-select-c1"))
    fireEvent.click(screen.getByTestId("contact-select-c3"))
    expect(screen.getByTestId("contacts-selection-bar").textContent).toContain("2 selected")

    fireEvent.click(screen.getByTestId("contacts-selection-add-to-group"))
    fireEvent.click(screen.getByTestId("add-to-group-g1"))
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith("/contacts/groups/g1/members", {
        contactIds: ["c1", "c3"],
      }),
    )
    // Done: the selection is cleared.
    await vi.waitFor(() => expect(screen.queryByTestId("contacts-selection-bar")).toBeNull())
  })
})
