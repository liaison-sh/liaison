// SPDX-License-Identifier: FSL-1.1-ALv2
// Which tasks a budget's coverage counts: the leaves begun, closed, or holding real time.
import { describe, expect, it } from "bun:test"
import { type BudgetTask, coverageOf } from "./coverage"

const task = (id: string, over: Partial<BudgetTask> = {}): BudgetTask => ({
  id,
  parentId: null,
  name: id,
  position: 0,
  number: 0,
  timebox: null,
  isMilestone: false,
  archived: false,
  closed: false,
  started: false,
  ...over,
})

describe("a budget's coverage", () => {
  it("counts a task that holds real time though it was never moved on", () => {
    // Time entered on two tasks still in the first column: the real figure counts them, so
    // coverage does too ("on 2 of 2 tasks", never "on 0 of 0" beside 104 h).
    const tasks = [task("design"), task("build"), task("launch")]
    expect(coverageOf(tasks, new Set(["design", "build"]))).toEqual({ withEntries: 2, total: 2 })
  })

  it("counts begun and closed leaves, with time or without, and never a parent", () => {
    const tasks = [
      task("phase"),
      task("a", { parentId: "phase", closed: true }),
      task("b", { parentId: "phase", started: true }),
      task("c", { parentId: "phase" }),
    ]
    expect(coverageOf(tasks, new Set(["a"]))).toEqual({ withEntries: 1, total: 2 })
  })
})
