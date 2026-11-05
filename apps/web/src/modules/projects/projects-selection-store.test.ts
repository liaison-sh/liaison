// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest"
import {
  clearSelection,
  ProjectsSelectionTestAccess,
  selectedIds,
  toggleSelection,
} from "~/modules/projects/projects-selection-store"

describe("projects-selection-store", () => {
  beforeEach(() => {
    ProjectsSelectionTestAccess.reset()
  })

  it("toggleSelection adds and removes ids", () => {
    toggleSelection("task-1")
    toggleSelection("task-2")
    expect(selectedIds().sort()).toEqual(["task-1", "task-2"])
    toggleSelection("task-1")
    expect(selectedIds()).toEqual(["task-2"])
  })

  it("clearSelection empties the set", () => {
    toggleSelection("task-1")
    clearSelection()
    expect(selectedIds()).toEqual([])
  })
})
