// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import { type ProjectDetail, projectStore, type Task } from "~/modules/projects/project-store"

const project = (id: string): ProjectDetail => ({
  id,
  name: id,
  description: null,
  icon: null,
  color: null,
  ownerId: "u1",
  archivedAt: null,
  createdAt: "2026-05-06T00:00:00Z",
  updatedAt: "2026-05-06T00:00:00Z",
  statuses: [
    { id: `${id}-s1`, projectId: id, label: "todo", color: null, order: 0, terminal: false },
  ],
})

const task = (projectId: string, id: string): Task => ({
  id,
  number: 1,
  projectId,
  parentTaskId: null,
  statusId: `${projectId}-s1`,
  title: id,
  description: null,
  assigneeId: null,
  priority: "normal",
  dueDate: null,
  startDate: null,
  position: 1000,
  blocked: false,
  completedAt: null,
  threadId: `${id}-thread`,
  createdBy: "u1",
  createdAt: "2026-05-06T00:00:00Z",
  updatedAt: "2026-05-06T00:00:00Z",
})

describe("project-store", () => {
  it("keeps loaded project state keyed by project id", async () => {
    projectStore._resetForTest()
    const get = vi.fn(async (path: string) => {
      if (path === "/projects/p1") return project("p1")
      if (path === "/projects/p1/tasks") return { items: [task("p1", "t1")] }
      if (path === "/projects/p2") return project("p2")
      if (path === "/projects/p2/tasks") return { items: [task("p2", "t2")] }
      throw new Error(path)
    })

    await projectStore.load({ get } as any, "p1")
    await projectStore.load({ get } as any, "p2")

    expect(projectStore.project("p1")?.name).toBe("p1")
    expect(projectStore.project("p2")?.name).toBe("p2")
    expect(projectStore.tasksFor("p1").map((t) => t.id)).toEqual(["t1"])
    expect(projectStore.tasksFor("p2").map((t) => t.id)).toEqual(["t2"])
    expect(projectStore.projectIdForTask("t1")).toBe("p1")
  })

  it("applies task and status events only to their owning project", () => {
    projectStore._resetForTest()
    projectStore._setForTest({ projectId: "p1", current: project("p1"), tasks: [task("p1", "t1")] })
    projectStore._setForTest({ projectId: "p2", current: project("p2"), tasks: [task("p2", "t2")] })

    projectStore.handleTaskEvent("updated", { id: "t1", projectId: "p1", title: "updated" })
    projectStore.handleProjectStatusEvent("updated", {
      id: "p2-s1",
      projectId: "p2",
      label: "doing",
    })

    expect(projectStore.tasksFor("p1")[0]?.title).toBe("updated")
    expect(projectStore.tasksFor("p2")[0]?.title).toBe("t2")
    expect(projectStore.project("p1")?.statuses[0]?.label).toBe("todo")
    expect(projectStore.project("p2")?.statuses[0]?.label).toBe("doing")
  })

  it("refetches loaded project detail on a resync bump without moving lastProjectId", async () => {
    projectStore._resetForTest()
    const { subscribeProjectResync } = await import("~/modules/projects/project-store")
    const { requestResync } = await import("~/framework/resync")

    let taskSuffix = "a"
    const get = vi.fn(async (path: string) => {
      const m = path.match(/^\/projects\/(p\d)(\/tasks)?$/)
      if (!m) throw new Error(path)
      if (m[2]) return { items: [task(m[1]!, `${m[1]}-t-${taskSuffix}`)] }
      return project(m[1]!)
    })

    subscribeProjectResync()
    await projectStore.load({ get } as any, "p1")
    await projectStore.load({ get } as any, "p2")
    expect(projectStore.current?.id).toBe("p2")

    // Simulate server-side changes landing while the WS was down, then a sync.
    taskSuffix = "b"
    get.mockClear()
    requestResync("test-ws-sync")
    await vi.waitFor(() => {
      expect(projectStore.tasksFor("p1").map((t) => t.id)).toEqual(["p1-t-b"])
      expect(projectStore.tasksFor("p2").map((t) => t.id)).toEqual(["p2-t-b"])
    })

    // Both loaded projects refetched detail (statuses) + tasks…
    expect(get.mock.calls.map((c) => c[0]).sort()).toEqual([
      "/projects/p1",
      "/projects/p1/tasks",
      "/projects/p2",
      "/projects/p2/tasks",
    ])
    // …and the active project pointer did not move.
    expect(projectStore.current?.id).toBe("p2")
  })
})

describe("project-store handleTaskEvent: full rows, stale echoes, moves", () => {
  const at = (iso: string) => `2026-10-15T10:00:${iso}.000Z`

  it("does not revert a row from a stale echo (older updatedAt)", () => {
    projectStore._resetForTest()
    const fresh = { ...task("p1", "t1"), statusId: "done", updatedAt: at("05") }
    projectStore._setForTest({ projectId: "p1", current: project("p1"), tasks: [fresh] })

    projectStore.handleTaskEvent("updated", {
      ...task("p1", "t1"),
      statusId: "todo",
      updatedAt: at("01"),
    })
    expect(projectStore.tasksFor("p1")[0]?.statusId).toBe("done")

    projectStore.handleTaskEvent("updated", {
      ...task("p1", "t1"),
      statusId: "review",
      updatedAt: at("09"),
    })
    expect(projectStore.tasksFor("p1")[0]?.statusId).toBe("review")
  })

  it("a same-project move keeps the task and re-sorts by position", () => {
    projectStore._resetForTest()
    const a = { ...task("p1", "a"), position: 1000 }
    const b = { ...task("p1", "b"), position: 2000 }
    projectStore._setForTest({ projectId: "p1", current: project("p1"), tasks: [a, b] })

    projectStore.handleTaskEvent("moved", {
      ...a,
      position: 3000,
      updatedAt: at("02"),
    })
    expect(projectStore.tasksFor("p1").map((t) => t.id)).toEqual(["b", "a"])
  })

  it("a moved event without fromProjectId never drops the row", () => {
    projectStore._resetForTest()
    projectStore._setForTest({ projectId: "p1", current: project("p1"), tasks: [task("p1", "t1")] })
    projectStore.handleTaskEvent("moved", { id: "t1", projectId: "p1", statusId: "x", position: 5 })
    expect(projectStore.tasksFor("p1").map((t) => t.id)).toEqual(["t1"])
    expect(projectStore.tasksFor("p1")[0]?.statusId).toBe("x")
  })

  it("a cross-project move removes from the source and inserts into the loaded target", () => {
    projectStore._resetForTest()
    projectStore._setForTest({ projectId: "p1", current: project("p1"), tasks: [task("p1", "t1")] })
    projectStore._setForTest({ projectId: "p2", current: project("p2"), tasks: [] })

    projectStore.handleTaskEvent("moved", {
      ...task("p2", "t1"),
      fromProjectId: "p1",
      key: "P2-4",
      number: 4,
      updatedAt: at("03"),
    })
    expect(projectStore.tasksFor("p1")).toHaveLength(0)
    const moved = projectStore.tasksFor("p2")
    expect(moved.map((t) => t.key)).toEqual(["P2-4"])
    expect("fromProjectId" in moved[0]!).toBe(false)
  })

  it("a created echo after the POST merge does not duplicate, and fills the key", () => {
    projectStore._resetForTest()
    projectStore._setForTest({ projectId: "p1", current: project("p1"), tasks: [] })
    const row = { ...task("p1", "n1"), key: "P1-7", number: 7, updatedAt: at("04") }
    projectStore.handleTaskEvent("created", row)
    projectStore.handleTaskEvent("created", row)
    expect(projectStore.tasksFor("p1").map((t) => t.key)).toEqual(["P1-7"])
  })
})
