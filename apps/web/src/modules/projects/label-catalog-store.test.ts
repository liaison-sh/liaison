// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runTool = vi.fn()
vi.mock("~/lib/run-tool", () => ({ runTool: (...args: unknown[]) => runTool(...args) }))

import type { ApiClient } from "~/lib/api-client"
import { teardownSession } from "~/lib/session-lifecycle"
import {
  ensureLabelCatalog,
  handleLabelEvent,
  labelCatalog,
  loadLabelCatalog,
  resetLabelCatalogStore,
} from "~/modules/projects/label-catalog-store"
import { projectsFilterStore } from "~/modules/projects/projects-filter-store"

const api = {} as ApiClient

const catalog = {
  groups: [
    {
      id: "g-nature",
      name: "Nature",
      sortOrder: 0,
      archivedAt: null,
      values: [
        {
          id: "v-bug",
          groupId: "g-nature",
          name: "bug",
          sortOrder: 0,
          archivedAt: null,
          archived: false,
        },
        {
          id: "v-old",
          groupId: "g-nature",
          name: "old",
          sortOrder: 1,
          archivedAt: "2026-10-01T00:00:00Z",
          archived: true,
        },
      ],
    },
    {
      id: "g-team",
      name: "Team",
      sortOrder: 1,
      archivedAt: "2026-10-02T00:00:00Z",
      values: [
        {
          id: "v-core",
          groupId: "g-team",
          name: "core",
          sortOrder: 0,
          archivedAt: null,
          archived: true,
        },
      ],
    },
  ],
}

describe("label catalog store", () => {
  beforeEach(() => {
    runTool.mockReset()
    resetLabelCatalogStore()
  })
  afterEach(() => resetLabelCatalogStore())

  it("loads labels.list with archived rows and keeps them", async () => {
    runTool.mockResolvedValueOnce(catalog)
    await loadLabelCatalog(api)
    expect(runTool).toHaveBeenCalledWith(api, "projects:labels.list", { includeArchived: true })
    expect(labelCatalog.loaded).toBe(true)
    expect(labelCatalog.failed).toBe(false)
    expect(labelCatalog.groups.map((g) => g.id)).toEqual(["g-nature", "g-team"])
    expect(labelCatalog.group("g-nature")?.values.map((v) => v.id)).toEqual(["v-bug", "v-old"])
    expect(labelCatalog.group("g-nature")?.values.find((v) => v.id === "v-old")).toMatchObject({
      groupId: "g-nature",
      sortOrder: 1,
      archived: true,
    })
    expect(labelCatalog.group("g-nature")?.values.find((v) => v.id === "v-bug")).toMatchObject({
      groupId: "g-nature",
      archivedAt: null,
      archived: false,
    })
    expect(labelCatalog.groupOrder()).toEqual(["g-nature", "g-team"])
  })

  it("liveGroups hides archived groups and archived values", async () => {
    runTool.mockResolvedValueOnce(catalog)
    await loadLabelCatalog(api)
    const live = labelCatalog.liveGroups()
    expect(live.map((g) => g.id)).toEqual(["g-nature"])
    expect(live[0]?.values.map((v) => v.id)).toEqual(["v-bug"])
  })

  it("displayName prefers the catalog's names over the payload's", async () => {
    runTool.mockResolvedValueOnce(catalog)
    await loadLabelCatalog(api)
    const entry = {
      groupId: "g-nature",
      groupName: "Nature (stale)",
      groupArchived: false,
      valueId: "v-bug",
      valueName: "bogue",
      archived: false,
      inherited: false,
      inheritedFromKey: null,
    }
    expect(labelCatalog.displayName(entry)).toEqual({
      groupName: "Nature",
      valueName: "bug",
      archived: false,
    })
    expect(labelCatalog.displayName({ ...entry, groupId: "x", valueId: "y" })).toEqual({
      groupName: "Nature (stale)",
      valueName: "bogue",
      archived: false,
    })
  })

  it("displayName takes the archive state from the catalog, the payload only as fallback", async () => {
    runTool.mockResolvedValueOnce(catalog)
    await loadLabelCatalog(api)
    const entry = {
      groupId: "g-nature",
      groupName: "Nature",
      groupArchived: false,
      valueId: "v-old",
      valueName: "old",
      archived: false,
      inherited: false,
      inheritedFromKey: null,
    }
    // Archived in the catalog since the task row was read.
    expect(labelCatalog.displayName(entry).archived).toBe(true)
    // Restored in the catalog: the payload's stale mark goes.
    expect(labelCatalog.displayName({ ...entry, valueId: "v-bug", archived: true }).archived).toBe(
      false,
    )
    // A value of an archived group is archived.
    expect(
      labelCatalog.displayName({ ...entry, groupId: "g-team", valueId: "v-core" }).archived,
    ).toBe(true)
    // Unknown to the catalog: the payload decides.
    expect(labelCatalog.displayName({ ...entry, valueId: "zz", archived: true }).archived).toBe(
      true,
    )
  })

  it("an older fetch resolving after a newer one does not overwrite it", async () => {
    let resolveOld: (v: unknown) => void = () => {}
    runTool.mockReturnValueOnce(new Promise((r) => (resolveOld = r)))
    const old = loadLabelCatalog(api)
    runTool.mockResolvedValueOnce({ groups: [] })
    await loadLabelCatalog(api)
    expect(labelCatalog.groups).toEqual([])
    resolveOld(catalog)
    await old
    expect(labelCatalog.groups).toEqual([])
    expect(labelCatalog.loading).toBe(false)
  })

  it("a fetch resolving after session teardown leaves the store empty", async () => {
    let resolve: (v: unknown) => void = () => {}
    runTool.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const run = ensureLabelCatalog(api)
    teardownSession()
    resolve(catalog)
    await run
    expect(labelCatalog.groups).toEqual([])
    expect(labelCatalog.loaded).toBe(false)
    // The next session loads again.
    runTool.mockResolvedValueOnce(catalog)
    await ensureLabelCatalog(api)
    expect(runTool).toHaveBeenCalledTimes(2)
    expect(labelCatalog.loaded).toBe(true)
  })

  it("once loaded, the board filter drops the ids the catalog does not know", async () => {
    projectsFilterStore.clearAll()
    projectsFilterStore.setTaskLabel("g-gone", "v-x")
    projectsFilterStore.setTaskLabel("g-nature", "v-nope")
    projectsFilterStore.setTaskLabel("g-team", "__none__")
    // Before the catalog loads, nothing can be judged unknown.
    expect(Object.keys(projectsFilterStore.taskLabels)).toHaveLength(3)
    runTool.mockResolvedValueOnce(catalog)
    await loadLabelCatalog(api)
    // The archived Team group is known; the unknown group and value are dropped.
    expect(projectsFilterStore.taskLabels).toEqual({ "g-team": "__none__" })
    expect(projectsFilterStore.currentParams().taskLabels).toEqual({ "g-team": "__none__" })
    projectsFilterStore.setTaskLabel("g-team", null)
    // Only unknown ids left: the filter is not active.
    expect(projectsFilterStore.taskLabels).toEqual({})
    expect(projectsFilterStore.isActive).toBe(false)
    projectsFilterStore.clearAll()
  })

  it("a label event refetches the whole list", async () => {
    runTool.mockResolvedValueOnce(catalog)
    await loadLabelCatalog(api)
    runTool.mockResolvedValueOnce({ groups: [] })
    handleLabelEvent("archived", { id: "g-nature" })
    await vi.waitFor(() => expect(labelCatalog.groups).toEqual([]))
    expect(runTool).toHaveBeenCalledTimes(2)
  })

  it("a label event before any load does nothing", () => {
    handleLabelEvent("created", { id: "x" })
    expect(runTool).not.toHaveBeenCalled()
  })

  it("ensureLabelCatalog dedupes concurrent calls", async () => {
    let resolve: (v: unknown) => void = () => {}
    runTool.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const a = ensureLabelCatalog(api)
    const b = ensureLabelCatalog(api)
    expect(labelCatalog.loading).toBe(true)
    resolve(catalog)
    await Promise.all([a, b])
    expect(runTool).toHaveBeenCalledTimes(1)
    await ensureLabelCatalog(api)
    expect(runTool).toHaveBeenCalledTimes(1)
  })

  it("a failed load sets failed", async () => {
    runTool.mockRejectedValueOnce(new Error("boom"))
    await loadLabelCatalog(api)
    expect(labelCatalog.failed).toBe(true)
    expect(labelCatalog.loaded).toBe(false)
    expect(labelCatalog.loading).toBe(false)
  })

  it("ensureLabelCatalog does not retry a failed load; a label event does", async () => {
    runTool.mockRejectedValueOnce(new Error("boom"))
    await ensureLabelCatalog(api)
    await ensureLabelCatalog(api)
    expect(runTool).toHaveBeenCalledTimes(1)
    runTool.mockResolvedValueOnce(catalog)
    handleLabelEvent("created", { id: "g-x" })
    await vi.waitFor(() => expect(labelCatalog.loaded).toBe(true))
    expect(labelCatalog.failed).toBe(false)
    expect(runTool).toHaveBeenCalledTimes(2)
  })

  it("session teardown resets the store", async () => {
    runTool.mockResolvedValueOnce(catalog)
    await loadLabelCatalog(api)
    teardownSession()
    expect(labelCatalog.groups).toEqual([])
    expect(labelCatalog.loaded).toBe(false)
  })
})
