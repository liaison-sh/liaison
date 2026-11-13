// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A table's cells as people read and type them: each column type's text, the value an editor's
// input becomes, the order of the add form (required columns first), what a change says
// ("Status: In production → In transit") and when a row last changed ("Nico · 4 min ago").
// Pure: the grid, the add form and the history panel all read them.
import {
  type LinkCell,
  RESERVED_COLUMN_KEYS,
  type TableCells,
  type TableChange,
  type TableColumn,
} from "../dashboards-client"
import { formatValue } from "./format"

export type T = (key: string, params?: Record<string, string | number>) => string

export interface CellTextOptions {
  locale: string
  /** A person cell's name, from its user id (the member directory). */
  personName?: (id: string) => string | undefined
  t: T
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** A choice's own colour (a backed status column's), hex only; null: a neutral pill. */
export function choiceColor(column: TableColumn, value: unknown): string | null {
  if (typeof value !== "string") return null
  const c = column.choiceColors?.[value]
  return typeof c === "string" && HEX.test(c) ? c : null
}

/** How near a deadline is, in whole days from `today` (both YYYY-MM-DD). */
export interface DeadlineState {
  tone: "late" | "soon" | null
  /** The track's fill, 0-1: full once late, filling over the last DEADLINE_SOON_DAYS days. */
  fill: number
}

/** Days before a deadline that it reads as near. */
export const DEADLINE_SOON_DAYS = 3

export function deadlineState(value: unknown, today: string): DeadlineState | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null
  const day = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))
  const left = Math.round((day(value) - day(today)) / 86_400_000)
  if (left < 0) return { tone: "late", fill: 1 }
  if (left <= DEADLINE_SOON_DAYS) {
    return { tone: "soon", fill: (DEADLINE_SOON_DAYS + 1 - left) / (DEADLINE_SOON_DAYS + 1) }
  }
  return { tone: null, fill: 0 }
}

/** Runs of consecutive columns from the same place (read through, or this table's own). */
export function columnBands(
  columns: TableColumn[],
  readThrough: (key: string) => boolean,
): Array<{ own: boolean; span: number }> {
  const out: Array<{ own: boolean; span: number }> = []
  for (const c of columns) {
    const own = !readThrough(c.key)
    const last = out[out.length - 1]
    if (last && last.own === own) last.span++
    else out.push({ own, span: 1 })
  }
  return out
}

export function isLinkCell(v: unknown): v is LinkCell {
  return typeof v === "object" && v !== null && typeof (v as LinkCell).id === "string"
}

export function isEmptyCell(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "number" && Number.isNaN(v))
  )
}

/** One cell as it reads in the grid and in history lines. */
export function cellText(column: TableColumn, value: unknown, o: CellTextOptions): string {
  if (column.type === "checkbox")
    return value === true ? o.t("kernel.dashboards.tables.yes") : o.t("kernel.dashboards.tables.no")
  if (isEmptyCell(value)) return ""
  switch (column.type) {
    case "number":
      return typeof value === "number"
        ? formatValue(value, { format: "number", locale: o.locale })
        : String(value)
    case "amount":
      return typeof value === "number"
        ? formatValue(value, { format: "currency", currency: column.currency, locale: o.locale })
        : String(value)
    case "date":
      return typeof value === "string" ? formatCellDate(value, o.locale) : String(value)
    case "choices":
      return Array.isArray(value) ? value.map(String).join(", ") : String(value)
    case "person":
      return typeof value === "string"
        ? (o.personName?.(value) ?? o.t("kernel.dashboards.tables.unknownPerson"))
        : String(value)
    case "link":
      // A label the reader may not resolve comes back empty: the record stays, unnamed.
      return isLinkCell(value)
        ? typeof value.label === "string" && value.label.trim()
          ? value.label
          : o.t("kernel.dashboards.tables.linkedRecord")
        : String(value)
    default:
      return typeof value === "string" ? value : JSON.stringify(value)
  }
}

/** "2026-11-18" as the viewer's short date ("Nov 18, 2026"); anything else as it is. */
export function formatCellDate(value: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.slice(0, 10))
  if (!m) return value
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d)
}

export type ParsedCell = { ok: true; value: unknown } | { ok: false; reason: "number" | "required" }

/**
 * What an editor's raw input becomes for its column: a number for number and amount, a
 * `YYYY-MM-DD` string for a date, null for an empty input (the server refuses a required one;
 * the form says so first).
 */
export function parseCellInput(column: TableColumn, raw: unknown): ParsedCell {
  if (column.type === "checkbox") return { ok: true, value: raw === true }
  if (column.type === "choices") {
    const list = Array.isArray(raw) ? raw.map(String) : []
    if (column.required && list.length === 0) return { ok: false, reason: "required" }
    return { ok: true, value: list }
  }
  if (column.type === "link") {
    if (isLinkCell(raw)) return { ok: true, value: raw }
    return column.required ? { ok: false, reason: "required" } : { ok: true, value: null }
  }
  const text =
    typeof raw === "string" ? raw.trim() : raw === null || raw === undefined ? "" : String(raw)
  if (text === "")
    return column.required ? { ok: false, reason: "required" } : { ok: true, value: null }
  if (column.type === "number" || column.type === "amount") {
    const n = Number(text.replace(/\s/g, "").replace(",", "."))
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, reason: "number" }
  }
  return { ok: true, value: text }
}

/** The add form's columns: required ones first, each group in the table's order. */
export function addFormColumns(columns: TableColumn[]): TableColumn[] {
  return [...columns.filter((c) => c.required), ...columns.filter((c) => !c.required)]
}

/** The columns a block shows: the map's keys in their order, else every column. */
export function shownColumns(columns: TableColumn[], keys?: string[]): TableColumn[] {
  if (!keys || keys.length === 0) return columns
  const byKey = new Map(columns.map((c) => [c.key, c]))
  return keys.map((k) => byKey.get(k)).filter((c): c is TableColumn => !!c)
}

/** A row's name in a history title: its first text-like cell, else nothing. */
export function rowLabel(columns: TableColumn[], cells: TableCells, o: CellTextOptions): string {
  for (const c of columns) {
    if (c.type === "checkbox") continue
    const text = cellText(c, cells[c.key], o)
    if (text) return text
  }
  return ""
}

/** Has the row gone `days` days or more without a change (a "to confirm" row)? */
export function isStale(updatedAt: string, now: number, days: number | undefined): boolean {
  if (!days || days <= 0) return false
  const at = Date.parse(updatedAt)
  return Number.isFinite(at) && now - at >= days * 86_400_000
}

/** "just now", "4 min ago", "3 hr ago", "2 days ago" from an instant. */
export function relativeTime(at: string, now: number, locale: string, t: T): string {
  const ms = Date.parse(at)
  if (!Number.isFinite(ms)) return ""
  const sec = Math.max(0, Math.round((now - ms) / 1000))
  if (sec < 60) return t("kernel.dashboards.tables.justNow")
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" })
  if (sec < 3600) return rtf.format(-Math.floor(sec / 60), "minute")
  if (sec < 86_400) return rtf.format(-Math.floor(sec / 3600), "hour")
  return rtf.format(-Math.floor(sec / 86_400), "day")
}

/**
 * What a change did, as one line: the changed cells "Label: before → after" joined by " · " for
 * an update or an undo, "Added the row: a, b, c" for a creation, "Deleted the row" for a
 * deletion. A dropped column still reads, by its key.
 */
export function changeSummary(
  change: TableChange,
  columns: TableColumn[],
  o: CellTextOptions,
): string {
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const col = (key: string): TableColumn => byKey.get(key) ?? { key, label: key, type: "text" }
  const text = (key: string, v: unknown) => {
    const s = cellText(col(key), v, o)
    return s === "" ? o.t("kernel.dashboards.tables.emptyCell") : s
  }
  if (change.op === "create") {
    const after = change.after ?? {}
    const parts = Object.keys(after)
      .filter((k) => !isEmptyCell(after[k]))
      .map((k) => cellText(col(k), after[k], o))
      .filter((s) => s !== "")
    return o.t("kernel.dashboards.tables.changeAdded", { cells: parts.join(", ") })
  }
  if (change.op === "delete") return o.t("kernel.dashboards.tables.changeDeleted")
  const before = change.before ?? {}
  const after = change.after ?? {}
  const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])]
  const lines = keys.map((k) => `${col(k).label}: ${text(k, before[k])} → ${text(k, after[k])}`)
  const body = lines.join(" · ")
  return change.op === "undo" ? o.t("kernel.dashboards.tables.changeUndo", { cells: body }) : body
}

/**
 * A column key from its label: lower case ASCII, digits and underscores, starting with a letter.
 * Never a key the row itself uses (`id`, `updated_at`, ...), one in use, or a dropped column's
 * (`taken` lists both): those get a numbered suffix.
 */
export function columnKeyFrom(label: string, taken: Iterable<string>): string {
  const base =
    label
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^[^a-z]+|_+$/g, "")
      .slice(0, 36) || "column"
  const used = new Set([...taken, ...RESERVED_COLUMN_KEYS])
  if (!used.has(base)) return base
  for (let i = 2; ; i++) {
    const k = `${base}_${i}`
    if (!used.has(k)) return k
  }
}

/** A comma-separated choices input as a clean list (trimmed, no blanks, no repeats). */
export function choicesFrom(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ]
}
