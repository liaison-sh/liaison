// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

const alice = {
  id: "c1",
  handle: "@c1",
  name: "Alice",
  email: "a@x.com",
  phone: null,
  company: "Acme",
  externalIds: {},
  metadata: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}
const bob = {
  id: "c2",
  handle: "@c2",
  name: "Bob",
  email: "b@x.com",
  phone: null,
  company: "Beta",
  externalIds: {},
  metadata: null,
  createdAt: "2026-01-02T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
}

describe("contact-list-store", () => {
  beforeEach(() => vi.resetModules())

  it("loadContacts populates byId/ids and total via getEnvelope", async () => {
    const api = {
      getEnvelope: vi
        .fn()
        .mockResolvedValue({ data: [alice], meta: { page: 1, limit: 50, total: 1 } }),
    }
    const { contactListStore, hasMore, loadContacts, total } = await import("./contact-list-store")

    await loadContacts(api as any)

    expect(api.getEnvelope).toHaveBeenCalledWith("/contacts?page=1&limit=50")
    expect(contactListStore.ids).toEqual(["c1"])
    expect(contactListStore.byId.c1).toEqual(alice)
    expect(total()).toBe(1)
    expect(hasMore()).toBe(false)
  })

  it("setQuery resets page to 1 and triggers a reload with the query", async () => {
    const api = {
      getEnvelope: vi.fn().mockResolvedValue({ data: [], meta: { total: 0, page: 1, limit: 50 } }),
    }
    const { loadContacts, setQuery } = await import("./contact-list-store")

    setQuery("Alice")
    await loadContacts(api as any)

    expect(api.getEnvelope).toHaveBeenCalledWith("/contacts?query=Alice&page=1&limit=50")
  })

  it("loadMoreContacts appends ids and increments page", async () => {
    const api = {
      getEnvelope: vi
        .fn()
        .mockResolvedValueOnce({ data: [alice], meta: { total: 2, page: 1, limit: 1 } })
        .mockResolvedValueOnce({ data: [bob], meta: { total: 2, page: 2, limit: 1 } }),
    }
    const { contactListStore, loadContacts, loadMoreContacts, page } = await import(
      "./contact-list-store"
    )

    await loadContacts(api as any, 1)
    await loadMoreContacts(api as any, 1)

    expect(api.getEnvelope).toHaveBeenLastCalledWith("/contacts?page=2&limit=1")
    expect(contactListStore.ids).toEqual(["c1", "c2"])
    expect(page()).toBe(2)
  })

  it("handleContactEvent create/update/delete keeps list state in sync", async () => {
    const { contactListStore, handleContactEvent, total } = await import("./contact-list-store")

    handleContactEvent("create", alice)
    expect(contactListStore.ids).toEqual(["c1"])
    expect(total()).toBe(1)

    handleContactEvent("update", { id: "c1", company: "New Co" })
    expect(contactListStore.byId.c1.company).toBe("New Co")

    handleContactEvent("delete", { id: "c1" })
    expect(contactListStore.ids).toEqual([])
    expect(contactListStore.byId.c1).toBeUndefined()
    expect(total()).toBe(0)
  })

  it("setGroupFilter scopes the list to one contact group and back (S15)", async () => {
    const api = {
      getEnvelope: vi.fn().mockResolvedValue({ data: [], meta: { total: 0, page: 1, limit: 50 } }),
    }
    const { groupFilter, loadContacts, resetContactListStore, setGroupFilter } = await import(
      "./contact-list-store"
    )

    setGroupFilter("g-1")
    await loadContacts(api as any)
    expect(api.getEnvelope).toHaveBeenLastCalledWith("/contacts?groupId=g-1&page=1&limit=50")
    expect(groupFilter()).toBe("g-1")

    setGroupFilter(null)
    await loadContacts(api as any)
    expect(api.getEnvelope).toHaveBeenLastCalledWith("/contacts?page=1&limit=50")

    setGroupFilter("g-2")
    resetContactListStore()
    expect(groupFilter()).toBeNull()
  })
})
