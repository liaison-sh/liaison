// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The server-side `map` step: a source's rows (at most MAX_SOURCE_ROWS) become
// what one chart draws. Pure: no I/O, so every chart type's semantics are
// unit-tested here (transform.test.ts).
//
// - metric: `agg` (default sum, or count without `value`) over the rows' `value`;
//   when the source returned an object with no rows, `value` is a path into it.
// - table:  the rows, sorted by `sort` and cut to `limit`, projected to `columns`.
// - bar | line: the category is the `groupBy` key (a date bucket when `bucket`
//   is set) or the `x` field; each category's value is `agg` (default sum, or
//   count without `y`) of `y`; an optional `series` field splits it into series.
// - pie: the slice is the `groupBy` key or the `label` field; its value is `agg`
//   of `value`.
// - metric extras: `target` is echoed; `sparkline {field, bucket}` is the same
//   aggregation per date bucket (zero-filled over the dashboard window for sum/count).
// - compare: attachPrevious puts a second run's numbers (the comparison window) beside
//   the first, aligned: a metric's value, a chart's values per label and series.
// - area: a line chart filled; combo: bars and lines over the same categories (`lineSeries`
//   names the lines, default the last series); `stacked`, `horizontal`, `secondaryAxis` are
//   echoed in `display`. `measures` gives a chart several values per category (one series each,
//   its own field and agg) instead of `y` + `series`.
// - funnel: `stages` (each one aggregation over all rows, or a path into a one-object result),
//   or categories (`groupBy`/`x` with `y`/`agg`) ordered by `order`, else by value descending.
// - text: the markdown, no rows.
// - where: rows that fail `map.where` (resolved with the filter values, filters.ts) are left out
//   before anything is counted; `meta.filteredRows` says how many.
// - links: a table's rows carry their record link (`map.link`), drill-down rows too.
// Sorting: `sort.field` names the category field (or "label"/"key") to order by
// category, or the aggregated field (or "value") to order by value. Defaults:
// line and bucketed bar by category ascending, bar and pie by value descending.

import { unwrapExternalContent } from "~/lib/external-content"
import { applyWhere, type ResolvedWhere } from "~/modules/dashboards/filters"
import {
  type Aggregation,
  type BlockMap,
  type BlockType,
  type DateBucket,
  MAX_BLOCK_OUTPUT,
  MAX_BLOCK_SERIES,
  MAX_SOURCE_ROWS,
} from "~/modules/dashboards/spec"

export type ChartKind = "bar" | "line" | "pie" | "area" | "combo" | "funnel"

/** Where a row leads: an app path, or a record the web opens with its entity opener. */
export type RecordLink =
  | { kind: "path"; href: string }
  | { kind: "entity"; app: string; entityType: string; id: string }

/** How a chart is drawn, from its map (absent keys: the default). */
export interface ChartDisplay {
  stacked?: true
  horizontal?: true
  lineSeries?: string[]
  secondaryAxis?: true
}

type Row = Record<string, unknown>
type Scalar = string | number | boolean | null

export interface BlockMeta {
  /** Rows the source returned (before the cut to MAX_SOURCE_ROWS). */
  sourceRows: number
  /** True when rows past MAX_SOURCE_ROWS, or categories past the limit, were dropped. */
  truncated: boolean
  /** Rows left out because a needed field was missing or not usable (a date, a number). */
  skippedRows: number
  format?: BlockMap["format"]
  currency?: string
  /** Rows map.where left out (absent when no where clause applied). */
  filteredRows?: number
}

/** A chart's comparison values, index by index with its labels and series (null: none matches). */
export interface PreviousSeries {
  labels: (string | null)[]
  series: { name: string; values: (number | null)[] }[]
}

export type BlockData =
  | {
      kind: "metric"
      value: number | null
      meta: BlockMeta
      /** The same metric over the comparison window, when one ran. */
      previous?: number | null
      target?: number
      sparkline?: { labels: string[]; values: number[] }
    }
  | {
      kind: "table"
      columns: { field: string; label: string; format?: BlockMap["format"] }[]
      rows: Record<string, Scalar>[]
      meta: BlockMeta
      /** Each row's record link, index by index (when map.link). */
      links?: (RecordLink | null)[]
    }
  | {
      kind: ChartKind
      labels: string[]
      series: { name: string; values: number[] }[]
      meta: BlockMeta
      previous?: PreviousSeries
      display?: ChartDisplay
    }
  | { kind: "text"; markdown: string; meta: BlockMeta }

/** Two calendar days (YYYY-MM-DD), inclusive. */
export interface TransformWindow {
  from: string
  to: string
}

export class TransformError extends Error {
  code = "invalid_map" as const
}

export const NONE_LABEL = "(none)"
const DEFAULT_SERIES = "value"

/** The value at a dotted path (`billing.country`, `line_items.0.name`). */
export function readPath(source: unknown, path: string): unknown {
  let cur: unknown = source
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(part)) return undefined
      cur = cur[Number(part)]
      continue
    }
    if (typeof cur !== "object") return undefined
    cur = (cur as Row)[part]
  }
  return cur
}

/** A number, from a number or a numeric string ("12.50", as many shop APIs send money). */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** A date from an ISO string or an epoch number (seconds below 1e12, else milliseconds). */
export function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v)
  if (typeof v === "string" && v.trim() !== "") {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

const pad = (n: number) => String(n).padStart(2, "0")

/** The bucket a date falls in, in UTC: `2026-11-07` (day), the Monday of its week, `2026-11` (month). */
export function bucketKey(d: Date, bucket: DateBucket): string {
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  if (bucket === "month") return `${y}-${pad(m + 1)}`
  if (bucket === "day") return `${y}-${pad(m + 1)}-${pad(d.getUTCDate())}`
  const monday = new Date(Date.UTC(y, m, d.getUTCDate()))
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`
}

function keyOf(v: unknown): string {
  if (v === null || v === undefined || v === "") return NONE_LABEL
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return JSON.stringify(v)
}

/** Rounds away float noise (0.1 + 0.2), keeping 6 decimals. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/** `agg` over the group's values; count counts rows, the others skip non-numbers. */
function aggregate(agg: Aggregation, rows: Row[], field: string | undefined): number | null {
  if (agg === "count") return rows.length
  const nums: number[] = []
  for (const r of rows) {
    const n = field ? toNumber(readPath(r, field)) : null
    if (n !== null) nums.push(n)
  }
  if (nums.length === 0) return agg === "sum" ? 0 : null
  switch (agg) {
    case "sum":
      return round(nums.reduce((a, b) => a + b, 0))
    case "avg":
      return round(nums.reduce((a, b) => a + b, 0) / nums.length)
    case "min":
      return Math.min(...nums)
    case "max":
      return Math.max(...nums)
  }
}

function toScalar(v: unknown): Scalar {
  if (v === undefined) return null
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return v
  }
  return JSON.stringify(v)
}

function compare(a: unknown, b: unknown): number {
  const na = toNumber(a)
  const nb = toNumber(b)
  if (na !== null && nb !== null) return na - nb
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1
  if (b === null || b === undefined) return -1
  return String(a).localeCompare(String(b))
}

/**
 * A source result whose fields arrive fenced as untrusted text (a connector read
 * answers `items: "<external-content ...>[...]</external-content>"`, so an agent
 * reads them as data): the fenced JSON parsed back, top-level fields only, so the
 * map reads its rows. A fenced field that is not JSON stays as it is. The fence is
 * for a model reader; a block's rows go to the chart, and a preview runs the tool
 * in the agent's thread, so the tool's own taint rule still applies there.
 */
export function unfenceSourceResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result
  let out: Record<string, unknown> | null = null
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if (typeof v !== "string") continue
    const inner = unwrapExternalContent(v)
    if (inner === v) continue
    try {
      const parsed: unknown = JSON.parse(inner)
      if (parsed && typeof parsed === "object") {
        out ??= { ...(result as Record<string, unknown>) }
        out[k] = parsed
      }
    } catch {
      // not JSON: the field stays text
    }
  }
  return out ?? result
}

/**
 * The rows of a source result: the result itself when it is a list, `rowsPath`
 * when given, else the result's only list-valued field (`items`, `orders`, ...),
 * else none (the result is one object, which a metric reads with a path).
 */
export function extractRows(
  result: unknown,
  rowsPath?: string,
): { rows: Row[] | null; object: unknown } {
  const at = rowsPath ? readPath(result, rowsPath) : result
  if (rowsPath && !Array.isArray(at)) {
    throw new TransformError(`rowsPath '${rowsPath}' is not a list in the source's result`)
  }
  if (Array.isArray(at)) return { rows: at.map(asRow), object: result }
  if (at && typeof at === "object") {
    const lists = Object.entries(at as Row).filter(([, v]) => Array.isArray(v))
    const preferred = lists.find(([k]) => k === "items" || k === "rows" || k === "data")
    const only = preferred ?? (lists.length === 1 ? lists[0] : undefined)
    if (only) return { rows: (only[1] as unknown[]).map(asRow), object: result }
  }
  return { rows: null, object: result }
}

function asRow(v: unknown): Row {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Row) : { value: v }
}

interface Group {
  key: string
  rows: Row[]
}

/** Groups rows by category (and by series, inside), in first-seen order. */
function groupRows(
  rows: Row[],
  keyField: string,
  bucket: DateBucket | undefined,
  meta: BlockMeta,
): Group[] {
  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    const raw = readPath(r, keyField)
    let key: string
    if (bucket) {
      const d = toDate(raw)
      if (!d) {
        meta.skippedRows++
        continue
      }
      key = bucketKey(d, bucket)
    } else {
      key = keyOf(raw)
    }
    const list = groups.get(key)
    if (list) list.push(r)
    else groups.set(key, [r])
  }
  return [...groups].map(([key, rows]) => ({ key, rows }))
}

function sortDirection(
  map: BlockMap,
  keyField: string,
  aggField: string | undefined,
  defaults: { by: "key" | "value"; dir: "asc" | "desc" },
): { by: "key" | "value"; dir: "asc" | "desc" } {
  if (!map.sort) return defaults
  const f = map.sort.field
  if (f === keyField || f === "key" || f === "label") return { by: "key", dir: map.sort.dir }
  if (f === aggField || f === "value") return { by: "value", dir: map.sort.dir }
  throw new TransformError(
    `sort.field '${f}' is neither the category field '${keyField}' nor the value${aggField ? ` field '${aggField}'` : ""}`,
  )
}

export interface TransformOptions {
  rowsPath?: string
  window?: TransformWindow | null
  /** Rows the source returned when `result` is already cut to MAX_SOURCE_ROWS (a cached read). */
  totalRows?: number
  /** map.where with the filter values in (filters.ts resolveWhere). */
  where?: ResolvedWhere[]
  /** The source tool's app: an entity link names it when map.link does not. */
  linkApp?: string
  /** A text block's markdown. */
  text?: string
}

/** The rows a block aggregates: the source's rows (cut to MAX_SOURCE_ROWS), where applied. */
export function blockRows(
  result: unknown,
  opts: Pick<TransformOptions, "rowsPath" | "totalRows" | "where">,
): { rows: Row[] | null; object: unknown; meta: BlockMeta } {
  const { rows: allRows, object } = extractRows(result, opts.rowsPath)
  const sourceRows = Math.max(opts.totalRows ?? 0, allRows?.length ?? 0)
  const meta: BlockMeta = {
    sourceRows,
    truncated: sourceRows > MAX_SOURCE_ROWS,
    skippedRows: 0,
  }
  let rows = allRows ? allRows.slice(0, MAX_SOURCE_ROWS) : null
  const where = opts.where ?? []
  if (where.length) {
    if (!rows) {
      throw new TransformError("map.where needs rows: the source returned one object")
    }
    const kept = applyWhere(rows, where)
    meta.filteredRows = rows.length - kept.length
    rows = kept
  }
  return { rows, object, meta }
}

/** Applies a block's map to its source's result. */
export function transformBlock(
  type: BlockType,
  map: BlockMap,
  result: unknown,
  opts: TransformOptions = {},
): BlockData {
  if (type === "text") {
    return {
      kind: "text",
      markdown: opts.text ?? "",
      meta: { sourceRows: 0, truncated: false, skippedRows: 0 },
    }
  }
  const { rows, object, meta } = blockRows(result, opts)
  if (map.format) meta.format = map.format
  if (map.currency) meta.currency = map.currency

  if (type === "metric") {
    const extras = map.target !== undefined ? { target: map.target } : {}
    if (!rows) {
      if (!map.value)
        throw new TransformError("the source returned one object: map.value names its field")
      return { kind: "metric", value: toNumber(readPath(object, map.value)), meta, ...extras }
    }
    const agg = map.agg ?? (map.value ? "sum" : "count")
    return {
      kind: "metric",
      value: aggregate(agg, rows, map.value),
      meta,
      ...extras,
      ...(map.sparkline
        ? { sparkline: sparklineOf(rows, map.sparkline, agg, map.value, meta, opts.window) }
        : {}),
    }
  }

  if (type === "funnel" && map.stages) {
    const stages = map.stages
    const values = stages.map((st) => {
      const agg = st.agg ?? (st.field ? "sum" : "count")
      if (!rows) {
        if (!st.field)
          throw new TransformError("the source returned one object: each stage names its field")
        return toNumber(readPath(object, st.field)) ?? 0
      }
      return aggregate(agg, rows, st.field) ?? 0
    })
    return {
      kind: "funnel",
      labels: stages.map((st) => st.label),
      series: [{ name: DEFAULT_SERIES, values }],
      meta,
    }
  }

  if (!rows) {
    throw new TransformError(
      "the source returned no list of rows: set source.rowsPath to the field that holds them",
    )
  }

  if (type === "table") {
    const columns = map.columns ?? []
    const out = sortedTableRows(rows, map)
    const limit = map.limit ?? MAX_BLOCK_OUTPUT
    if (out.length > limit) meta.truncated = true
    const kept = out.slice(0, limit)
    return {
      kind: "table",
      columns: columns.map((c) => ({
        field: c.field,
        label: c.label,
        ...(c.format ? { format: c.format } : {}),
      })),
      rows: kept.map((r) => projectRow(r, columns)),
      meta,
      ...(map.link ? { links: kept.map((r) => recordLink(r, map.link, opts.linkApp)) } : {}),
    }
  }

  // bar | line | area | combo | pie | funnel (from categories)
  const keyField = categoryField(type, map)
  const bucket = map.groupBy?.bucket
  const aggField = type === "pie" ? map.value : map.y
  const agg = map.agg ?? (aggField ? "sum" : "count")
  const groups = groupRows(rows, keyField, bucket, meta)
  const measures = map.measures
  const firstMeasure = measures?.[0]
  const totalOf = (g: Group) =>
    firstMeasure
      ? (aggregate(
          firstMeasure.agg ?? (firstMeasure.field ? "sum" : "count"),
          g.rows,
          firstMeasure.field,
        ) ?? 0)
      : (aggregate(agg, g.rows, aggField) ?? 0)

  const byCategory =
    type === "line" ||
    type === "area" ||
    ((type === "bar" || type === "combo") && bucket !== undefined)
  const sortValueField = firstMeasure ? firstMeasure.field : aggField
  const { by, dir } = sortDirection(map, keyField, sortValueField, {
    by: byCategory ? "key" : "value",
    dir: byCategory ? "asc" : "desc",
  })

  const totals = new Map(groups.map((g) => [g.key, totalOf(g)]))
  let sorted = [...groups].sort((a, b) => {
    const c =
      by === "key" ? compare(a.key, b.key) : (totals.get(a.key) ?? 0) - (totals.get(b.key) ?? 0)
    return dir === "desc" ? -c : c
  })
  if (type === "funnel" && map.order) {
    const byKey = new Map(groups.map((g) => [g.key, g]))
    sorted = map.order.map((label) => byKey.get(label) ?? { key: label, rows: [] })
  }
  const limit = map.limit ?? MAX_BLOCK_OUTPUT
  if (sorted.length > limit) meta.truncated = true
  const kept = sorted.slice(0, limit)
  const labels = kept.map((g) => g.key)

  const seriesField = type === "pie" || type === "funnel" ? undefined : map.series
  const series = measures
    ? measures.map((m) => ({
        name: m.label,
        values: kept.map(
          (g) => aggregate(m.agg ?? (m.field ? "sum" : "count"), g.rows, m.field) ?? 0,
        ),
      }))
    : seriesField
      ? splitSeries(rows, kept, seriesField, agg, aggField, meta)
      : [{ name: aggField ?? DEFAULT_SERIES, values: kept.map((g) => totals.get(g.key) ?? 0) }]

  const display = displayOf(type, map, series)
  return { kind: type, labels, series, meta, ...(display ? { display } : {}) }
}

/** The field a chart's categories come from (groupBy, else x, else a pie's label). */
export function categoryField(type: BlockType, map: BlockMap): string {
  return (map.groupBy?.field ?? (type === "pie" ? map.label : map.x)) as string
}

/** The category a row falls in, as the chart labels it (null: no usable date for a bucket). */
export function categoryOf(row: Row, field: string, bucket: DateBucket | undefined): string | null {
  const raw = readPath(row, field)
  if (bucket) {
    const d = toDate(raw)
    return d ? bucketKey(d, bucket) : null
  }
  return keyOf(raw)
}

/** A row's split-series name, as the chart labels it. */
export function seriesNameOf(row: Row, field: string): string {
  return keyOf(readPath(row, field))
}

/** A table's rows in the order it shows them (map.sort), before the limit. */
export function sortedTableRows(rows: Row[], map: BlockMap): Row[] {
  if (!map.sort) return rows
  const { field, dir } = map.sort
  return [...rows].sort(
    (a, b) => compare(readPath(a, field), readPath(b, field)) * (dir === "desc" ? -1 : 1),
  )
}

/** A row reduced to its columns' values. */
export function projectRow(r: Row, columns: { field: string }[]): Record<string, Scalar> {
  const o: Record<string, Scalar> = {}
  for (const c of columns) o[c.field] = toScalar(readPath(r, c.field))
  return o
}

const LINK_TOKEN = /\{\{([A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z0-9_$-]+)*)\}\}/g

/** The fields a link reads. */
export function linkFields(link: BlockMap["link"]): string[] {
  if (!link) return []
  if (typeof link !== "string") return [link.idField]
  return [...link.matchAll(LINK_TOKEN)].map((m) => m[1]!)
}

/**
 * A row's record link: the path template with each {{field}} URL-encoded (null when one is
 * empty), or the entity named with the row's id. Never anything but an app path.
 */
export function recordLink(row: Row, link: BlockMap["link"], linkApp?: string): RecordLink | null {
  if (!link) return null
  if (typeof link !== "string") {
    const id = readPath(row, link.idField)
    const app = link.app ?? linkApp
    if (!app || id === null || id === undefined || id === "" || typeof id === "object") return null
    return { kind: "entity", app, entityType: link.entity, id: String(id) }
  }
  let missing = false
  const href = link.replace(LINK_TOKEN, (_raw, field: string) => {
    const v = readPath(row, field)
    if (v === null || v === undefined || v === "" || typeof v === "object") {
      missing = true
      return ""
    }
    return encodeURIComponent(String(v))
  })
  if (missing || !href.startsWith("/") || href.startsWith("//")) return null
  return { kind: "path", href }
}

function displayOf(
  type: ChartKind,
  map: BlockMap,
  series: { name: string }[],
): ChartDisplay | null {
  const d: ChartDisplay = {}
  if (map.stacked && (type === "bar" || type === "area" || type === "combo")) d.stacked = true
  if (map.horizontal && type === "bar") d.horizontal = true
  if (type === "combo") {
    const names = new Set(series.map((s) => s.name))
    const asked = (map.lineSeries ?? []).filter((n) => names.has(n))
    d.lineSeries = asked.length ? asked : series.length ? [series[series.length - 1]!.name] : []
    if (map.secondaryAxis) d.secondaryAxis = true
  }
  return Object.keys(d).length ? d : null
}

/**
 * One series per value of `field` over the kept categories, each aggregated per category. At
 * most MAX_BLOCK_SERIES: the largest by their absolute total, in first-seen order; the rest are
 * left out and the block says it is truncated.
 */
function splitSeries(
  rows: Row[],
  kept: Group[],
  field: string,
  agg: Aggregation,
  aggField: string | undefined,
  meta: BlockMeta,
): { name: string; values: number[] }[] {
  const order = [...new Set(rows.map((r) => keyOf(readPath(r, field))))]
  const perGroup = kept.map((g) => {
    const byName = new Map<string, Row[]>()
    for (const r of g.rows) {
      const name = keyOf(readPath(r, field))
      const list = byName.get(name)
      if (list) list.push(r)
      else byName.set(name, [r])
    }
    return byName
  })
  const all = order.map((name) => ({
    name,
    values: perGroup.map((byName) => aggregate(agg, byName.get(name) ?? [], aggField) ?? 0),
  }))
  if (all.length <= MAX_BLOCK_SERIES) return all
  meta.truncated = true
  const weight = (s: { values: number[] }) => s.values.reduce((t, v) => t + Math.abs(v), 0)
  const keep = new Set(
    [...all]
      .sort((a, b) => weight(b) - weight(a))
      .slice(0, MAX_BLOCK_SERIES)
      .map((s) => s.name),
  )
  return all.filter((s) => keep.has(s.name))
}

/** The most points a zero-filled sparkline gets; a longer window keeps only its buckets with data. */
const MAX_SPARKLINE_POINTS = 400

/** Every bucket key from `from` to `to` (YYYY-MM-DD), or null past MAX_SPARKLINE_POINTS. */
function bucketKeysBetween(from: string, to: string, bucket: DateBucket): string[] | null {
  const start = toDate(`${from}T00:00:00Z`)
  const end = toDate(`${to}T00:00:00Z`)
  if (!start || !end || start > end) return null
  const keys: string[] = []
  const cur = new Date(start)
  while (cur <= end) {
    const key = bucketKey(cur, bucket)
    if (keys[keys.length - 1] !== key) keys.push(key)
    if (keys.length > MAX_SPARKLINE_POINTS) return null
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return keys
}

function sparklineOf(
  rows: Row[],
  spec: { field: string; bucket: DateBucket },
  agg: Aggregation,
  valueField: string | undefined,
  meta: BlockMeta,
  window: TransformWindow | null | undefined,
): { labels: string[]; values: number[] } {
  // Rows without a usable date are already counted by the metric: not skipped twice.
  const scratch: BlockMeta = { ...meta, skippedRows: 0 }
  const groups = groupRows(rows, spec.field, spec.bucket, scratch)
  const byKey = new Map(groups.map((g) => [g.key, aggregate(agg, g.rows, valueField) ?? 0]))
  const fill =
    window && (agg === "sum" || agg === "count")
      ? bucketKeysBetween(window.from, window.to, spec.bucket)
      : null
  const labels = fill ?? [...byKey.keys()].sort()
  return { labels, values: labels.map((k) => byKey.get(k) ?? 0) }
}

/** A bucket key's position on its own scale: days, weeks or months since the epoch. */
function bucketOrdinal(key: string, bucket: DateBucket): number | null {
  if (bucket === "month") {
    const m = /^(\d{4})-(\d{2})$/.exec(key)
    return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null
  }
  const d = toDate(`${key}T00:00:00Z`)
  if (!d) return null
  const days = Math.round(d.getTime() / 86_400_000)
  return bucket === "week" ? Math.floor((days + 3) / 7) : days
}

/**
 * `current` with `previous` (the same block over the comparison window) beside it. A metric
 * takes the previous value. A chart takes, for each of its labels, the previous label at the
 * same place: a date bucket at the same distance from its window's start (`bucket` with both
 * windows), any other category the same label; series match by name. A table, or two shapes
 * that differ, is returned as it is.
 */
export function attachPrevious(
  current: BlockData,
  previous: BlockData,
  align: { bucket?: DateBucket; window?: TransformWindow; compareWindow?: TransformWindow } = {},
): BlockData {
  if (current.kind === "metric") {
    return previous.kind === "metric" ? { ...current, previous: previous.value } : current
  }
  if (current.kind === "table" || current.kind === "text" || previous.kind !== current.kind) {
    return current
  }
  const prevIndex = new Map<string, number>()
  previous.labels.forEach((l, i) => {
    prevIndex.set(l, i)
  })
  let match: (label: string) => number | undefined = (label) => prevIndex.get(label)
  const { bucket, window, compareWindow } = align
  if (bucket && window && compareWindow) {
    const curStart = bucketOrdinal(bucketKey(new Date(`${window.from}T00:00:00Z`), bucket), bucket)
    const prevStart = bucketOrdinal(
      bucketKey(new Date(`${compareWindow.from}T00:00:00Z`), bucket),
      bucket,
    )
    const byOffset = new Map<number, number>()
    previous.labels.forEach((l, i) => {
      const o = bucketOrdinal(l, bucket)
      if (o !== null && prevStart !== null) byOffset.set(o - prevStart, i)
    })
    match = (label) => {
      const o = bucketOrdinal(label, bucket)
      return o === null || curStart === null ? undefined : byOffset.get(o - curStart)
    }
  }
  const at = current.labels.map(match)
  const prevSeries = new Map(previous.series.map((s) => [s.name, s.values]))
  return {
    ...current,
    previous: {
      labels: at.map((i) => (i === undefined ? null : (previous.labels[i] ?? null))),
      series: current.series.map((s) => {
        const values = prevSeries.get(s.name)
        return {
          name: s.name,
          values: at.map((i) => (i === undefined || !values ? null : (values[i] ?? null))),
        }
      }),
    },
  }
}
