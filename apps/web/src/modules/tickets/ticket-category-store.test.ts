// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("ticket-category-store", () => {
  beforeEach(() => vi.resetModules())

  it("loadCategories populates store via tickets:categories.list", async () => {
    const post = vi.fn().mockResolvedValue([
      { id: "c1", parentId: null, name: "Bugs", sortOrder: 0, archivedAt: null },
      { id: "c2", parentId: "c1", name: "Critical", sortOrder: 0, archivedAt: null },
    ])
    const api = { post } as any
    const { loadCategories, ticketCategoryStore } = await import(
      "~/modules/tickets/ticket-category-store"
    )
    await loadCategories(api)
    expect(ticketCategoryStore.categories).toHaveLength(2)
    expect(ticketCategoryStore.loaded).toBe(true)
  })

  it("handleCategoryEvent supports create / update / archive", async () => {
    const { handleCategoryEvent, ticketCategoryStore, resetTicketCategoryStore } = await import(
      "~/modules/tickets/ticket-category-store"
    )
    resetTicketCategoryStore()
    handleCategoryEvent("create", {
      id: "n1",
      parentId: null,
      name: "New",
      sortOrder: 0,
      archivedAt: null,
    })
    expect(ticketCategoryStore.categories.some((c) => c.id === "n1")).toBe(true)
    handleCategoryEvent("update", { id: "n1", changes: { name: "Renamed" } })
    expect(ticketCategoryStore.categories.find((c) => c.id === "n1")?.name).toBe("Renamed")
    handleCategoryEvent("archive", { id: "n1" })
    expect(ticketCategoryStore.categories.find((c) => c.id === "n1")?.archivedAt).toBeTruthy()
  })

  // Walk 2026-09-22: the real categories.list row is snake_case. Unmapped, every
  // child rendered as a root (three "Achat non comptabilisé" roots, one per
  // escalation level) and the archived probe category reappeared.
  it("maps the snake_case wire row (parent_id / archived_at / sort_order) onto the store shape", async () => {
    const post = vi.fn().mockResolvedValue([
      { id: "l1", parent_id: null, name: "L1", sort_order: 0, archived_at: null, created_at: "x" },
      { id: "l2", parent_id: null, name: "L2", sort_order: 1, archived_at: null, created_at: "x" },
      {
        id: "a1",
        parent_id: "l1",
        name: "Achat non comptabilisé",
        sort_order: 0,
        archived_at: null,
      },
      {
        id: "a2",
        parent_id: "l2",
        name: "Achat non comptabilisé",
        sort_order: 0,
        archived_at: null,
      },
      {
        id: "p",
        parent_id: null,
        name: "__CAT_PROBE__",
        sort_order: 0,
        archived_at: "2026-07-06T09:00:00Z",
      },
    ])
    const { loadCategories, ticketCategoryStore } = await import(
      "~/modules/tickets/ticket-category-store"
    )
    await loadCategories({ post } as any)
    const cats = ticketCategoryStore.categories
    const roots = cats.filter((c) => !c.archivedAt && !c.parentId).map((c) => c.name)
    expect(roots).toEqual(["L1", "L2"])
    expect(cats.find((c) => c.id === "a2")?.parentId).toBe("l2")
    expect(cats.find((c) => c.id === "l2")?.sortOrder).toBe(1)
    expect(cats.find((c) => c.id === "p")?.archivedAt).toBeTruthy()
  })

  it("an update event in either spelling keeps the other fields", async () => {
    const { handleCategoryEvent, ticketCategoryStore, resetTicketCategoryStore } = await import(
      "~/modules/tickets/ticket-category-store"
    )
    resetTicketCategoryStore()
    handleCategoryEvent("create", {
      id: "c",
      parent_id: "l1",
      name: "X",
      sort_order: 2,
      archived_at: null,
    })
    handleCategoryEvent("update", { id: "c", changes: { name: "Y" } })
    const c = ticketCategoryStore.categories.find((x) => x.id === "c")!
    expect(c).toEqual({ id: "c", parentId: "l1", name: "Y", sortOrder: 2, archivedAt: null })
    handleCategoryEvent("update", { id: "c", changes: { parent_id: null } })
    expect(ticketCategoryStore.categories.find((x) => x.id === "c")?.parentId).toBeNull()
  })
})
