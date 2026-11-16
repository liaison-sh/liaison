// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A months column (one number per month, typed by people) and cell emphasis: the column's
// options, a months cell checked, merged by a write and replaced by an undo, and its window.

import { describe, expect, it } from "bun:test"
import { normalizeFieldDefs } from "~/apps/projects/service/create-project"
import {
  applyCells,
  CellError,
  type Column,
  columnsSchema,
  monthWindow,
  tableOnlyColumn,
  validateCells,
} from "~/modules/dashboards/tables/columns"
import { applyColumnOps, columnViews } from "~/modules/dashboards/tables/service"

const EXPECTED: Column = { key: "expected", label: "Expected", type: "months", horizon: 3 }
const COLS: Column[] = [{ key: "item", label: "Item", type: "text" }, EXPECTED]
const members = new Set<string>()

function refused(cells: Record<string, unknown>): string | null {
  try {
    validateCells(COLS, cells, { full: false, members })
    return null
  } catch (err) {
    if (err instanceof CellError) return err.reason
    throw err
  }
}

describe("months column options", () => {
  const ok = (cols: unknown) => columnsSchema.safeParse(cols).success

  it("takes a horizon of 1 to 12 and a fromOffset of 0 or 1 on a months column only", () => {
    expect(ok([{ key: "m", label: "M", type: "months" }])).toBe(true)
    expect(ok([{ key: "m", label: "M", type: "months", horizon: 12, fromOffset: 1 }])).toBe(true)
    expect(ok([{ key: "m", label: "M", type: "months", horizon: 0 }])).toBe(false)
    expect(ok([{ key: "m", label: "M", type: "months", horizon: 13 }])).toBe(false)
    expect(ok([{ key: "m", label: "M", type: "months", fromOffset: 2 }])).toBe(false)
    expect(ok([{ key: "n", label: "N", type: "number", horizon: 3 }])).toBe(false)
    expect(ok([{ key: "n", label: "N", type: "text", fromOffset: 1 }])).toBe(false)
    expect(ok([{ key: "m", label: "M", type: "months", required: true }])).toBe(false)
  })

  it("takes emphasis on number, amount and months columns only", () => {
    expect(ok([{ key: "n", label: "N", type: "number", emphasis: "negative" }])).toBe(true)
    expect(
      ok([{ key: "a", label: "A", type: "amount", currency: "EUR", emphasis: "nonzero" }]),
    ).toBe(true)
    expect(ok([{ key: "m", label: "M", type: "months", emphasis: "nonzero" }])).toBe(true)
    expect(ok([{ key: "t", label: "T", type: "text", emphasis: "nonzero" }])).toBe(false)
    expect(ok([{ key: "n", label: "N", type: "number", emphasis: "loud" }])).toBe(false)
  })

  it("changes options with setOptions, checked as the column is", () => {
    const qty: Column = { key: "qty", label: "Qty", type: "number" }
    const { columns } = applyColumnOps([...COLS, qty], [], {
      setOptions: [
        { key: "expected", horizon: 6, fromOffset: 1, emphasis: "nonzero" },
        { key: "qty", emphasis: "negative" },
      ],
    })
    expect(columns.find((c) => c.key === "expected")).toMatchObject({
      horizon: 6,
      fromOffset: 1,
      emphasis: "nonzero",
    })
    expect(columns.find((c) => c.key === "qty")?.emphasis).toBe("negative")
    const cleared = applyColumnOps(columns, [], { setOptions: [{ key: "qty", emphasis: null }] })
    expect(cleared.columns.find((c) => c.key === "qty")).not.toHaveProperty("emphasis")
    expect(() => applyColumnOps(COLS, [], { setOptions: [{ key: "item", horizon: 2 }] })).toThrow(
      "only a months or formula column",
    )
    expect(() => applyColumnOps(COLS, [], { setOptions: [{ key: "nope", horizon: 2 }] })).toThrow(
      "no column",
    )
  })

  it("is a dashboard table's only, never a project's task field", () => {
    expect(tableOnlyColumn(COLS)?.key).toBe("expected")
    expect(tableOnlyColumn([{ key: "n", label: "N", type: "number" }])).toBeUndefined()
    expect(() => normalizeFieldDefs([{ key: "m", label: "M", type: "months" }])).toThrow(
      "dashboard table's only",
    )
  })
})

describe("months cells", () => {
  it("takes {YYYY-MM: number | null} and refuses anything else", () => {
    expect(
      validateCells(
        COLS,
        { expected: { "2026-11": 40, "2026-12": null } },
        { full: false, members },
      ),
    ).toEqual({ expected: { "2026-11": 40, "2026-12": null } })
    expect(refused({ expected: 40 })).toContain("months")
    expect(refused({ expected: [1, 2] })).toContain("months")
    expect(refused({ expected: { "2026-13": 1 } })).toContain("not a month")
    expect(refused({ expected: { "2026-1": 1 } })).toContain("not a month")
    expect(refused({ expected: { "2026-11": "40" } })).toContain("a number or null")
    expect(refused({ expected: { "2026-11": Number.NaN } })).toContain("a number or null")
  })

  it("a write changes only the months it names; null clears one; 0 is a value", () => {
    const stored = { item: "Widget", expected: { "2026-10": 5, "2026-11": 40 } }
    const cells = validateCells(
      COLS,
      { expected: { "2026-11": null, "2026-12": 0, "2027-01": 25 } },
      { full: false, members },
    )
    expect(applyCells(stored, cells, COLS)).toEqual({
      item: "Widget",
      expected: { "2026-10": 5, "2026-12": 0, "2027-01": 25 },
    })
  })

  it("clearing every month, or writing null, empties the cell", () => {
    const stored = { expected: { "2026-11": 40 } }
    expect(applyCells(stored, { expected: { "2026-11": null } }, COLS)).toEqual({})
    expect(applyCells(stored, { expected: null }, COLS)).toEqual({})
    expect(applyCells({}, { expected: { "2026-11": null } }, COLS)).toEqual({})
  })

  it("an undo writes the whole cell back (no merge)", () => {
    const stored = { expected: { "2026-11": 40, "2026-12": 3 } }
    expect(applyCells(stored, { expected: { "2026-11": 10 } })).toEqual({
      expected: { "2026-11": 10 },
    })
  })
})

describe("months window", () => {
  it("starts at the current or the next month and crosses years", () => {
    expect(monthWindow({}, "2026-11")).toEqual(["2026-11", "2026-12", "2027-01"])
    expect(monthWindow({ horizon: 2, fromOffset: 1 }, "2026-12")).toEqual(["2027-01", "2027-02"])
    expect(monthWindow({ horizon: 12 }, "2026-01")).toHaveLength(12)
    expect(monthWindow({ horizon: 12 }, "2026-01").at(-1)).toBe("2026-12")
  })

  it("a read gives each months column its window, other columns unchanged", () => {
    const views = columnViews(COLS, "2026-11")
    expect(views[0]).toEqual(COLS[0]!)
    expect(views[1]?.months).toEqual(["2026-11", "2026-12", "2027-01"])
    expect(columnViews(COLS, null)[1]).not.toHaveProperty("months")
  })
})
