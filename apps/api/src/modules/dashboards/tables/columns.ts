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
] as const
export type ColumnType = (typeof COLUMN_TYPES)[number]

export const MAX_COLUMNS = 40
export const MAX_CHOICES = 100
export const MAX_TEXT_CELL = 5_000
export const COLUMN_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/
/** Keys a row read adds beside the cells: never a column key. */
export const RESERVED_COLUMN_KEYS = ["id", "updated_at", "updated_by", "created_at"] as const

export interface LinkTo {
  app: string
  entityType?: string
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
}

export interface LinkCell {
  app: string
  entityType: string
  id: string
  label: string
}

const APP_RE = /^[a-z][a-z0-9_-]{0,62}$/
const ENTITY_RE = /^[a-z][a-zA-Z0-9_-]{0,62}$/

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
      })
      .strict()
      .optional(),
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
  })

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
  }
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

/** Applies validated cells to a row's stored data: a null cell is removed. */
export function applyCells(
  current: Record<string, unknown>,
  cells: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current }
  for (const [k, v] of Object.entries(cells)) {
    if (v === null) delete next[k]
    else next[k] = v
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
