// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { projectsFilterStore } from "~/modules/projects/projects-filter-store"

describe("projectsFilterStore.currentParams / applyParams", () => {
  beforeEach(() => {
    projectsFilterStore.clearAll()
    projectsFilterStore.setScopeProjectId(null)
    projectsFilterStore.setReloadHook(null)
  })

  it("currentParams returns a snapshot of the current filters", () => {
    projectsFilterStore.setQuery("alpha")
    projectsFilterStore.setAssignedToMe(true)
    projectsFilterStore.toggleStatusLabel("todo")
    expect(projectsFilterStore.currentParams()).toEqual({
      query: "alpha",
      assignedToMe: true,
      statusLabels: ["todo"],
      dueBuckets: [],
      release: null,
      taskLabels: {},
      involvedWithinDays: null,
      scopeProjectId: null,
    })
  })

  it("Recently involved toggles the default 14-day window, counts as active and clears", () => {
    projectsFilterStore.toggleInvolved()
    expect(projectsFilterStore.involvedWithinDays).toBe(14)
    expect(projectsFilterStore.isActive).toBe(true)
    expect(projectsFilterStore.currentParams().involvedWithinDays).toBe(14)
    projectsFilterStore.toggleInvolved()
    expect(projectsFilterStore.involvedWithinDays).toBeNull()
    projectsFilterStore.toggleInvolved()
    projectsFilterStore.clearAll()
    expect(projectsFilterStore.involvedWithinDays).toBeNull()
    expect(projectsFilterStore.isActive).toBe(false)
  })

  it("applyParams restores a saved view's involvedWithinDays, capped at 90 days", () => {
    projectsFilterStore.applyParams({ involvedWithinDays: 30 })
    expect(projectsFilterStore.involvedWithinDays).toBe(30)
    projectsFilterStore.applyParams({ involvedWithinDays: 365 })
    expect(projectsFilterStore.involvedWithinDays).toBe(90)
    projectsFilterStore.applyParams({ involvedWithinDays: "soon" })
    expect(projectsFilterStore.involvedWithinDays).toBeNull()
    projectsFilterStore.applyParams({ involvedWithinDays: 7 })
    projectsFilterStore.applyParams({ involvedWithinDays: null })
    expect(projectsFilterStore.involvedWithinDays).toBeNull()
  })

  it("toggleDueBucket adds and removes a bucket, and clearDueBuckets empties it", () => {
    projectsFilterStore.toggleDueBucket("overdue")
    expect(projectsFilterStore.dueBuckets).toEqual(["overdue"])
    projectsFilterStore.toggleDueBucket("due_soon")
    expect(projectsFilterStore.dueBuckets).toEqual(["overdue", "due_soon"])
    projectsFilterStore.toggleDueBucket("overdue")
    expect(projectsFilterStore.dueBuckets).toEqual(["due_soon"])
    projectsFilterStore.clearDueBuckets()
    expect(projectsFilterStore.dueBuckets).toEqual([])
  })

  it("applyParams restores dueBuckets, dropping invalid entries", () => {
    projectsFilterStore.applyParams({ dueBuckets: ["overdue", "bogus", "later"] } as any)
    expect(projectsFilterStore.dueBuckets).toEqual(["overdue", "later"])
  })

  it("applyParams replaces known fields, ignores unknown keys, and triggers reload", () => {
    const reload = vi.fn()
    projectsFilterStore.setReloadHook(reload)
    projectsFilterStore.applyParams({
      query: "beta",
      assignedToMe: true,
      statusLabels: ["doing"],
      unknown: 1,
    } as any)
    expect(projectsFilterStore.query).toBe("beta")
    expect(projectsFilterStore.assignedToMe).toBe(true)
    expect(projectsFilterStore.statusLabels).toEqual(["doing"])
    expect(reload).toHaveBeenCalled()
  })

  it("applyParams without a reload hook updates state without throwing", () => {
    projectsFilterStore.setReloadHook(null)
    expect(() => projectsFilterStore.applyParams({ query: "x" })).not.toThrow()
    expect(projectsFilterStore.query).toBe("x")
  })
})

describe("projectsFilterStore release filter", () => {
  beforeEach(() => {
    projectsFilterStore.clearAll()
    projectsFilterStore.setReloadHook(null)
  })

  it("a saved view round-trips the release filter", () => {
    projectsFilterStore.setRelease(" 2.1.0 ")
    const saved = JSON.parse(JSON.stringify(projectsFilterStore.currentParams()))
    expect(saved.release).toBe("2.1.0")
    projectsFilterStore.clearAll()
    expect(projectsFilterStore.release).toBeNull()
    expect(projectsFilterStore.isActive).toBe(false)
    projectsFilterStore.applyParams(saved)
    expect(projectsFilterStore.release).toBe("2.1.0")
    expect(projectsFilterStore.isActive).toBe(true)
  })

  it("applyParams clears the release on null and on an empty string, ignores other types", () => {
    projectsFilterStore.setRelease("2.1.0")
    projectsFilterStore.applyParams({ release: 42 })
    expect(projectsFilterStore.release).toBe("2.1.0")
    projectsFilterStore.applyParams({ release: "  " })
    expect(projectsFilterStore.release).toBeNull()
    projectsFilterStore.setRelease("__none__")
    projectsFilterStore.applyParams({ release: null })
    expect(projectsFilterStore.release).toBeNull()
  })
})

describe("projectsFilterStore task labels", () => {
  beforeEach(() => {
    projectsFilterStore.clearAll()
    projectsFilterStore.setReloadHook(null)
  })

  it("a label filter makes the store active; clearAll empties it", () => {
    expect(projectsFilterStore.isActive).toBe(false)
    projectsFilterStore.setTaskLabel("g1", "v1")
    projectsFilterStore.setTaskLabel("g2", "__none__")
    expect(projectsFilterStore.taskLabels).toEqual({ g1: "v1", g2: "__none__" })
    expect(projectsFilterStore.isActive).toBe(true)
    projectsFilterStore.clearAll()
    expect(projectsFilterStore.taskLabels).toEqual({})
    expect(projectsFilterStore.isActive).toBe(false)
  })

  it("clearTaskLabels empties the map; setTaskLabel(g, null) removes only g", () => {
    projectsFilterStore.setTaskLabel("g1", "v1")
    projectsFilterStore.setTaskLabel("g2", "v2")
    projectsFilterStore.setTaskLabel("g1", null)
    expect(projectsFilterStore.taskLabels).toEqual({ g2: "v2" })
    projectsFilterStore.setTaskLabel("g2", "v3")
    expect(projectsFilterStore.taskLabels).toEqual({ g2: "v3" })
    projectsFilterStore.clearTaskLabels()
    expect(projectsFilterStore.taskLabels).toEqual({})
  })

  it("a saved view round-trips the label filter as a detached copy", () => {
    projectsFilterStore.setTaskLabel("g1", "v1")
    const saved = projectsFilterStore.currentParams() as unknown as Record<string, unknown>
    expect(saved.taskLabels).toEqual({ g1: "v1" })
    projectsFilterStore.setTaskLabel("g2", "v2")
    expect(saved.taskLabels).toEqual({ g1: "v1" })
    projectsFilterStore.clearAll()
    projectsFilterStore.applyParams(saved)
    expect(projectsFilterStore.taskLabels).toEqual({ g1: "v1" })
  })

  it("applying a view that names fewer groups drops the stale keys", () => {
    projectsFilterStore.setTaskLabel("g1", "v0")
    projectsFilterStore.setTaskLabel("g2", "v2")
    projectsFilterStore.applyParams({ taskLabels: { g1: "v1" } })
    expect(projectsFilterStore.taskLabels).toEqual({ g1: "v1" })
  })

  it("applyParams ignores a non-object map and drops non-string values", () => {
    projectsFilterStore.setTaskLabel("g1", "v1")
    projectsFilterStore.applyParams({ taskLabels: "g1=v1" })
    expect(projectsFilterStore.taskLabels).toEqual({ g1: "v1" })
    projectsFilterStore.applyParams({ taskLabels: ["v1"] })
    expect(projectsFilterStore.taskLabels).toEqual({ g1: "v1" })
    projectsFilterStore.applyParams({ taskLabels: null })
    expect(projectsFilterStore.taskLabels).toEqual({ g1: "v1" })
    projectsFilterStore.applyParams({ taskLabels: { g2: 3, g3: "v3", g4: null } })
    expect(projectsFilterStore.taskLabels).toEqual({ g3: "v3" })
  })
})
