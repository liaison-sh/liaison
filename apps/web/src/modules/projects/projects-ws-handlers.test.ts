// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/shell/attention-store", () => ({
  attentionStore: { markStaleAndReload: vi.fn() },
  getAttentionApi: () => null,
}))

const catalogHandleLabelEvent = vi.fn()
vi.mock("~/modules/projects/label-catalog-store", () => ({
  handleLabelEvent: (...args: unknown[]) => catalogHandleLabelEvent(...args),
}))

import { checklistStore, resetChecklistStore } from "~/modules/projects/checklist-store"
import { computeChecklistStatus } from "~/modules/projects/checklist-types"
import { projectStore, type Task } from "~/modules/projects/project-store"
import { projectsStore } from "~/modules/projects/projects-store"
import {
  handleChecklistItemEvent,
  handleLabelEvent,
  handleProjectEvent,
} from "~/modules/projects/projects-ws-handlers"

const alpha = {
  id: "p1",
  name: "Alpha",
  description: "Roadmap",
  icon: null,
  color: "#123456",
  ownerId: "u1",
  taskCount: 7,
  archivedAt: null,
  updatedAt: "2026-05-06T00:00:00Z",
}

describe("projects ws handlers", () => {
  afterEach(() => {
    projectsStore._setForTest({ items: [], loaded: false, archived: [], archivedLoaded: false })
  })

  it("an update event carrying one field leaves the others alone", () => {
    projectsStore._setForTest({ items: [{ ...alpha }], loaded: true })
    // The server emits { id, ...patch }: a colour change carries no name.
    handleProjectEvent("updated", { id: "p1", color: "#abcdef" })
    expect(projectsStore.byId("p1")).toMatchObject({
      name: "Alpha",
      description: "Roadmap",
      ownerId: "u1",
      taskCount: 7,
      color: "#abcdef",
    })
  })

  it("archive then restore echoes keep the project's name", () => {
    projectsStore._setForTest({ items: [{ ...alpha }], loaded: true })
    handleProjectEvent("archived", { id: "p1" })
    expect(projectsStore.byId("p1")?.archivedAt).toBeTruthy()
    // The restore event carries only the id; before, it blanked the name.
    handleProjectEvent("restored", { id: "p1" })
    expect(projectsStore.byId("p1")).toMatchObject({ name: "Alpha", archivedAt: null })
  })
})

const levels = [
  { id: "lvl-ai", name: "AI" },
  { id: "lvl-dev", name: "Dev" },
]
const ok = { state: "success" as const, by: "u1", via: "agent" as const, source: null, at: "x" }
const checklistItem = (
  id: string,
  taskId: string,
  validations: Record<string, typeof ok> = {},
) => ({
  id,
  taskId,
  position: 1,
  title: id,
  details: null,
  checked: false,
  validations,
  createdBy: "u1",
  createdAt: "x",
  updatedAt: "x",
})
const boardTask = (id: string) =>
  ({ id, projectId: "p1", parentTaskId: null, statusId: "s1", title: id }) as unknown as Task

describe("task_checklist_item ws events", () => {
  afterEach(() => {
    vi.useRealTimers()
    resetChecklistStore()
    projectStore._resetForTest()
  })

  it("an item event updates the counters of that task only", async () => {
    projectStore._setForTest({ projectId: "p1", tasks: [boardTask("t1"), boardTask("t2")] })
    const items = [checklistItem("i1", "t1"), checklistItem("i2", "t1")]
    const get = vi.fn(async () => ({
      levels,
      items,
      status: computeChecklistStatus(levels, items),
    }))
    await checklistStore.load({ get } as any, "p1", "t1")
    expect(projectStore.task("t1")?.checklist?.perLevel[0]).toMatchObject({ success: 0 })

    handleChecklistItemEvent("updated", checklistItem("i1", "t1", { "lvl-ai": ok }))
    expect(projectStore.task("t1")?.checklist?.perLevel[0]).toMatchObject({
      name: "AI",
      applicable: 2,
      success: 1,
    })
    handleChecklistItemEvent("created", checklistItem("i3", "t1"))
    expect(projectStore.task("t1")?.checklist?.total).toBe(3)
    handleChecklistItemEvent("deleted", { id: "i2", taskId: "t1" })
    expect(projectStore.task("t1")?.checklist?.total).toBe(2)
    expect(projectStore.task("t2")?.checklist).toBeUndefined()
  })

  it("an item event on a board task whose checklist is not loaded refetches it once", async () => {
    vi.useFakeTimers()
    const items = [checklistItem("i1", "t2", { "lvl-ai": ok })]
    const get = vi.fn(async (path: string) => {
      if (path === "/projects/p1") return { id: "p1", statuses: [] }
      if (path === "/projects/p1/tasks") return { items: [boardTask("t2")] }
      if (path === "/projects/p1/tasks/t2/checklist")
        return { levels, items, status: computeChecklistStatus(levels, items) }
      throw new Error(path)
    })
    await projectStore.load({ get } as any, "p1")
    get.mockClear()
    handleChecklistItemEvent("updated", items[0])
    handleChecklistItemEvent("updated", items[0])
    await vi.runAllTimersAsync()
    expect(get.mock.calls.map((c) => c[0])).toEqual(["/projects/p1/tasks/t2/checklist"])
    expect(projectStore.task("t2")?.checklist?.perLevel[0]).toMatchObject({ success: 1 })
  })

  it("an event for a task this client never loaded is ignored", () => {
    projectStore._setForTest({ projectId: "p1", tasks: [boardTask("t1")] })
    handleChecklistItemEvent("created", checklistItem("i9", "elsewhere"))
    expect(checklistStore.get("elsewhere")).toBeNull()
  })

  it("a project update carrying levels drops removed levels from loaded checklists", async () => {
    projectStore._setForTest({ projectId: "p1", tasks: [boardTask("t1")] })
    const items = [checklistItem("i1", "t1", { "lvl-ai": ok, "lvl-dev": ok })]
    const get = vi.fn(async () => ({
      levels,
      items,
      status: computeChecklistStatus(levels, items),
    }))
    await checklistStore.load({ get } as any, "p1", "t1")
    handleProjectEvent("updated", { id: "p1", validationLevels: [levels[1]] })
    expect(checklistStore.levels("t1").map((l) => l.name)).toEqual(["Dev"])
    expect(Object.keys(checklistStore.items("t1")[0]!.validations)).toEqual(["lvl-dev"])
    expect(projectStore.task("t1")?.checklist?.perLevel.map((l) => l.name)).toEqual(["Dev"])
  })

  it("a project update carrying checklistOnCards reaches the open board", () => {
    projectStore._setForTest({
      projectId: "p1",
      current: {
        id: "p1",
        name: "Roadmap",
        description: null,
        icon: null,
        color: null,
        ownerId: "u1",
        archivedAt: null,
        createdAt: "",
        updatedAt: "",
        statuses: [],
      },
    })
    handleProjectEvent("updated", { id: "p1", checklistOnCards: false })
    expect(projectStore.project("p1")?.checklistOnCards).toBe(false)
    expect(projectStore.project("p1")?.name).toBe("Roadmap")
  })
})

describe("label ws handler", () => {
  it("a label event hands over to the catalog store, which refetches", () => {
    handleLabelEvent("archived", { id: "g-nature" })
    expect(catalogHandleLabelEvent).toHaveBeenCalledWith("archived", { id: "g-nature" })
  })
})
