// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  type ChecklistItemLike,
  checklistStatus,
  parseStoredLevels,
  type ValidationLevel,
  type ValidationRecord,
  validateLevels,
} from "./checklist-status"
import { ProjectsServiceError } from "./statuses"

function record(state: ValidationRecord["state"]): ValidationRecord {
  return { state, by: "user-1", via: "human", source: null, at: "2026-09-25T00:00:00.000Z" }
}

function item(id: string, overrides: Partial<ChecklistItemLike> = {}): ChecklistItemLike {
  return { id, title: `Item ${id}`, checked: false, validations: {}, ...overrides }
}

const AI: ValidationLevel = { id: "lvl-ai", name: "AI" }
const DEV: ValidationLevel = { id: "lvl-dev", name: "Dev" }

describe("checklistStatus", () => {
  it("plain mode: complete counts checked items, each unchecked item blocks with no levels", () => {
    const items = [
      item("1", { checked: true }),
      item("2", { checked: false }),
      item("3", { checked: true }),
    ]
    const result = checklistStatus([], items)
    expect(result).toEqual({
      total: 3,
      complete: 2,
      failing: 0,
      perLevel: [],
      blocking: [{ itemId: "2", title: "Item 2", levels: [] }],
    })
  })

  it("level mode: an item is complete only when every level is success or na", () => {
    const items = [
      item("1", { validations: { [AI.id]: record("success"), [DEV.id]: record("na") } }),
      item("2", { validations: { [AI.id]: record("success"), [DEV.id]: record("not_done") } }),
    ]
    const result = checklistStatus([AI, DEV], items)
    expect(result.total).toBe(2)
    expect(result.complete).toBe(1)
    expect(result.failing).toBe(0)
    expect(result.blocking).toEqual([{ itemId: "2", title: "Item 2", levels: ["Dev"] }])
    const ai = result.perLevel.find((l) => l.levelId === AI.id)!
    const dev = result.perLevel.find((l) => l.levelId === DEV.id)!
    expect(ai).toEqual({ levelId: AI.id, name: "AI", applicable: 2, success: 2, fail: 0 })
    expect(dev.applicable).toBe(1)
    expect(dev.success).toBe(0)
  })

  it("zero items: complete, total 0", () => {
    const result = checklistStatus([AI, DEV], [])
    expect(result.total).toBe(0)
    expect(result.complete).toBe(0)
    expect(result.failing).toBe(0)
    expect(result.blocking).toEqual([])
  })

  it("all na: item is complete, applicable 0 for every level", () => {
    const items = [item("1", { validations: { [AI.id]: record("na"), [DEV.id]: record("na") } })]
    const result = checklistStatus([AI, DEV], items)
    expect(result.total).toBe(1)
    expect(result.complete).toBe(1)
    for (const perLevel of result.perLevel) {
      expect(perLevel.applicable).toBe(0)
      expect(perLevel.success).toBe(0)
      expect(perLevel.fail).toBe(0)
    }
  })

  it("a missing key reads as not_done, so the item is incomplete and blocking", () => {
    const items = [item("1", { validations: { [AI.id]: record("success") } })]
    const result = checklistStatus([AI, DEV], items)
    expect(result.complete).toBe(0)
    expect(result.blocking).toEqual([{ itemId: "1", title: "Item 1", levels: ["Dev"] }])
  })

  it("one fail: failing 1, blocking names that level", () => {
    const items = [
      item("1", { validations: { [AI.id]: record("fail"), [DEV.id]: record("success") } }),
    ]
    const result = checklistStatus([AI, DEV], items)
    expect(result.failing).toBe(1)
    expect(result.complete).toBe(0)
    expect(result.blocking).toEqual([{ itemId: "1", title: "Item 1", levels: ["AI"] }])
  })
})

describe("parseStoredLevels", () => {
  it("reads stored levels, ignoring a legacy agentAccess key and malformed entries", () => {
    expect(
      parseStoredLevels([
        { id: "1", name: "AI", agentAccess: "direct" },
        { id: "2", name: "Beta" },
        { name: "no id" },
        null,
      ]),
    ).toEqual([
      { id: "1", name: "AI" },
      { id: "2", name: "Beta" },
    ])
    expect(parseStoredLevels(null)).toEqual([])
  })
})

describe("validateLevels", () => {
  it("accepts a well-formed list and returns trimmed names", () => {
    const result = validateLevels([
      { id: "1", name: " AI " },
      { id: "2", name: "Dev" },
      { id: "3", name: "Beta" },
    ])
    expect(result.map((l) => l.name)).toEqual(["AI", "Dev", "Beta"])
  })

  it("refuses 9 levels", () => {
    const levels = Array.from({ length: 9 }, (_, i) => ({
      id: String(i),
      name: `L${i}`,
    }))
    let err: unknown
    try {
      validateLevels(levels)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ProjectsServiceError)
    expect((err as ProjectsServiceError).code).toBe("validation_levels_invalid")
  })

  it("refuses 'ai' and 'AI' as duplicates, case-insensitively", () => {
    let err: unknown
    try {
      validateLevels([
        { id: "1", name: "ai" },
        { id: "2", name: "AI" },
      ])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ProjectsServiceError)
    expect((err as ProjectsServiceError).code).toBe("validation_levels_invalid")
  })

  it("drops any key other than id and name (a legacy agentAccess)", () => {
    const legacy = [{ id: "1", name: "AI" }] as unknown as ValidationLevel[]
    expect(validateLevels(legacy)).toEqual([{ id: "1", name: "AI" }])
  })
})
