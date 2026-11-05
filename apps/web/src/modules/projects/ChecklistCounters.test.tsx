// SPDX-License-Identifier: FSL-1.1-ALv2
import { render } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { ChecklistCounters } from "~/modules/projects/ChecklistCounters"
import type { ChecklistPerLevel, ChecklistStatus } from "~/modules/projects/checklist-types"

function level(name: string, applicable: number, success: number, fail = 0): ChecklistPerLevel {
  return { levelId: `l-${name}`, name, applicable, success, fail }
}

function status(perLevel: ChecklistPerLevel[], total = 4, complete = 0): ChecklistStatus {
  return { total, complete, failing: 0, perLevel, blocking: [] }
}

describe("ChecklistCounters", () => {
  it("projects.checklist.card.per-level-counters-use-applicable-as-denominator", () => {
    const { getByTestId, getAllByTestId } = render(() => (
      <ChecklistCounters
        status={status([level("AI", 4, 4), level("Dev", 4, 2), level("Beta", 4, 0)])}
      />
    ))
    expect(getByTestId("checklist-counters").textContent).toBe("AI 4/4 · Dev 2/4 · Beta 0/4")
    const counters = getAllByTestId("checklist-counter")
    expect(counters.map((c) => c.dataset.level)).toEqual(["AI", "Dev", "Beta"])
  })

  it("projects.checklist.card.fail-reads-error-full-success-reads-success", () => {
    const { getAllByTestId } = render(() => (
      <ChecklistCounters
        status={status([level("AI", 4, 4), level("Dev", 4, 2, 1), level("Beta", 3, 0)])}
      />
    ))
    const [ai, dev, beta] = getAllByTestId("checklist-counter")
    expect(ai!.className).toContain("text-success")
    expect(ai!.className).not.toContain("text-error")
    expect(dev!.className).toContain("text-error")
    expect(dev!.className).not.toContain("text-success")
    expect(beta!.className).not.toContain("text-success")
    expect(beta!.className).not.toContain("text-error")
    expect(beta!.textContent).toBe("Beta 0/3")
  })

  it("projects.checklist.card.a-fail-wins-over-full-success-count", () => {
    // A level cannot be fully successful and failing at once, but the error
    // token must win if a stale summary ever says so.
    const { getAllByTestId } = render(() => (
      <ChecklistCounters status={status([level("AI", 2, 2, 1)])} />
    ))
    expect(getAllByTestId("checklist-counter")[0]!.className).toContain("text-error")
  })

  it("projects.checklist.card.zero-applicable-level-is-hidden", () => {
    const { getByTestId, getAllByTestId } = render(() => (
      <ChecklistCounters status={status([level("AI", 0, 0), level("Dev", 2, 1)])} />
    ))
    expect(getAllByTestId("checklist-counter")).toHaveLength(1)
    expect(getByTestId("checklist-counters").textContent).toBe("Dev 1/2")
  })

  it("projects.checklist.card.plain-mode-shows-one-counter", () => {
    const { getByTestId, getAllByTestId } = render(() => (
      <ChecklistCounters status={status([], 5, 3)} />
    ))
    expect(getByTestId("checklist-counters").textContent).toBe("3/5")
    expect(getAllByTestId("checklist-counter")[0]!.className).not.toContain("text-success")
  })

  it("projects.checklist.card.plain-mode-complete-reads-success", () => {
    const { getAllByTestId } = render(() => <ChecklistCounters status={status([], 2, 2)} />)
    expect(getAllByTestId("checklist-counter")[0]!.className).toContain("text-success")
  })

  it("projects.checklist.card.no-checklist-no-counter", () => {
    const none = render(() => <ChecklistCounters status={null} />)
    expect(none.queryByTestId("checklist-counters")).toBeNull()
    const empty = render(() => <ChecklistCounters status={status([level("AI", 0, 0)], 0, 0)} />)
    expect(empty.queryByTestId("checklist-counters")).toBeNull()
  })
})
