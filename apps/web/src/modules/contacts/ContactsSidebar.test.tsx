// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Contacts sidebar's Groups section (S15): it lists the organisation's
// contact groups, a click filters the contact list to that group, "All
// contacts" lifts the filter, and a group can be created from it. Real stores,
// a fake API.

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  api: {} as Record<string, any>,
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
  tabStore: { tabs: [], activeTabId: null },
}))
vi.mock("~/framework/app-registry", () => ({ resolveRegisteredTabType: () => undefined }))

const GROUPS = [
  { id: "g-vip", name: "VIP", memberCount: 1 },
  { id: "g-press", name: "Press", memberCount: 0 },
]
const ALICE = { id: "c1", name: "Alice", email: "a@x.com" }
const BOB = { id: "c2", name: "Bob", email: "b@x.com" }

function fakeApi() {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/contacts/groups") return { data: GROUPS }
      throw new Error(`unexpected GET ${path}`)
    }),
    post: vi.fn(async (path: string, body: { name: string }) => {
      if (path === "/contacts/groups")
        return { data: { id: "g-new", name: body.name, memberCount: 0 } }
      throw new Error(`unexpected POST ${path}`)
    }),
    getEnvelope: vi.fn(async (path: string) => {
      const data = path.includes("groupId=g-vip") ? [ALICE] : [ALICE, BOB]
      return { data, meta: { total: data.length, page: 1, limit: 50 } }
    }),
  }
}

// Generous: the whole contacts suite renders in parallel workers.
const until = (fn: () => void) => vi.waitFor(fn, { timeout: 5000 })

async function freshStores() {
  const list = await import("./contact-list-store")
  const groups = await import("./contact-groups-store")
  list.resetContactListStore()
  groups.resetContactGroupsStore()
}

describe("ContactsSidebar: groups", () => {
  beforeEach(async () => {
    mocks.api = fakeApi()
    await freshStores()
  })

  afterEach(() => cleanup())

  it("lists the groups with their member counts", async () => {
    const { ContactsSidebar } = await import("./ContactsSidebar")
    render(() => <ContactsSidebar />)

    await until(() => expect(screen.getByTestId("contacts-sidebar-group-g-vip")).toBeTruthy())
    expect(mocks.api.get).toHaveBeenCalledWith("/contacts/groups")
    expect(screen.getByTestId("contacts-sidebar-group-g-vip").textContent).toContain("VIP")
    expect(screen.getByTestId("contacts-sidebar-group-g-vip").textContent).toContain("1")
    expect(screen.getByTestId("contacts-sidebar-group-g-press").textContent).toContain("Press")
    // No filter yet: "All contacts" is current and the whole list shows.
    expect(screen.getByTestId("contacts-sidebar-group-all").getAttribute("aria-current")).toBe(
      "true",
    )
    await until(() => expect(screen.getByTestId("contacts-sidebar-row-c2")).toBeTruthy())
  })

  it("clicking a group filters the contacts to it, and All contacts lifts the filter", async () => {
    const { ContactsSidebar } = await import("./ContactsSidebar")
    render(() => <ContactsSidebar />)
    await until(() => expect(screen.getByTestId("contacts-sidebar-group-g-vip")).toBeTruthy())
    await until(() => expect(screen.getByTestId("contacts-sidebar-row-c2")).toBeTruthy())

    fireEvent.click(screen.getByTestId("contacts-sidebar-group-g-vip"))
    await until(() =>
      expect(mocks.api.getEnvelope).toHaveBeenLastCalledWith(
        "/contacts?groupId=g-vip&page=1&limit=50",
      ),
    )
    await until(() => expect(screen.queryByTestId("contacts-sidebar-row-c2")).toBeNull())
    expect(screen.getByTestId("contacts-sidebar-row-c1")).toBeTruthy()
    expect(screen.getByTestId("contacts-sidebar-group-g-vip").getAttribute("aria-current")).toBe(
      "true",
    )
    expect(screen.getByTestId("contacts-sidebar-group-all").getAttribute("aria-current")).toBeNull()

    fireEvent.click(screen.getByTestId("contacts-sidebar-group-all"))
    await until(() =>
      expect(mocks.api.getEnvelope).toHaveBeenLastCalledWith("/contacts?page=1&limit=50"),
    )
    await until(() => expect(screen.getByTestId("contacts-sidebar-row-c2")).toBeTruthy())
  })

  it("creates a group from the sidebar and filters to it", async () => {
    const { ContactsSidebar } = await import("./ContactsSidebar")
    render(() => <ContactsSidebar />)
    await until(() => expect(screen.getByTestId("contacts-sidebar-group-g-vip")).toBeTruthy())

    fireEvent.click(screen.getByTestId("contacts-sidebar-new-group"))
    const input = screen.getByTestId("contacts-sidebar-new-group-name") as HTMLInputElement
    fireEvent.input(input, { target: { value: "Trade show" } })
    fireEvent.submit(input.closest("form")!)

    await until(() =>
      expect(mocks.api.post).toHaveBeenCalledWith("/contacts/groups", { name: "Trade show" }),
    )
    await until(() => expect(screen.getByTestId("contacts-sidebar-group-g-new")).toBeTruthy())
    expect(screen.getByTestId("contacts-sidebar-group-g-new").getAttribute("aria-current")).toBe(
      "true",
    )
  })
})

// The Contacts nav entry opens the LIST page, which had no sidebar: groups were reachable only
// from a contact's page. The list page now carries the same Groups section; the list itself is
// the page, so the sidebar shows no second contact list.
describe("ContactListSidebar: groups on the list page", () => {
  beforeEach(async () => {
    mocks.api = fakeApi()
    await freshStores()
  })

  afterEach(() => cleanup())

  it("lists the groups, filters the list on click, and repeats no contact rows", async () => {
    const { ContactListSidebar } = await import("./ContactsSidebar")
    render(() => <ContactListSidebar />)

    await until(() => expect(screen.getByTestId("contacts-sidebar-group-g-vip")).toBeTruthy())
    expect(screen.getByTestId("contacts-sidebar-group-g-vip").textContent).toContain("VIP")
    expect(screen.getByTestId("contacts-sidebar-group-all").getAttribute("aria-current")).toBe(
      "true",
    )

    fireEvent.click(screen.getByTestId("contacts-sidebar-group-g-vip"))
    await until(() =>
      expect(mocks.api.getEnvelope).toHaveBeenLastCalledWith(
        "/contacts?groupId=g-vip&page=1&limit=50",
      ),
    )
    expect(screen.getByTestId("contacts-sidebar-group-g-vip").getAttribute("aria-current")).toBe(
      "true",
    )
    expect(screen.queryByTestId("contacts-sidebar-row-c1")).toBeNull()
    expect(screen.queryByTestId("contacts-sidebar-search")).toBeNull()
  })

  it("is the contact-list page's sidebar in the exports the shell resolves", async () => {
    const exports = await import("./exports")
    expect(exports.ContactListSidebar).toBeDefined()
  })
})
