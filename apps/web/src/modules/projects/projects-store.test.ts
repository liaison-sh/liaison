// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import { projectsStore } from "~/modules/projects/projects-store"

describe("projects-store", () => {
  it("loads projects from /projects", async () => {
    const get = vi.fn().mockResolvedValue({
      items: [
        {
          id: "p1",
          name: "Alpha",
          description: null,
          icon: null,
          color: null,
          ownerId: "u1",
          taskCount: 3,
          archivedAt: null,
          updatedAt: "2026-05-06T00:00:00Z",
        },
      ],
    })
    const api = { get } as any
    await projectsStore.load(api)
    expect(get).toHaveBeenCalledWith("/projects?limit=100")
    expect(projectsStore.items).toHaveLength(1)
    expect(projectsStore.byId("p1")?.name).toBe("Alpha")
    projectsStore._setForTest({ items: [], loaded: false })
  })

  it("upsert replaces by id", () => {
    projectsStore._setForTest({
      items: [
        {
          id: "p1",
          name: "Alpha",
          description: null,
          icon: null,
          color: null,
          ownerId: "u1",
          taskCount: 0,
          archivedAt: null,
          updatedAt: "2026-05-06T00:00:00Z",
        },
      ],
      loaded: true,
    })
    projectsStore.upsert({
      id: "p1",
      name: "Alpha 2",
      description: null,
      icon: null,
      color: null,
      ownerId: "u1",
      taskCount: 0,
      archivedAt: null,
      updatedAt: "2026-05-06T00:00:00Z",
    })
    expect(projectsStore.items).toHaveLength(1)
    expect(projectsStore.items[0]!.name).toBe("Alpha 2")
    projectsStore._setForTest({ items: [], loaded: false })
  })

  it("follows nextCursor so a project past the first page is not silently dropped", async () => {
    const mk = (id: string) => ({
      id,
      name: id,
      description: null,
      icon: null,
      color: null,
      ownerId: "u1",
      taskCount: 0,
      archivedAt: null,
      updatedAt: "2026-05-06T00:00:00Z",
    })
    const get = vi.fn(async (path: string) =>
      path.includes("cursor=c1")
        ? { items: [mk("p3")], nextCursor: null }
        : { items: [mk("p1"), mk("p2")], nextCursor: "c1" },
    )
    await projectsStore.load({ get } as any)
    expect(get).toHaveBeenNthCalledWith(1, "/projects?limit=100")
    expect(get).toHaveBeenNthCalledWith(2, "/projects?limit=100&cursor=c1")
    expect(projectsStore.items.map((p) => p.id)).toEqual(["p1", "p2", "p3"])
    projectsStore._setForTest({ items: [], loaded: false })
  })

  it("archive and restore move a project between the list and the archived fold", async () => {
    const alpha = {
      id: "p1",
      name: "Alpha",
      description: null,
      icon: null,
      color: null,
      ownerId: "u1",
      taskCount: 4,
      archivedAt: null,
      updatedAt: "2026-05-06T00:00:00Z",
    }
    const old = { ...alpha, id: "p9", name: "Old", archivedAt: "2026-01-01T00:00:00Z" }
    const get = vi.fn().mockResolvedValue({ items: [old], nextCursor: null })
    projectsStore._setForTest({ items: [alpha], loaded: true, archived: [], archivedLoaded: false })

    await projectsStore.loadArchived({ get } as any)
    expect(get).toHaveBeenCalledWith("/projects?limit=100&archived=only")
    expect(projectsStore.archivedItems.map((p) => p.id)).toEqual(["p9"])

    projectsStore.markArchived("p1", "2026-09-23T00:00:00Z")
    expect(projectsStore.byId("p1")?.archivedAt).toBe("2026-09-23T00:00:00Z")
    expect(projectsStore.archivedItems.map((p) => p.id).sort()).toEqual(["p1", "p9"])

    // Restoring one that was only ever in the archived fold brings it back
    // whole (name, task count), not as an empty shell built from the event id.
    projectsStore.markRestored("p9")
    expect(projectsStore.byId("p9")).toMatchObject({ name: "Old", archivedAt: null })
    projectsStore.markRestored("p1")
    expect(projectsStore.byId("p1")).toMatchObject({
      name: "Alpha",
      taskCount: 4,
      archivedAt: null,
    })
    expect(projectsStore.archivedItems).toEqual([])
    projectsStore._setForTest({ items: [], loaded: false, archived: [], archivedLoaded: false })
  })
})
