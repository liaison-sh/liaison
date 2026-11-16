// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dashboard table's links to another table's rows, and its rollup columns.
//
// - A link column may point at the rows of a dashboard table: `linkTo {app:"kernel",
//   entityType:"table_row", table}`. A row link is read as the reader sees that table, under
//   their RLS: its label is the row's first text column now, a link to a row deleted since reads
//   `missing: true` (an unresolved link, never an error), and a reader who cannot read the table
//   sees the label hidden. Saving such a column needs that table readable by the saver.
// - A rollup column adds up (or counts) the rows of another table that link to each row of this
//   one: `rollup {table, link, value, agg, where?, byMonth?}`. Computed on every read, inside the
//   reader's transaction and under their RLS: a reader who cannot read the other table gets the
//   column empty with a column note. With `byMonth` (a date column of the other table) the cell
//   is months-shaped, `{"YYYY-MM": number}`, every month that has rows, shown in the window of
//   the column's horizon and fromOffset as a months column; else a number (0 when no row links).
// - Reading another table files it as the turn's taint origin, as a tables_query of it would.

import type { RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import {
  type Column,
  isRowLink,
  type LinkCell,
  type MonthsCell,
  ROW_LINK_ENTITY,
  type RollupDef,
} from "~/modules/dashboards/tables/columns"
import type { Where } from "~/modules/data-store/service"
import {
  allColumns,
  HIDDEN_LINK_LABEL,
  loadTable,
  readAllRows,
  TABLE_RESOURCE,
  TableError,
} from "./service"

/** The most rows of the other table one rollup or row-link read reads. */
export const ROLLUP_MAX_ROWS = 10_000

type Doc = { id: string; data: Record<string, unknown> }
export type RollupCell = number | MonthsCell

const round = (n: number) => Math.round(n * 1e9) / 1e9

/** The row id a link cell of the other table points at, or null. */
function linkedId(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const id = (v as { id?: unknown }).id
  return typeof id === "string" && id !== "" ? id : null
}

/**
 * Each linked row's result from the other table's rows: a count or a sum of `value`, by month of
 * `byMonth` when set (a row without that date, or without a number to add, adds nothing).
 */
export function rollupIndex(def: RollupDef, docs: readonly Doc[]): Map<string, RollupCell> {
  const totals = new Map<string, number>()
  const months = new Map<string, Record<string, number>>()
  for (const d of docs) {
    const id = linkedId(d.data[def.link])
    if (id === null) continue
    let n = 1
    if (def.agg === "sum") {
      const v = def.value ? d.data[def.value] : undefined
      if (typeof v !== "number" || !Number.isFinite(v)) continue
      n = v
    }
    if (def.byMonth) {
      const day = d.data[def.byMonth]
      if (typeof day !== "string" || !/^\d{4}-\d{2}/.test(day)) continue
      const month = day.slice(0, 7)
      const m = months.get(id) ?? {}
      m[month] = round((m[month] ?? 0) + n)
      months.set(id, m)
    } else totals.set(id, round((totals.get(id) ?? 0) + n))
  }
  if (!def.byMonth) return totals
  const out = new Map<string, RollupCell>()
  for (const [id, m] of months) {
    out.set(
      id,
      Object.fromEntries(
        Object.keys(m)
          .sort()
          .map((k) => [k, m[k]!]),
      ),
    )
  }
  return out
}

/** Each row with the rollup's cell: a number (0 when no row links), a by-month map when some do. */
export function joinRollup<R extends { id: string; cells: Record<string, unknown> }>(
  column: Column,
  index: ReadonlyMap<string, RollupCell>,
  rows: readonly R[],
): R[] {
  const byMonth = !!column.rollup?.byMonth
  return rows.map((r) => {
    const v = index.get(r.id) ?? (byMonth ? undefined : 0)
    if (v === undefined) return r
    return { ...r, cells: { ...r.cells, [column.key]: v } }
  })
}

/** The column a row link reads as its label: the table's first text column. */
export function labelColumn(columns: readonly Column[]): Column | undefined {
  return columns.find((c) => c.type === "text")
}

/** A row's label as a link to it shows it: its first text column, else its id. */
export function rowLabel(columns: readonly Column[], id: string, data: Record<string, unknown>) {
  const col = labelColumn(columns)
  const v = col ? data[col.key] : undefined
  return typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 200) : id
}

/** Why the other table cannot be read for a rollup, as the column note says it. */
function unreadable(table: string): string {
  return `you cannot read the table ${table} this column adds up`
}

type Loaded = Awaited<ReturnType<typeof loadTable>>

/** The other table under the reader's RLS, or null when they cannot read it. */
async function loadOther(t: RlsClient, viewer: UserContext, id: string): Promise<Loaded | null> {
  try {
    return await loadTable(t, viewer, id)
  } catch (err) {
    if (err instanceof TableError && (err.code === "not_found" || err.code === "forbidden")) {
      return null
    }
    throw err
  }
}

/** What is wrong with a rollup against the other table's columns now, or null. */
export function rollupProblem(
  def: RollupDef,
  tableId: string,
  other: readonly Column[],
): string | null {
  const link = other.find((c) => c.key === def.link)
  if (!link || !isRowLink(link) || link.linkTo?.table !== tableId) {
    return `'${def.link}' is not a link column of the table ${def.table} pointing at this table's rows`
  }
  if (def.value !== null) {
    const v = other.find((c) => c.key === def.value)
    if (!v || (v.type !== "number" && v.type !== "amount")) {
      return `'${def.value}' is not a number or amount column of the table ${def.table}`
    }
  }
  if (def.byMonth) {
    const d = other.find((c) => c.key === def.byMonth)
    if (d?.type !== "date") {
      return `'${def.byMonth}' is not a date column of the table ${def.table}`
    }
  }
  return null
}

function whereOf(def: RollupDef): Where | undefined {
  return def.where && Object.keys(def.where).length ? (def.where as Where) : undefined
}

/** Files the other table as a taint origin of the calling turn (as reading it would). */
function recordRead(table: string): void {
  currentRunContext()?.turnScopeAccumulator?.recordOriginRows(TABLE_RESOURCE, [table])
}

async function readRollup(
  t: RlsClient,
  viewer: UserContext,
  tableId: string,
  def: RollupDef,
): Promise<
  { ok: true; index: Map<string, RollupCell>; note?: string } | { ok: false; note: string }
> {
  const other = await loadOther(t, viewer, def.table)
  if (!other) return { ok: false, note: unreadable(def.table) }
  const problem = rollupProblem(def, tableId, allColumns(other))
  if (problem) return { ok: false, note: problem }
  const where = whereOf(def)
  let read: Awaited<ReturnType<typeof readAllRows>>
  try {
    read = await readAllRows(t, viewer, other, {
      ...(where ? { where } : {}),
      max: ROLLUP_MAX_ROWS,
    })
  } catch (err) {
    if (err instanceof TableError) return { ok: false, note: err.message }
    throw err
  }
  recordRead(def.table)
  const index = rollupIndex(def, read.docs)
  return read.truncated
    ? { ok: true, index, note: `only the first ${ROLLUP_MAX_ROWS} rows of the other table count` }
    : { ok: true, index }
}

/** Each row link of `column` as the reader sees it now: its row's label, or `missing: true`. */
async function resolveRowLinks<R extends { cells: Record<string, unknown> }>(
  t: RlsClient,
  viewer: UserContext,
  column: Column,
  rows: readonly R[],
): Promise<R[]> {
  const ids = new Set<string>()
  for (const r of rows) {
    const id = linkedId(r.cells[column.key])
    if (id) ids.add(id)
  }
  if (ids.size === 0) return [...rows]
  const target = column.linkTo?.table ?? ""
  const other = await loadOther(t, viewer, target)
  let labels: Map<string, string> | null = null
  let complete = false
  if (other) {
    const read = await readAllRows(t, viewer, other, { max: ROLLUP_MAX_ROWS })
    recordRead(target)
    const cols = allColumns(other)
    labels = new Map(read.docs.map((d) => [d.id, rowLabel(cols, d.id, d.data)]))
    complete = !read.truncated
  }
  return rows.map((r) => {
    const v = r.cells[column.key]
    const id = linkedId(v)
    if (!id) return r
    const link = v as LinkCell
    let next: LinkCell & { missing?: true }
    if (!labels) next = { ...link, label: HIDDEN_LINK_LABEL }
    else if (labels.has(id)) next = { ...link, label: labels.get(id)! }
    else if (complete) next = { ...link, missing: true }
    else return r
    return { ...r, cells: { ...r.cells, [column.key]: next } }
  })
}

/**
 * The rows with their row links resolved and every rollup column's cells in, read in `t` under
 * the reader's RLS, and a note per rollup column that could not be read (its cells stay empty).
 */
export async function applyTableLinks<R extends { id: string; cells: Record<string, unknown> }>(
  t: RlsClient,
  viewer: UserContext,
  tableId: string,
  columns: readonly Column[],
  rows: readonly R[],
): Promise<{ rows: R[]; notes: Record<string, string> }> {
  let out = [...rows]
  const notes: Record<string, string> = {}
  if (out.length === 0) return { rows: out, notes }
  for (const c of columns) {
    if (isRowLink(c)) out = await resolveRowLinks(t, viewer, c, out)
  }
  for (const c of columns) {
    if (c.type !== "rollup" || !c.rollup) continue
    const read = await readRollup(t, viewer, tableId, c.rollup)
    if (!read.ok) {
      notes[c.key] = read.note
      continue
    }
    if (read.note) notes[c.key] = read.note
    out = joinRollup(c, read.index, out)
  }
  return { rows: out, notes }
}

/** Does the table have a column this module computes or resolves? */
export function hasTableLinks(columns: readonly Column[]): boolean {
  return columns.some((c) => c.type === "rollup" || isRowLink(c))
}

/**
 * Refuses, at save, a row-link column whose table the saver cannot read and a rollup column that
 * does not hold: its table readable, its link column pointing at this table's rows, its value a
 * number or amount column, its byMonth a date column, its where a valid filter of that table.
 * Only the columns `before` does not hold as they are. `tableId` is null on a create: no table
 * links to a table that does not exist yet, so a rollup is added once it does.
 */
export async function checkTableLinks(
  t: RlsClient,
  viewer: UserContext,
  tableId: string | null,
  columns: readonly Column[],
  before: readonly Column[],
): Promise<void> {
  for (const c of columns) {
    const was = before.find((b) => b.key === c.key)
    if (isRowLink(c)) {
      if (was && JSON.stringify(was.linkTo) === JSON.stringify(c.linkTo)) continue
      const target = c.linkTo?.table ?? ""
      if (target !== tableId && !(await loadOther(t, viewer, target))) {
        throw new TableError(
          "invalid_request",
          `column '${c.key}': no table ${target} you can read`,
          { column: c.key },
        )
      }
      continue
    }
    if (c.type !== "rollup" || !c.rollup) continue
    if (was && JSON.stringify(was.rollup) === JSON.stringify(c.rollup)) continue
    const def = c.rollup
    const refuse = (why: string): never => {
      throw new TableError("invalid_request", `column '${c.key}': ${why}`, { column: c.key })
    }
    if (tableId === null) {
      refuse(
        "a rollup adds up rows that link to this table: create the table, add the link column to the other table, then add the rollup with alter",
      )
    }
    const other = await loadOther(t, viewer, def.table)
    if (!other) refuse(unreadable(def.table))
    const problem = rollupProblem(def, tableId ?? "", allColumns(other!))
    if (problem) refuse(problem)
    const where = whereOf(def)
    if (where) {
      try {
        await readAllRows(t, viewer, other!, { where, max: 1 })
      } catch (err) {
        if (err instanceof TableError) refuse(`rollup.where: ${err.message}`)
        throw err
      }
    }
  }
}

export { ROW_LINK_ENTITY }
