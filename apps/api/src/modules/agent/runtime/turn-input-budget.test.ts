// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A step budget (a demo visitor's turn): the last allowed step is the
// check-in, tools off, so the turn ends with an answer at its cap.
import { describe, expect, it } from "bun:test"
import { createTurnInputBudget, stepBudgetPromptLine } from "./turn-input-budget"

describe("a turn with a step budget", () => {
  it("checks in on its last step, however small its input", () => {
    const budget = createTurnInputBudget({ maxSteps: 6 })
    for (let step = 0; step < 5; step++) {
      expect(budget.checkInDue()).toBe(false)
      budget.recordStep(20_000)
    }
    expect(budget.checkInDue()).toBe(true)
    budget.markCheckInSent()
    expect(budget.checkInDue()).toBe(false)
    expect(budget.checkInSent).toBe(true)
  })

  it("without one, only the input budget calls the check-in", () => {
    const budget = createTurnInputBudget()
    for (let step = 0; step < 30; step++) budget.recordStep(20_000)
    expect(budget.checkInDue()).toBe(false)
  })
})

// Live demo: a support routine spent all five tool steps reading and was then
// told, tools off, to say how far it got: no note and no draft were written.
describe("a step budget's last step with tools", () => {
  it("is announced on the step before the check-in, and only there", () => {
    const budget = createTurnInputBudget({ maxSteps: 6 })
    const due: boolean[] = []
    for (let step = 0; step < 5; step++) {
      due.push(budget.lastToolStepDue())
      budget.recordStep(20_000)
    }
    expect(due).toEqual([false, false, false, false, true])
    expect(budget.checkInDue()).toBe(true)
    expect(budget.lastToolStepDue()).toBe(false)
  })

  it("is never announced without a step budget", () => {
    const budget = createTurnInputBudget()
    for (let step = 0; step < 10; step++) {
      expect(budget.lastToolStepDue()).toBe(false)
      budget.recordStep(20_000)
    }
  })
})

describe("the prompt line of a step budget", () => {
  it("names the steps with tools and the step the writes must land by", () => {
    const line = stepBudgetPromptLine(6)
    expect(line).toContain("at most 6 steps")
    expect(line).toContain("5 that can call tools")
    expect(line).toContain("by step 5")
  })
})
