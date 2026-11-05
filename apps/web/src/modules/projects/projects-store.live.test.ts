// SPDX-License-Identifier: FSL-1.1-ALv2
// projectsStore.taskCount follows task creation, deletion and moves made by
// anyone: the counts loaded once used to stay frozen until a reload.
import { afterEach, describe, expect, it, vi } from "vitest"
import { EntityChangesTestAccess, notifyEntityChange } from "~/framework/entity-changes"
import { projectsStore, subscribeProjectsResync } from "~/modules/projects/projects-store"

const project = (taskCount: number) => ({
  id: "p1",
  name: "Alpha",
  description: null,
  icon: null,
  color: null,
  ownerId: "u1",
  taskCount,
  archivedAt: null,
  updatedAt: "2026-10-15T00:00:00Z",
})

const taskEvent = (action: string, extra: Record<string, unknown> = {}) => ({
  key: "projects:task",
  app: "projects",
  entity: "task",
  action,
  data: { id: "t1", projectId: "p1", ...extra },
})

describe("projectsStore live task counts", () => {
  afterEach(() => {
    vi.useRealTimers()
    EntityChangesTestAccess.reset()
    projectsStore._setForTest({ items: [], loaded: false })
  })

  // One test: subscribeProjectsResync installs its subscriptions once per session.
  it("created/deleted/cross-project moves refetch once per burst; a field update or a same-project move does not", async () => {
    vi.useFakeTimers()
    let count = 2
    const get = vi.fn(async () => ({ items: [project(count)] }))
    // biome-ignore lint/suspicious/noExplicitAny: minimal ApiClient stub
    await projectsStore.load({ get } as any)
    subscribeProjectsResync()
    expect(projectsStore.byId("p1")?.taskCount).toBe(2)

    notifyEntityChange(taskEvent("updated"))
    // A drag within a project (reorder, status column, bulk status move) moves
    // no task between projects: no count changes.
    notifyEntityChange(taskEvent("moved", { statusId: "s2" }))
    notifyEntityChange(taskEvent("moved", { fromProjectId: "p1" }))
    await vi.advanceTimersByTimeAsync(3500)
    expect(get).toHaveBeenCalledTimes(1)

    count = 4
    notifyEntityChange(taskEvent("created"))
    notifyEntityChange(taskEvent("created"))
    await vi.advanceTimersByTimeAsync(3500)
    expect(get).toHaveBeenCalledTimes(2)
    expect(projectsStore.byId("p1")?.taskCount).toBe(4)

    count = 5
    notifyEntityChange(taskEvent("moved", { fromProjectId: "p2" }))
    await vi.advanceTimersByTimeAsync(3500)
    expect(get).toHaveBeenCalledTimes(3)
    expect(projectsStore.byId("p1")?.taskCount).toBe(5)
  })
})
