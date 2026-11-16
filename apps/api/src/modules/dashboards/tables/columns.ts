// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dashboard table's columns and the check every cell write passes (S1): the same rules for a
// person's write and an agent's. Pure, except that a person cell names an org member, which the
// caller resolves (`personIds` -> the active members among them) and passes in.

import { z } from "zod"

export const COLUMN_TYPES = [
  "text",
  "number",
  "amount",
  "date",
  "choice",
  "choices",
  "checkbox",
  "person",
  "link",
  "months",
  "lookup",
  "rollup",
] as const
export type ColumnType = (typeof COLUMN_TYPES)[number]

export const MAX_COLUMNS = 40
export const MAX_CHOICES = 100
export const MAX_TEXT_CELL = 5_000
/** A months column's horizon bounds and default (months shown from the first one). */
export const MAX_MONTHS_HORIZON = 12
export const DEFAULT_MONTHS_HORIZON = 3
/** Months one months cell keeps (the window's and older ones, for history). */
export const MAX_MONTHS_PER_CELL = 120
export const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/
export const EMPHASIS = ["nonzero", "negative"] as const
export type Emphasis = (typeof EMPHASIS)[number]
/** Column types that may draw a cell with emphasis. */
export const EMPHASIS_TYPES: readonly ColumnType[] = ["number", "amount", "months", "rollup"]
/** Column types a dashboard table has but a project's task fields do not. */
export const TABLE_ONLY_TYPES: readonly ColumnType[] = ["months", "lookup", "rollup"]
export const COLUMN_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/
/** Keys a row read adds beside the cells: never a column key. */
export const RESERVED_COLUMN_KEYS = ["id", "updated_at", "updated_by", "created_at"] as const

export interface LinkTo {
  app: string
  entityType?: string
  /** A link to the rows of a dashboard table (`app: "kernel"`, `entityType: "table_row"`): its id. */
  table?: string
}

/** The app and entity type of a link to a dashboard table's row (its `linkTo.table` names the table). */
export const ROW_LINK_APP = "kernel"
export const ROW_LINK_ENTITY = "table_row"

/** Does this link column point at the rows of a dashboard table? */
export function isRowLink(c: Pick<Column, "type" | "linkTo">): boolean {
  return c.type === "link" && c.linkTo?.entityType === ROW_LINK_ENTITY && !!c.linkTo.table
}

/** A rollup column: the rows of another table that link to a row, added up or counted. */
export interface RollupDef {
  /** The other table. */
  table: string
  /** Its link column pointing at this table's rows. */
  link: string
  /** Its number or amount column to add up; null counts the rows. */
  value: string | null
  agg: "sum" | "count"
  /** Only its rows matching this (the where of tables_query). */
  where?: Record<string, unknown>
  /** Its date column: the result by month, `{"YYYY-MM": number}`, as a months column shows it. */
  byMonth?: string
}

/** Where a lookup column's cells come from: one read of an app's tool, joined to the rows. */
export interface LookupDef {
  /** The read, as a dashboard tool source: `<app>:<tool>`, its params, where its rows are. */
  source: { tool: string; params?: Record<string, unknown>; rowsPath?: string }
  /** A tool row matches a table row when its `field` equals the row's `on` cell (a link by id). */
  match: { field: string; on: string }
  /** The path in the matched tool row the cell shows. */
  value: string
  valueType: "number" | "text"
}

export interface Column {
  key: string
  label: string
  type: ColumnType
  required?: boolean
  choices?: string[]
  /** A backed choice column's colours by choice (a project's status colours), from its provider:
   *  the grid draws each choice as a pill of its colour. Never set on a table's own columns. */
  choiceColors?: Record<string, string>
  /** A backed date column that is a deadline (a task's due date), from its provider: the grid
   *  tints a past or near one. Never set on a table's own columns. */
  deadline?: boolean
  currency?: string
  linkTo?: LinkTo
  /** A months column: how many months it shows (1-12, default 3). */
  horizon?: number
  /** A months column: 0 starts at the current month (the default), 1 at the next one. */
  fromOffset?: 0 | 1
  /** A number, amount or months column: draw a value bold in the accent colour when it is not
   *  zero (`nonzero`) or below zero (`negative`). */
  emphasis?: Emphasis
  /** A lookup column's read (read-only, live: tables/lookup.ts). */
  lookup?: LookupDef
  /** A rollup column's definition (read-only, computed on read: tables/rollup.ts). */
  rollup?: RollupDef
}

/** A months cell as stored and read: one number per month, `YYYY-MM` keys. */
export type MonthsCell = Record<string, number>

export interface LinkCell {
  app: string
  entityType: string
  id: string
  label: string
}

const APP_RE = /^[a-z][a-z0-9_-]{0,62}$/
const ENTITY_RE = /^[a-z][a-zA-Z0-9_-]{0,62}$/

/** A field of a tool row: a key, or a dotted path into nested objects (as dashboard sources). */
const fieldPath = z
  .string()
  .max(200)
  .regex(
    /^[A-Za-z_$][A-Za-z0-9_$-]*(\.[A-Za-z0-9_$-]+)*$/,
    "a path is a key or a dotted path such as inventory.on_hand",
  )

/** The most lookup columns a table has: each is one tool read per table read. */
export const MAX_LOOKUP_COLUMNS = 5
/** The most rollup columns a table has: each reads the rows of another table on every read. */
export const MAX_ROLLUP_COLUMNS = 5

const columnKey = z.string().regex(COLUMN_KEY_RE, "the key of a column of the other table")

export const rollupSchema = z
  .object({
    table: z.string().uuid("the id of a dashboard table"),
    link: columnKey,
    value: columnKey.nullable(),
    agg: z.enum(["sum", "count"]),
    where: z.record(z.string(), z.unknown()).optional(),
    byMonth: columnKey.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.agg === "sum" && r.value === null) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "a sum names the number column it adds up (value)",
      })
    }
    if (r.agg === "count" && r.value !== null) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "a count has value null" })
    }
  })

/** Is this column months-shaped (a months column, or a rollup by month)? */
export function isMonthly(c: Pick<Column, "type" | "rollup">): boolean {
  return c.type === "months" || (c.type === "rollup" && !!c.rollup?.byMonth)
}

export const lookupSchema = z
  .object({
    source: z
      .object({
        tool: z
          .string()
          .max(200)
          .regex(/^[a-z][a-z0-9_-]*:[A-Za-z0-9_.-]+$/, "a tool is named <app>:<tool>"),
        params: z.record(z.string(), z.unknown()).optional(),
        rowsPath: fieldPath.optional(),
      })
      .strict(),
    match: z
      .object({
        field: fieldPath,
        on: z.string().regex(COLUMN_KEY_RE, "the key of a column of this table"),
      })
      .strict(),
    value: fieldPath,
    valueType: z.enum(["number", "text"]),
  })
  .strict()

const choiceList = z
  .array(z.string().trim().min(1).max(80))
  .min(1)
  .max(MAX_CHOICES)
  .refine((c) => new Set(c).size === c.length, "choices are unique")

export const columnSchema = z
  .object({
    key: z
      .string()
      .regex(COLUMN_KEY_RE, "a column key is a lowercase letter then up to 39 a-z, 0-9 or _")
      .refine((k) => !(RESERVED_COLUMN_KEYS as readonly string[]).includes(k), {
        message: `id, updated_at, updated_by and created_at are reserved`,
      }),
    label: z.string().trim().min(1).max(80),
    type: z.enum(COLUMN_TYPES),
    required: z.boolean().optional(),
    choices: choiceList.optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, "an ISO 4217 code such as EUR")
      .optional(),
    linkTo: z
      .object({
        app: z.string().regex(APP_RE, "an app name"),
        entityType: z.string().regex(ENTITY_RE, "an entity type").optional(),
        table: z.string().uuid("the id of a dashboard table").optional(),
      })
      .strict()
      .optional(),
    horizon: z.number().int().min(1).max(MAX_MONTHS_HORIZON).optional(),
    fromOffset: z.union([z.literal(0), z.literal(1)]).optional(),
    emphasis: z.enum(EMPHASIS).optional(),
    lookup: lookupSchema.optional(),
    rollup: rollupSchema.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const needsChoices = c.type === "choice" || c.type === "choices"
    if (needsChoices && !c.choices) {
      ctx.addIssue({
        code: "custom",
        path: ["choices"],
        message: `a ${c.type} column lists its choices`,
      })
    }
    if (!needsChoices && c.choices) {
      ctx.addIssue({
        code: "custom",
        path: ["choices"],
        message: "only a choice column has choices",
      })
    }
    if (c.type === "amount" && !c.currency) {
      ctx.addIssue({
        code: "custom",
        path: ["currency"],
        message: "an amount column names its currency",
      })
    }
    if (c.type !== "amount" && c.currency) {
      ctx.addIssue({
        code: "custom",
        path: ["currency"],
        message: "only an amount column has a currency",
      })
    }
    if (c.type !== "link" && c.linkTo) {
      ctx.addIssue({ code: "custom", path: ["linkTo"], message: "only a link column has linkTo" })
    }
    const rowLinkShape = c.linkTo?.app === ROW_LINK_APP && c.linkTo.entityType === ROW_LINK_ENTITY
    if (c.linkTo && rowLinkShape !== (c.linkTo.table !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["linkTo", "table"],
        message: `a link to a table's rows is linkTo {app:"${ROW_LINK_APP}", entityType:"${ROW_LINK_ENTITY}", table:<table id>}`,
      })
    }
    if (!isMonthly(c) && (c.horizon !== undefined || c.fromOffset !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [c.horizon !== undefined ? "horizon" : "fromOffset"],
        message: "only a months column or a rollup by month has horizon and fromOffset",
      })
    }
    if (c.type === "months" && c.required) {
      // Filled month by month in the grid: a row is added first, its months typed after.
      ctx.addIssue({
        code: "custom",
        path: ["required"],
        message: "a months column is never required",
      })
    }
    if (c.emphasis && !EMPHASIS_TYPES.includes(c.type)) {
      ctx.addIssue({
        code: "custom",
        path: ["emphasis"],
        message: "only a number, amount, months or rollup column has emphasis",
      })
    }
    if (c.type === "lookup" && !c.lookup) {
      ctx.addIssue({
        code: "custom",
        path: ["lookup"],
        message: "a lookup column names its read: lookup {source, match, value, valueType}",
      })
    }
    if (c.type !== "lookup" && c.lookup) {
      ctx.addIssue({ code: "custom", path: ["lookup"], message: "only a lookup column has lookup" })
    }
    if (c.type === "lookup" && c.required) {
      ctx.addIssue({
        code: "custom",
        path: ["required"],
        message: "a lookup column is read live: it cannot be required",
      })
    }
    if (c.type === "rollup" && !c.rollup) {
      ctx.addIssue({
        code: "custom",
        path: ["rollup"],
        message:
          "a rollup column names its rows: rollup {table, link, value, agg, where?, byMonth?}",
      })
    }
    if (c.type !== "rollup" && c.rollup) {
      ctx.addIssue({ code: "custom", path: ["rollup"], message: "only a rollup column has rollup" })
    }
    if (c.type === "rollup" && c.required) {
      ctx.addIssue({
        code: "custom",
        path: ["required"],
        message: "a rollup column is computed on read: it cannot be required",
      })
    }
  })

export const columnsSchema = z
  .array(columnSchema)
  .max(MAX_COLUMNS, `a table has at most ${MAX_COLUMNS} columns`)
  .superRefine((cols, ctx) => {
    const seen = new Set<string>()
    cols.forEach((c, i) => {
      if (seen.has(c.key)) {
        ctx.addIssue({ code: "custom", path: [i, "key"], message: `column '${c.key}' twice` })
      }
      seen.add(c.key)
    })
    const lookups = cols.filter((c) => c.type === "lookup")
    if (lookups.length > MAX_LOOKUP_COLUMNS) {
      ctx.addIssue({
        code: "custom",
        message: `a table has at most ${MAX_LOOKUP_COLUMNS} lookup columns`,
      })
    }
    if (cols.filter((c) => c.type === "rollup").length > MAX_ROLLUP_COLUMNS) {
      ctx.addIssue({
        code: "custom",
        message: `a table has at most ${MAX_ROLLUP_COLUMNS} rollup columns`,
      })
    }
    cols.forEach((c, i) => {
      if (!c.lookup) return
      const on = cols.find((o) => o.key === c.lookup?.match.on)
      // A key no own column has may be a backed table's read-through one (checked with them).
      if (on?.type === "lookup") {
        ctx.addIssue({
          code: "custom",
          path: [i, "lookup", "match", "on"],
          message: "a lookup matches on a column people or the app fill, not another lookup",
        })
      }
    })
  })

/** The first column of a type only a dashboard table has (never a project's task field). */
export function tableOnlyColumn(columns: Column[]): Column | undefined {
  return columns.find((c) => TABLE_ONLY_TYPES.includes(c.type))
}

/** A change to one column's display options (a table's `setOptions` column op). */
export const columnOptionsOpSchema = z
  .object({
    key: z.string(),
    horizon: z.number().int().min(1).max(MAX_MONTHS_HORIZON).optional(),
    fromOffset: z.union([z.literal(0), z.literal(1)]).optional(),
    emphasis: z.enum(EMPHASIS).nullable().optional(),
  })
  .strict()

/** A refused cell: the column it names and why. */
export class CellError extends Error {
  constructor(
    readonly column: string,
    readonly reason: string,
  ) {
    super(`column '${column}': ${reason}`)
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isValidDay(v: string): boolean {
  if (!DATE_RE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** Why a write naming a lookup column is refused. */
export const LOOKUP_READ_ONLY =
  "is a lookup column, read live from an app on every read: it cannot be written (change the record in its app)"

/** Why a write naming a rollup column is refused. */
export const ROLLUP_READ_ONLY =
  "is a rollup column, computed from another table's rows on every read: it cannot be written (change those rows)"

/** Why a write, filter or sort naming a computed column is refused, or null for a typed one. */
export function computedRefusal(col: Pick<Column, "type">): string | null {
  return col.type === "lookup" ? LOOKUP_READ_ONLY : col.type === "rollup" ? ROLLUP_READ_ONLY : null
}

/** An empty cell: null, an empty string or an empty list. */
export function isEmptyCell(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)
}

/**
 * The cell as stored, or a CellError. `null` means empty (the key is removed from the row).
 * Person cells are checked against `members` (the active org members among the ids written).
 */
export function normalizeCell(col: Column, value: unknown, members: ReadonlySet<string>): unknown {
  if (isEmptyCell(value)) return null
  switch (col.type) {
    case "text":
      if (typeof value !== "string") throw new CellError(col.key, "is text")
      if (value.length > MAX_TEXT_CELL) {
        throw new CellError(col.key, `is at most ${MAX_TEXT_CELL} characters`)
      }
      return value
    case "number":
    case "amount":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new CellError(col.key, "is a number")
      }
      return value
    case "date":
      if (typeof value !== "string" || !isValidDay(value)) {
        throw new CellError(col.key, "is a date YYYY-MM-DD")
      }
      return value
    case "checkbox":
      if (typeof value !== "boolean") throw new CellError(col.key, "is true or false")
      return value
    case "choice":
      if (typeof value !== "string" || !(col.choices ?? []).includes(value)) {
        throw new CellError(col.key, `is one of ${(col.choices ?? []).join(", ")}`)
      }
      return value
    case "choices": {
      if (!Array.isArray(value)) throw new CellError(col.key, "is a list of choices")
      const out: string[] = []
      for (const v of value) {
        if (typeof v !== "string" || !(col.choices ?? []).includes(v)) {
          throw new CellError(
            col.key,
            `'${String(v)}' is not one of ${(col.choices ?? []).join(", ")}`,
          )
        }
        if (!out.includes(v)) out.push(v)
      }
      return out
    }
    case "person":
      if (typeof value !== "string" || !members.has(value.toLowerCase())) {
        throw new CellError(col.key, "is a member of this organisation (a user id)")
      }
      return value.toLowerCase()
    case "lookup":
      throw new CellError(col.key, LOOKUP_READ_ONLY)
    case "rollup":
      throw new CellError(col.key, ROLLUP_READ_ONLY)
    case "link": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new CellError(col.key, "is a link {app, entityType, id, label}")
      }
      const v = value as Record<string, unknown>
      const extra = Object.keys(v).filter((k) => !["app", "entityType", "id", "label"].includes(k))
      if (extra.length) throw new CellError(col.key, `a link has no ${extra.join(", ")}`)
      if (typeof v.app !== "string" || !APP_RE.test(v.app)) {
        throw new CellError(col.key, "a link names its app")
      }
      if (typeof v.entityType !== "string" || !ENTITY_RE.test(v.entityType)) {
        throw new CellError(col.key, "a link names its entityType")
      }
      if (typeof v.id !== "string" || v.id.length === 0 || v.id.length > 200) {
        throw new CellError(col.key, "a link names the record's id")
      }
      if (typeof v.label !== "string" || v.label.trim() === "" || v.label.length > 200) {
        throw new CellError(col.key, "a link has a label of 1 to 200 characters")
      }
      if (col.linkTo) {
        if (v.app !== col.linkTo.app) {
          throw new CellError(col.key, `links a record of ${col.linkTo.app}`)
        }
        if (col.linkTo.entityType && v.entityType !== col.linkTo.entityType) {
          throw new CellError(col.key, `links a ${col.linkTo.entityType}`)
        }
      }
      return { app: v.app, entityType: v.entityType, id: v.id, label: v.label.trim() }
    }
    case "months":
      return normalizeMonths(col, value)
  }
}

/**
 * A months cell as written: `{"YYYY-MM": number | null}`, the months to change (a null month is
 * cleared). Merged into the stored cell by `applyCells`, so a write names only its months.
 */
function normalizeMonths(col: Column, value: unknown): Record<string, number | null> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CellError(col.key, 'is months {"YYYY-MM": number or null}')
  }
  const out: Record<string, number | null> = {}
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_MONTHS_PER_CELL) {
    throw new CellError(col.key, `holds at most ${MAX_MONTHS_PER_CELL} months`)
  }
  for (const [month, n] of entries) {
    if (!MONTH_KEY_RE.test(month)) {
      throw new CellError(col.key, `'${month}' is not a month YYYY-MM`)
    }
    if (n !== null && (typeof n !== "number" || !Number.isFinite(n))) {
      throw new CellError(col.key, `${month} is a number or null`)
    }
    out[month] = n
  }
  return out
}

/** The months a months column shows from `current` (YYYY-MM, the org's month), in order. */
export function monthWindow(
  col: Pick<Column, "horizon" | "fromOffset">,
  current: string,
): string[] {
  const y = Number(current.slice(0, 4))
  const m = Number(current.slice(5, 7)) - 1
  const start = col.fromOffset ?? 0
  const n = col.horizon ?? DEFAULT_MONTHS_HORIZON
  return Array.from({ length: n }, (_, i) => {
    const at = y * 12 + m + start + i
    return `${Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, "0")}`
  })
}

/** Merges a months write into the stored cell: a null month is cleared; null when none is left. */
export function mergeMonths(
  col: Column,
  current: unknown,
  patch: Record<string, number | null>,
): MonthsCell | null {
  const base =
    typeof current === "object" && current !== null && !Array.isArray(current)
      ? { ...(current as MonthsCell) }
      : {}
  for (const [month, n] of Object.entries(patch)) {
    if (n === null) delete base[month]
    else base[month] = n
  }
  const months = Object.keys(base).sort()
  if (months.length === 0) return null
  if (months.length > MAX_MONTHS_PER_CELL) {
    throw new CellError(col.key, `holds at most ${MAX_MONTHS_PER_CELL} months`)
  }
  return Object.fromEntries(months.map((k) => [k, base[k]!]))
}

/** The person ids a set of cells writes (to resolve against the org's members). */
export function personIdsIn(columns: Column[], cells: Record<string, unknown>): string[] {
  const out = new Set<string>()
  for (const col of columns) {
    const v = cells[col.key]
    if (col.type === "person" && typeof v === "string") out.add(v.toLowerCase())
  }
  return [...out]
}

/**
 * Checks `cells` against the columns: unknown keys refused, each value by its type, and (for a
 * new row, `full`) every required column filled; on an update a required column cannot be
 * emptied. Returns the cells as stored: a null value means "empty this cell".
 */
export function validateCells(
  columns: Column[],
  cells: unknown,
  opts: { full: boolean; members: ReadonlySet<string> },
): Record<string, unknown> {
  if (typeof cells !== "object" || cells === null || Array.isArray(cells)) {
    throw new CellError("*", "cells are an object {columnKey: value}")
  }
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(cells as Record<string, unknown>)) {
    const col = byKey.get(key)
    if (!col) throw new CellError(key, "is not a column of this table")
    const refused = computedRefusal(col)
    if (refused) throw new CellError(key, refused)
    const v = normalizeCell(col, value, opts.members)
    if (v === null && col.required) throw new CellError(key, "is required")
    out[key] = v
  }
  if (opts.full) {
    for (const col of columns) {
      if (col.required && (out[col.key] === undefined || out[col.key] === null)) {
        throw new CellError(col.key, "is required")
      }
    }
  }
  return out
}

/**
 * Applies validated cells to a row's stored data: a null cell is removed. A months cell replaces
 * the stored one, unless `merge` names the columns: then a months cell of one of them changes
 * only the months it names, a null month clearing one (a row write, an add included); an undo
 * writes a whole stored cell back, so it replaces.
 */
export function applyCells(
  current: Record<string, unknown>,
  cells: Record<string, unknown>,
  merge?: Column[],
): Record<string, unknown> {
  const next = { ...current }
  const byKey = new Map((merge ?? []).map((c) => [c.key, c]))
  for (const [k, v] of Object.entries(cells)) {
    const col = byKey.get(k)
    const value =
      v !== null && col?.type === "months"
        ? mergeMonths(col, current[k], v as Record<string, number | null>)
        : v
    if (value === null) delete next[k]
    else next[k] = value
  }
  return next
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** The keys whose value differs between two rows' data, in `keys` order. */
export function changedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((k) => !same(before[k], after[k])).sort()
}

/** The given keys' values (null when absent). */
export function pick(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, data[k] ?? null]))
}
