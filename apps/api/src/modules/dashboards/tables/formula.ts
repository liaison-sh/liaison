// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dashboard table's formula columns: a read-only cell computed on every read from the row's
// other computed cell values (its own cells, then lookup values; any column whose value is a
// number or a months map {"YYYY-MM": number}). Parsed by the dashboards' expression grammar
// (expr.ts), never evaluated as code, plus `cumsum(x)`, a running sum across the months window.
//
// - Shape: a formula is months-shaped when it reads a months-shaped column or calls cumsum; its
//   cell is then a months map over ITS window (horizon, fromOffset, as a months column), computed
//   month by month, scalars broadcast to every month. Else its cell is one number.
// - Empty values: an empty number operand (a number cell nobody filled, a lookup with no match)
//   makes the result empty, so a missing figure never reads as a wrong one. Inside a months
//   operand, a month without a value counts as 0 (an empty months cell is all zeros): a month
//   nobody planned anything for adds nothing.
// - A division by zero, or a non-finite result, empties that value (that month of a months
//   result); cumsum carries an empty month forward (every later month is empty too).
// - Refused at save (formulaProblems): a syntax error, a key that is not a column of this table,
//   a column that is not a number, cycles among formulas.
import type { ExprFunction, ExprNode } from "~/modules/dashboards/expr"
import { ExprError, parseExpr } from "~/modules/dashboards/expr"
import type { Column, MonthsCell } from "~/modules/dashboards/tables/columns"

const FORMULA_FUNCTIONS: readonly ExprFunction[] = ["cumsum"]

/** The shape of a computed value a formula reads: one number, or one number per month. */
export type ValueShape = "number" | "months"

/** A formula's expression as parsed: the typographic operators read as their ASCII ones. */
export function parseFormula(expr: string): ExprNode {
  return parseExpr(expr.replace(/×/g, "*").replace(/÷/g, "/").replace(/[−–]/g, "-"), {
    functions: FORMULA_FUNCTIONS,
  })
}

function namesOf(n: ExprNode, out: Set<string> = new Set()): Set<string> {
  switch (n.k) {
    case "name":
      out.add(n.name)
      break
    case "neg":
      namesOf(n.x, out)
      break
    case "bin":
      namesOf(n.a, out)
      namesOf(n.b, out)
      break
    case "call":
      for (const a of n.args) namesOf(a, out)
      break
    case "num":
      break
  }
  return out
}

function callsCumsum(n: ExprNode): boolean {
  switch (n.k) {
    case "neg":
      return callsCumsum(n.x)
    case "bin":
      return callsCumsum(n.a) || callsCumsum(n.b)
    case "call":
      return n.fn === "cumsum" || n.args.some(callsCumsum)
    default:
      return false
  }
}

/** The column keys a formula reads (empty when it does not parse). */
export function formulaNames(expr: string): string[] {
  try {
    return [...namesOf(parseFormula(expr))]
  } catch (err) {
    if (err instanceof ExprError) return []
    throw err
  }
}

/**
 * The shape of a column's value as a formula operand, or null for a column a formula cannot read
 * (text, a date, a choice...). A formula's own shape follows its operands (`seen` guards cycles).
 */
export function operandShape(
  col: Column,
  byKey: ReadonlyMap<string, Column>,
  seen: ReadonlySet<string> = new Set(),
): ValueShape | null {
  switch (col.type) {
    case "number":
    case "amount":
      return "number"
    case "lookup":
      return col.lookup?.valueType === "number" ? "number" : null
    case "months":
      return "months"
    case "rollup":
      return col.rollup?.byMonth ? "months" : "number"
    case "formula":
      return formulaShape(col, byKey, seen)
    default:
      return null
  }
}

function formulaShape(
  col: Column,
  byKey: ReadonlyMap<string, Column>,
  seen: ReadonlySet<string>,
): ValueShape {
  if (!col.formula || seen.has(col.key)) return "number"
  let node: ExprNode
  try {
    node = parseFormula(col.formula.expr)
  } catch {
    return "number"
  }
  if (callsCumsum(node)) return "months"
  const next = new Set(seen).add(col.key)
  for (const name of namesOf(node)) {
    const o = byKey.get(name)
    if (o && operandShape(o, byKey, next) === "months") return "months"
  }
  return "number"
}

/** Is this formula column's cell a months map (it reads months or calls cumsum)? */
export function isMonthsFormula(col: Column, columns: readonly Column[]): boolean {
  if (col.type !== "formula") return false
  return operandShape(col, new Map(columns.map((c) => [c.key, c]))) === "months"
}

/** Why the table's formulas cannot be saved: one message per formula column at fault. */
export function formulaProblems(columns: readonly Column[]): { index: number; message: string }[] {
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const out: { index: number; message: string }[] = []
  const deps = new Map<string, string[]>()
  columns.forEach((c, index) => {
    if (c.type !== "formula" || !c.formula) return
    let node: ExprNode
    try {
      node = parseFormula(c.formula.expr)
    } catch (err) {
      if (!(err instanceof ExprError)) throw err
      out.push({ index, message: `formula of '${c.key}': ${err.message}` })
      return
    }
    const names = [...namesOf(node)]
    for (const name of names) {
      const o = byKey.get(name)
      if (!o) {
        out.push({
          index,
          message: `formula of '${c.key}': '${name}' is not a column of this table`,
        })
      } else if (name === c.key) {
        out.push({ index, message: `formula of '${c.key}' reads itself` })
      } else if (operandShape(o, byKey) === null) {
        out.push({
          index,
          message: `formula of '${c.key}': '${name}' is a ${o.type} column, not a number (a formula reads number, amount, number lookup, rollup, months and formula columns)`,
        })
      }
    }
    deps.set(
      c.key,
      names.filter((n) => byKey.get(n)?.type === "formula" && n !== c.key),
    )
  })
  const cycle = formulaCycle(deps)
  if (cycle) {
    const index = columns.findIndex((c) => c.key === cycle[0])
    out.push({
      index,
      message: `formulas read each other in a circle: ${[...cycle, cycle[0]].join(" -> ")}`,
    })
  }
  return out
}

/** A cycle among formulas (the keys in order), or null. */
function formulaCycle(deps: ReadonlyMap<string, string[]>): string[] | null {
  const state = new Map<string, "open" | "done">()
  const path: string[] = []
  const visit = (k: string): string[] | null => {
    if (state.get(k) === "done") return null
    if (state.get(k) === "open") return path.slice(path.indexOf(k))
    state.set(k, "open")
    path.push(k)
    for (const d of deps.get(k) ?? []) {
      const found = visit(d)
      if (found) return found
    }
    path.pop()
    state.set(k, "done")
    return null
  }
  for (const k of deps.keys()) {
    const found = visit(k)
    if (found) return found
  }
  return null
}

/** The formula columns in an order where each comes after the formulas it reads (a cycle, which a
 *  save refuses, leaves its columns out: they read as empty). */
export function formulaOrder(columns: readonly Column[]): Column[] {
  const formulas = new Map(
    columns.filter((c) => c.type === "formula" && c.formula).map((c) => [c.key, c]),
  )
  const out: Column[] = []
  const state = new Map<string, "open" | "done" | "cycle">()
  const visit = (k: string): boolean => {
    const s = state.get(k)
    if (s === "done") return true
    if (s === "open" || s === "cycle") return false
    state.set(k, "open")
    const col = formulas.get(k)!
    const ok = formulaNames(col.formula!.expr)
      .filter((n) => formulas.has(n))
      .every((n) => n !== k && visit(n))
    state.set(k, ok ? "done" : "cycle")
    if (ok) out.push(col)
    return ok
  }
  for (const k of formulas.keys()) visit(k)
  return out
}

/** A value while computing: one number, or one per month of the window (null: empty). */
type Val = { s: number | null } | { m: (number | null)[] }

const fin = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : x)

function lift(a: Val, b: Val, window: number, f: (x: number, y: number) => number | null): Val {
  const at = (v: Val, i: number) => ("s" in v ? v.s : (v.m[i] ?? null))
  const op = (x: number | null, y: number | null) =>
    x === null || y === null ? null : fin(f(x, y))
  if ("s" in a && "s" in b) return { s: op(a.s, b.s) }
  return { m: Array.from({ length: window }, (_, i) => op(at(a, i), at(b, i))) }
}

function map1(v: Val, f: (x: number) => number): Val {
  const g = (x: number | null) => (x === null ? null : fin(f(x)))
  return "s" in v ? { s: g(v.s) } : { m: v.m.map(g) }
}

/** A computed cell value as an operand: a months map over the window (a missing month is 0). */
function operand(value: unknown, shape: ValueShape, months: readonly string[]): Val {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const map = value as Record<string, unknown>
    return {
      m: months.map((k) => {
        const n = map[k]
        return typeof n === "number" && Number.isFinite(n) ? n : 0
      }),
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) return { s: value }
  return shape === "months" ? { m: months.map(() => 0) } : { s: null }
}

function evalNode(
  n: ExprNode,
  cells: Readonly<Record<string, unknown>>,
  shapes: ReadonlyMap<string, ValueShape>,
  months: readonly string[],
): Val {
  const w = months.length
  switch (n.k) {
    case "num":
      return { s: n.v }
    case "name":
      return operand(cells[n.name], shapes.get(n.name) ?? "number", months)
    case "neg":
      return map1(evalNode(n.x, cells, shapes, months), (x) => -x)
    case "bin": {
      const a = evalNode(n.a, cells, shapes, months)
      const b = evalNode(n.b, cells, shapes, months)
      switch (n.op) {
        case "+":
          return lift(a, b, w, (x, y) => x + y)
        case "-":
          return lift(a, b, w, (x, y) => x - y)
        case "*":
          return lift(a, b, w, (x, y) => x * y)
        case "/":
          return lift(a, b, w, (x, y) => (y === 0 ? null : x / y))
      }
      return { s: null }
    }
    case "call": {
      const args = n.args.map((a) => evalNode(a, cells, shapes, months))
      switch (n.fn) {
        case "cumsum": {
          const v = args[0]!
          let sum: number | null = 0
          return {
            m: months.map((_, i) => {
              const x = "s" in v ? v.s : (v.m[i] ?? null)
              sum = sum === null || x === null ? null : fin(sum + x)
              return sum
            }),
          }
        }
        case "abs":
          return map1(args[0]!, Math.abs)
        case "round": {
          const d =
            args[1] && "s" in args[1] ? Math.max(0, Math.min(6, Math.trunc(args[1].s ?? 0))) : 0
          const f = 10 ** d
          return map1(args[0]!, (x) => Math.round(x * f) / f)
        }
        case "min":
        case "max": {
          const pick = n.fn === "min" ? Math.min : Math.max
          return args.slice(1).reduce((acc, v) => lift(acc, v, w, (x, y) => pick(x, y)), args[0]!)
        }
      }
    }
  }
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6

/**
 * One formula cell: from the row's computed cell values (`cells`, every column computed before
 * it), the operands' shapes, and the formula's window (its months, used when months-shaped).
 * A number, a months map of the months that have a value, or null (empty).
 */
export function evaluateFormula(
  node: ExprNode,
  cells: Readonly<Record<string, unknown>>,
  shapes: ReadonlyMap<string, ValueShape>,
  months: readonly string[],
  shape: ValueShape,
): number | MonthsCell | null {
  const v = evalNode(node, cells, shapes, months)
  if (shape === "number") {
    if (!("s" in v)) return null
    return v.s === null ? null : round6(v.s)
  }
  const series = "s" in v ? months.map(() => v.s) : v.m
  const out: MonthsCell = {}
  months.forEach((k, i) => {
    const x = series[i]
    if (x !== null && x !== undefined) out[k] = round6(x)
  })
  return Object.keys(out).length ? out : null
}

/**
 * Each row's cells with every formula column's value in, computed in dependency order from the
 * row's computed cell values (own cells, lookups, and any later computed kind: a value that is a
 * number or a months map). `windowOf` gives a months-shaped formula's months.
 */
export function applyFormulas<R extends { cells: Record<string, unknown> }>(
  columns: readonly Column[],
  rows: readonly R[],
  windowOf: (col: Column) => string[],
): R[] {
  const order = formulaOrder(columns)
  if (order.length === 0) return [...rows]
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const shapes = new Map<string, ValueShape>()
  for (const c of columns) {
    const s = operandShape(c, byKey)
    if (s) shapes.set(c.key, s)
  }
  const plans = order.map((col) => {
    const shape = shapes.get(col.key) ?? "number"
    return {
      col,
      node: parseFormula(col.formula!.expr),
      shape,
      months: shape === "months" ? windowOf(col) : [],
    }
  })
  return rows.map((r) => {
    const cells = { ...r.cells }
    for (const p of plans) {
      // A stored value under a formula's key (from before it was one) is never read.
      delete cells[p.col.key]
      const v = evaluateFormula(p.node, cells, shapes, p.months, p.shape)
      if (v !== null) cells[p.col.key] = v
    }
    return { ...r, cells }
  })
}
