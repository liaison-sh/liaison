// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Formula columns (tables/formula.ts), pure: the save checks (syntax, unknown keys, non-number
// columns, cycles), the shape, and the evaluation from a row's computed cell values: months
// month by month with scalars broadcast, cumsum, empties and division by zero.

import { describe, expect, it } from "bun:test"
import { type Column, columnSchema, columnsSchema } from "~/modules/dashboards/tables/columns"
import {
  applyFormulas,
  formulaOrder,
  formulaProblems,
  isMonthsFormula,
} from "~/modules/dashboards/tables/formula"

const WINDOW = ["2026-11", "2026-12", "2027-01"]

const base: Column[] = [
  { key: "item", label: "Item", type: "text" },
  { key: "stock", label: "Stock", type: "number" },
  { key: "price", label: "Price", type: "amount", currency: "EUR" },
  { key: "expected", label: "Expected", type: "months" },
  {
    key: "sold",
    label: "Sold",
    type: "lookup",
    lookup: {
      source: { tool: "shop:orders" },
      match: { field: "sku", on: "item" },
      value: "qty",
      valueType: "number",
    },
  },
  {
    key: "supplier",
    label: "Supplier",
    type: "lookup",
    lookup: {
      source: { tool: "shop:orders" },
      match: { field: "sku", on: "item" },
      value: "vendor",
      valueType: "text",
    },
  },
]

const formula = (key: string, expr: string, extra: Partial<Column> = {}): Column => ({
  key,
  label: key,
  type: "formula",
  formula: { expr },
  ...extra,
})

function run(columns: Column[], cells: Record<string, unknown>): Record<string, unknown> {
  const [row] = applyFormulas(columns, [{ id: "r1", cells }], () => WINDOW)
  return row!.cells
}

describe("formula column: save checks", () => {
  it("accepts a formula over number, amount, number lookup, months and formula columns", () => {
    const cols = [
      ...base,
      formula("free", "stock - sold"),
      formula("projected", "free + cumsum(expected) * 1", { horizon: 3, emphasis: "negative" }),
      formula("value", "stock × price ÷ 2 − 1"),
    ]
    expect(formulaProblems(cols)).toEqual([])
    expect(columnsSchema.safeParse(cols).success).toBe(true)
  })

  it("refuses a syntax error, an unknown key, a text column and an unknown function", () => {
    const messages = (expr: string) =>
      formulaProblems([...base, formula("f", expr)]).map((p) => p.message)
    expect(messages("stock -")[0]).toContain("ends too early")
    expect(messages("stock + nope")[0]).toContain("'nope' is not a column of this table")
    expect(messages("stock + supplier")[0]).toContain("'supplier' is a lookup column, not a number")
    expect(messages("stock + item")[0]).toContain("'item' is a text column, not a number")
    expect(messages("sqrt(stock)")[0]).toContain("unknown function 'sqrt'")
    expect(messages("cumsum(stock, 2)")[0]).toContain("cumsum takes one value")
  })

  it("refuses formulas that read each other in a circle, and one that reads itself", () => {
    const cycle = formulaProblems([
      ...base,
      formula("a", "b + 1"),
      formula("b", "c"),
      formula("c", "a"),
    ])
    expect(cycle.map((p) => p.message)).toEqual([
      "formulas read each other in a circle: a -> b -> c -> a",
    ])
    expect(formulaProblems([...base, formula("a", "a + 1")])[0]?.message).toContain("reads itself")
    const parsed = columnsSchema.safeParse([...base, formula("a", "b"), formula("b", "a")])
    expect(parsed.success).toBe(false)
  })

  it("a formula column names its expression; horizon and emphasis are allowed, required is not", () => {
    expect(columnSchema.safeParse({ key: "f", label: "F", type: "formula" }).success).toBe(false)
    expect(
      columnSchema.safeParse({
        key: "f",
        label: "F",
        type: "formula",
        formula: { expr: "1" },
        required: true,
      }).success,
    ).toBe(false)
    expect(
      columnSchema.safeParse({ key: "n", label: "N", type: "number", formula: { expr: "1" } })
        .success,
    ).toBe(false)
    expect(
      columnSchema.safeParse({
        key: "f",
        label: "F",
        type: "formula",
        formula: { expr: "1" },
        horizon: 6,
        fromOffset: 1,
        emphasis: "negative",
      }).success,
    ).toBe(true)
  })

  it("orders formulas after the formulas they read", () => {
    const cols = [...base, formula("c", "b * 2"), formula("b", "a + 1"), formula("a", "stock")]
    expect(formulaOrder(cols).map((c) => c.key)).toEqual(["a", "b", "c"])
  })

  it("is months-shaped when it reads months (directly or through a formula) or calls cumsum", () => {
    const cols = [
      ...base,
      formula("a", "stock - sold"),
      formula("b", "a + expected"),
      formula("c", "cumsum(stock)"),
    ]
    expect(isMonthsFormula(cols[6]!, cols)).toBe(false)
    expect(isMonthsFormula(cols[7]!, cols)).toBe(true)
    expect(isMonthsFormula(cols[8]!, cols)).toBe(true)
  })
})

describe("formula column: evaluation", () => {
  it("computes a number from numbers, amounts and a number lookup", () => {
    const cols = [...base, formula("f", "(stock - sold) * price / 4")]
    expect(run(cols, { stock: 10, sold: 2, price: 3 }).f).toBe(6)
  })

  it("an empty number operand empties the result; a division by zero empties it", () => {
    const cols = [...base, formula("f", "stock - sold"), formula("g", "stock / sold")]
    const out = run(cols, { stock: 10 })
    expect(out.f).toBeUndefined()
    expect(run(cols, { stock: 10, sold: 0 }).g).toBeUndefined()
    expect(run(cols, { stock: 10, sold: 4 }).g).toBe(2.5)
  })

  it("projected stock: stock - sold + cumsum(expected), month by month over its window", () => {
    const cols = [...base, formula("projected", "stock - sold + cumsum(expected)")]
    const out = run(cols, {
      stock: 5,
      sold: 8,
      expected: { "2026-11": 10, "2027-01": 4, "2026-09": 99 },
    })
    // 2026-12 has no value: it counts 0. 2026-09 (outside the window) is not read.
    expect(out.projected).toEqual({ "2026-11": 7, "2026-12": 7, "2027-01": 11 })
  })

  it("an empty months cell counts as all zeros; scalars broadcast to every month", () => {
    const cols = [...base, formula("p", "stock + expected * 2")]
    expect(run(cols, { stock: 3 }).p).toEqual({ "2026-11": 3, "2026-12": 3, "2027-01": 3 })
  })

  it("an empty number in a months formula empties every month", () => {
    const cols = [...base, formula("p", "stock - sold + cumsum(expected)")]
    expect(run(cols, { sold: 1, expected: { "2026-11": 1 } }).p).toBeUndefined()
  })

  it("a division by zero empties only that month, and cumsum carries it forward", () => {
    const cols = [...base, formula("ratio", "stock / expected"), formula("run", "cumsum(ratio)")]
    const out = run(cols, { stock: 12, expected: { "2026-11": 4, "2027-01": 3 } })
    expect(out.ratio).toEqual({ "2026-11": 3, "2027-01": 4 })
    // The month without a value in ratio's map reads 0 in run (a months operand's missing month).
    expect(out.run).toEqual({ "2026-11": 3, "2026-12": 3, "2027-01": 7 })
    const direct = run([...base, formula("run", "cumsum(stock / expected)")], {
      stock: 12,
      expected: { "2026-11": 4, "2027-01": 3 },
    })
    expect(direct.run).toEqual({ "2026-11": 3 })
  })

  it("cumsum of a single number is a running total; min, max, abs and round work per month", () => {
    const cols = [
      ...base,
      formula("c", "cumsum(stock)"),
      formula("m", "max(expected - 2, 0)"),
      formula("r", "round(stock / 3, 2)"),
      formula("a", "abs(0 - stock)"),
    ]
    const out = run(cols, { stock: 2, expected: { "2026-11": 5, "2026-12": 1 } })
    expect(out.c).toEqual({ "2026-11": 2, "2026-12": 4, "2027-01": 6 })
    expect(out.m).toEqual({ "2026-11": 3, "2026-12": 0, "2027-01": 0 })
    expect(out.r).toBe(0.67)
    expect(out.a).toBe(2)
  })

  it("reads any computed value that is a number or a months map (a later computed kind)", () => {
    // The operands come from the row's computed cells: a months map under a formula's key works
    // whatever filled it.
    const cols = [...base, formula("a", "stock + 1"), formula("b", "a * 2")]
    expect(run(cols, { stock: 1 }).b).toBe(4)
  })

  it("never reads a value stored under the formula's own key", () => {
    const cols = [...base, formula("f", "stock + 1")]
    expect(run(cols, { stock: 1, f: 100 }).f).toBe(2)
    expect(run(cols, { f: 100 }).f).toBeUndefined()
  })
})
