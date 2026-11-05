// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"
import { archiveProject, restoreProject } from "~/modules/projects/project-archive"
import { projectStore } from "~/modules/projects/project-store"
import { projectsStore } from "~/modules/projects/projects-store"

const summary = {
  id: "p1",
  name: "Alpha",
  description: null,
  icon: null,
  color: null,
  ownerId: "u1",
  taskCount: 3,
  archivedAt: null,
  updatedAt: "2026-05-06T00:00:00Z",
}
const detail = {
  id: "p1",
  name: "Alpha",
  description: null,
  icon: null,
  color: null,
  ownerId: "u1",
  archivedAt: null as string | null,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-06T00:00:00Z",
  statuses: [],
}

describe("project archive", () => {
  afterEach(() => {
    projectsStore._setForTest({ items: [], loaded: false, archived: [], archivedLoaded: false })
    projectStore._resetForTest()
  })

  it("archive posts to the archive route and the project leaves the active list", async () => {
    projectsStore._setForTest({ items: [{ ...summary }], loaded: true })
    projectStore._setForTest({ current: { ...detail }, projectId: "p1" })
    const post = vi.fn().mockResolvedValue({ ...detail, archivedAt: "2026-09-23T08:00:00Z" })

    await archiveProject({ post } as any, "p1")

    expect(post).toHaveBeenCalledWith("/projects/p1/archive")
    expect(projectsStore.items.filter((p) => !p.archivedAt)).toEqual([])
    expect(projectStore.project("p1")?.archivedAt).toBe("2026-09-23T08:00:00Z")
  })

  it("restore posts to the restore route and brings a project back that the list never had", async () => {
    projectsStore._setForTest({ items: [], loaded: true })
    projectStore._setForTest({
      current: { ...detail, archivedAt: "2026-09-01T00:00:00Z" },
      projectId: "p1",
    })
    const post = vi.fn().mockResolvedValue(detail)

    await restoreProject({ post } as any, "p1")

    expect(post).toHaveBeenCalledWith("/projects/p1/restore")
    expect(projectsStore.byId("p1")).toMatchObject({ name: "Alpha", archivedAt: null })
    expect(projectStore.project("p1")?.archivedAt).toBeNull()
  })

  it("a failed archive leaves the stores untouched", async () => {
    projectsStore._setForTest({ items: [{ ...summary }], loaded: true })
    const post = vi.fn().mockRejectedValue(new Error("403"))
    await expect(archiveProject({ post } as any, "p1")).rejects.toThrow("403")
    expect(projectsStore.byId("p1")?.archivedAt).toBeNull()
  })
})
