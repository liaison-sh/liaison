// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Row links and rollup columns, without a database: the column definitions, the aggregation
// (a sum, a count, by month), the join onto this table's rows and the checks against the other
// table's columns.

import { describe, expect, it } from "bun:test"
import {
  type Column,
  columnSchema,
  columnsSchema,
  isMonthly,
  monthWindow,
  type RollupDef,
  validateCells,
} from "~/modules/dashboards/tables/columns"
import {
  joinRollup,
  rollupIndex,
  rollupProblem,
  rowLabel,
} from "~/modules/dashboards/tables/rollup"

const PARTS = "11111111-1111-4111-8111-111111111111"
const LOTS = "22222222-2222-4222-8222-222222222222"

const link = (id: string) => ({ app: "kernel", entityType: "table_row", id, label: id })

const sum: RollupDef = { table: LOTS, link: "part", value: "qty", agg: "sum" }

describe("rollup and row link definitions", () => {
  it("a row link names its table; a table on another kind of link is refused", () => {
    expect(
      columnSchema.safeParse({
        key: "part",
        label: "Part",
        type: "link",
        linkTo: { app: "kernel", entityType: "table_row", table: PARTS },
      }).success,
    ).toBe(true)
    expect(
      columnSchema.safeParse({
        key: "part",
        label: "Part",
        type: "link",
        linkTo: { app: "kernel", entityType: "table_row" },
      }).success,
    ).toBe(false)
    expect(
      columnSchema.safeParse({
        key: "p",
        label: "P",
        type: "link",
        linkTo: { app: "shop", entityType: "product", table: PARTS },
      }).success,
    ).toBe(false)
  })

  it("a rollup: sum names its value, count has none, by month takes a window, never required", () => {
    const ok = (rollup: unknown, extra: Record<string, unknown> = {}) =>
      columnSchema.safeParse({ key: "ordered", label: "Ordered", type: "rollup", rollup, ...extra })
        .success
    expect(ok(sum)).toBe(true)
    expect(ok({ ...sum, value: null })).toBe(false)
    expect(ok({ ...sum, agg: "count", value: null })).toBe(true)
    expect(ok({ ...sum, agg: "count" })).toBe(false)
    expect(ok(sum, { horizon: 4 })).toBe(false)
    expect(ok({ ...sum, byMonth: "eta" }, { horizon: 4, fromOffset: 1, emphasis: "nonzero" })).toBe(
      true,
    )
    expect(ok(sum, { required: true })).toBe(false)
    expect(ok({ ...sum, where: { status: { in: ["ordered"] } } })).toBe(true)
    expect(columnSchema.safeParse({ key: "x", label: "X", type: "rollup" }).success).toBe(false)
    const six = Array.from({ length: 6 }, (_, i) => ({
      key: `r${i}`,
      label: `R${i}`,
      type: "rollup",
      rollup: sum,
    }))
    expect(columnsSchema.safeParse(six).success).toBe(false)
  })

  it("a rollup by month is months-shaped, with the months column's window", () => {
    const col = { type: "rollup", rollup: { ...sum, byMonth: "eta" }, horizon: 2 } as Column
    expect(isMonthly(col)).toBe(true)
    expect(isMonthly({ type: "rollup", rollup: sum } as Column)).toBe(false)
    expect(monthWindow(col, "2026-11")).toEqual(["2026-11", "2026-12"])
  })

  it("a write naming a rollup is refused with a clear message", () => {
    const cols = [{ key: "ordered", label: "Ordered", type: "rollup", rollup: sum } as Column]
    expect(() => validateCells(cols, { ordered: 3 }, { full: false, members: new Set() })).toThrow(
      /rollup column.*cannot be written/,
    )
  })
})

describe("rollupIndex and joinRollup", () => {
  const docs = [
    { id: "l1", data: { part: link("a"), qty: 10, eta: "2026-11-05" } },
    { id: "l2", data: { part: link("a"), qty: 5, eta: "2026-12-20" } },
    { id: "l3", data: { part: link("a"), qty: 2.5, eta: "2026-11-30" } },
    { id: "l4", data: { part: link("b"), qty: 7 } },
    { id: "l5", data: { part: link("b"), qty: "n/a", eta: "2026-11-01" } },
    { id: "l6", data: { qty: 99 } },
  ]

  it("sums the value per linked row, skipping rows without a number or a link", () => {
    const idx = rollupIndex(sum, docs)
    expect(idx.get("a")).toBe(17.5)
    expect(idx.get("b")).toBe(7)
    expect(idx.size).toBe(2)
  })

  it("counts linked rows", () => {
    const idx = rollupIndex({ ...sum, agg: "count", value: null }, docs)
    expect(idx.get("a")).toBe(3)
    expect(idx.get("b")).toBe(2)
  })

  it("by month: one number per month of the date; a row without a date adds nothing", () => {
    const idx = rollupIndex({ ...sum, byMonth: "eta" }, docs)
    expect(idx.get("a")).toEqual({ "2026-11": 12.5, "2026-12": 5 })
    expect(idx.has("b")).toBe(false)
    const counted = rollupIndex({ ...sum, agg: "count", value: null, byMonth: "eta" }, docs)
    expect(counted.get("b")).toEqual({ "2026-11": 1 })
  })

  it("joins: a row no other row links reads 0, by month it stays empty", () => {
    const rows = [
      { id: "a", cells: {} },
      { id: "c", cells: {} },
    ]
    const col = { key: "ordered", type: "rollup", rollup: sum } as Column
    const joined = joinRollup(col, rollupIndex(sum, docs), rows)
    expect(joined.map((r) => r.cells.ordered)).toEqual([17.5, 0])
    const monthly = { ...col, rollup: { ...sum, byMonth: "eta" } } as Column
    const byMonth = joinRollup(monthly, rollupIndex(monthly.rollup!, docs), rows)
    expect(byMonth[0]!.cells.ordered).toEqual({ "2026-11": 12.5, "2026-12": 5 })
    expect("ordered" in byMonth[1]!.cells).toBe(false)
  })

  it("adds decimals without float noise", () => {
    const idx = rollupIndex(sum, [
      { id: "1", data: { part: link("a"), qty: 0.1 } },
      { id: "2", data: { part: link("a"), qty: 0.2 } },
    ])
    expect(idx.get("a")).toBe(0.3)
  })
})

describe("rollupProblem and rowLabel", () => {
  const other: Column[] = [
    { key: "lot", label: "Lot", type: "text" },
    {
      key: "part",
      label: "Part",
      type: "link",
      linkTo: { app: "kernel", entityType: "table_row", table: PARTS },
    },
    { key: "qty", label: "Qty", type: "number" },
    { key: "note", label: "Note", type: "text" },
    { key: "eta", label: "ETA", type: "date" },
  ]

  it("holds when the link points here, the value is a number and byMonth a date", () => {
    expect(rollupProblem({ ...sum, byMonth: "eta" }, PARTS, other)).toBeNull()
  })

  it("names what is wrong", () => {
    expect(rollupProblem(sum, LOTS, other)).toMatch(/pointing at this table's rows/)
    expect(rollupProblem({ ...sum, link: "lot" }, PARTS, other)).toMatch(/not a link column/)
    expect(rollupProblem({ ...sum, value: "note" }, PARTS, other)).toMatch(/number or amount/)
    expect(rollupProblem({ ...sum, byMonth: "qty" }, PARTS, other)).toMatch(/date column/)
  })

  it("a row's label is its first text column, else its id", () => {
    expect(rowLabel(other, "r1", { lot: "  Lot 7 ", note: "x" })).toBe("Lot 7")
    expect(rowLabel(other, "r1", { note: "x" })).toBe("r1")
  })
})
