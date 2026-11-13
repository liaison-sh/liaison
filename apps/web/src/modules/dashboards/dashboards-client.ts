// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE WEB APP'S ONE VIEW OF THE DASHBOARDS API. Every dashboard read the web
// app makes goes through here, so the wire shape lives in one place:
//
//   GET /dashboards                                  the viewer's personal + org dashboards
//   GET /dashboards/:id                              one dashboard and its spec
//   GET /dashboards/:id/blocks/:blockId/data[?refresh=1&range=&from=&to=&compare=]
//                                                    one block's mapped data, run as the viewer,
//                                                    for the range the viewer looks at
//   GET|PUT|DELETE /dashboards/:id/viewer-state      the range and filters this person last chose
//   GET /dashboards/:id/blocks/:blockId/rows         the rows behind one figure (drill-down)
//   GET /dashboards/:id/filters/:filterId/options    the values a filter offers (`?q=` searches them)
//   POST /dashboards/:id/edit                        a person's own edit, by operations
//   POST /dashboards/:id/duplicate                   a personal copy for the caller
//   GET /dashboards/:id/versions[/:version]          the saved versions (history)
//   GET /dashboards/:id/export.pdf, .../blocks/:blockId/data.csv|rows.csv   downloads
//
// Filter values ride every read as `f.<id>=<value>` (repeated for a multi; `f.<id>=` = all).
//
// A block's data is either one of the shapes below, or a refusal
// `{error: "no_access" | "not_allowed" | "rate_limited" | "source_error"}`
// that concerns that block alone. The rest of the dashboard renders.
import { ApiError } from "~/lib/api-error"
import type { CompareMode, DayWindow, RangeChoice, TimePreset, TimeRange } from "./time-range"

export type DashboardVisibility = "personal" | "org"
export type DashboardBlockType =
  | "metric"
  | "table"
  | "bar"
  | "line"
  | "pie"
  | "area"
  | "combo"
  | "funnel"
  | "text"
export type ValueFormat = "number" | "currency" | "percent" | "date"

export interface DashboardColumn {
  field: string
  label: string
  format?: ValueFormat
}

export interface DashboardBlockMap {
  x?: string
  y?: string
  series?: string
  value?: string
  label?: string
  columns?: DashboardColumn[]
  format?: ValueFormat
  currency?: string
  /** A metric's goal: shown as "x of y" with a thin bar. */
  target?: number
  sparkline?: { field: string; bucket?: DateBucket }
  /** Every value multiplied by this (0.01: cents to units). The server applies it. */
  scale?: number
  /** Each value of a chart is its share of its series' total, in percent (0-100). */
  percentOfTotal?: boolean
  /** A metric computed from named values (the server evaluates it). */
  expr?: string
  /** A table block on a table source: people with edit access change its rows in place. */
  editable?: boolean
  /** An editable table: rows not changed for this many days show a "to confirm" marker. */
  staleAfterDays?: number
  [key: string]: unknown
}

/** A date bucket: "2026-11-07", Monday "2026-11-02", "2026-11", "2026-Q4", "2026". */
export type DateBucket = "day" | "week" | "month" | "quarter" | "year"

export type BlockWidth = 1 | 2 | 3
export type BlockHeight = 1 | 2

export interface DashboardBlockSpec {
  id: string
  type: DashboardBlockType
  title: string
  width: BlockWidth
  /** Rows of the grid the block spans (default 1). */
  height?: BlockHeight
  /** Absent on a text block, and on a block reading a shared dataset. */
  source?: Record<string, unknown>
  dataset?: string
  /** A blended chart's layers (a combo reading 2-3 sources joined on their date bucket). */
  layers?: DashboardLayerSpec[]
  /** A text block's markdown. */
  text?: string
  map?: DashboardBlockMap
  refreshSec?: number
  /** Follows the dashboard's range, or keeps its own window. The server says which (`blockTimeRange`). */
  timeRange?: BlockRangeMode
}

export type BlockRangeMode = "dashboard" | "fixed"

/** One layer of a blended chart, as the spec declares it. */
export interface DashboardLayerSpec {
  id: string
  label?: string
  as: "bar" | "line"
  axis?: "left" | "right"
  source?: Record<string, unknown>
  dataset?: string
  map: DashboardBlockMap
}

export type FilterType = "select" | "multi" | "text"

/** A dashboard filter as its spec declares it. Options: a static list, or read from a source. */
export interface DashboardFilterDef {
  id: string
  label: string
  type: FilterType
  options?: string[] | Record<string, unknown>
  default?: string | string[]
}

/** Each filter's values: [] = all, one item for a select or a text filter. */
export type FilterValues = Record<string, string[]>

export interface DashboardSpec {
  v: 1
  layout: "grid"
  blocks: DashboardBlockSpec[]
  timeRange?: TimeRange
  compare?: CompareMode
  filters?: DashboardFilterDef[]
  datasets?: Record<string, unknown>
  /** Plain text under the title. */
  description?: string
}

/** The range a dashboard opens on for this viewer, as the server resolved it today. */
export interface DashboardRangeState extends RangeChoice {
  /** True: the viewer's own remembered choice; false: the dashboard's default. */
  saved: boolean
  window: DayWindow
  compareWindow: DayWindow | null
}

export interface DashboardSummary {
  id: string
  title: string
  visibility: DashboardVisibility
  /** What everyone in the organisation gets (absent from a server that predates sharing). */
  orgAccess?: "none" | "viewer" | "editor"
  /** Someone besides its owner sees it: the whole organisation, or people or roles it is shared with. */
  shared?: boolean
  ownerUserId: string | null
  /** The owner's display name (the list carries it; one dashboard's read does not). */
  ownerName?: string | null
  /** How many blocks it holds (the list carries it). */
  blockCount?: number
  updatedAt?: string
}

export interface Dashboard extends DashboardSummary {
  spec: DashboardSpec
  version: number
  /** Absent from a server that predates time ranges. */
  range?: DashboardRangeState
  defaultRange?: RangeChoice
  blockTimeRange?: Record<string, BlockRangeMode>
  /** At least one block follows the dashboard's range: the picker shows only then. */
  usesTimeRange?: boolean
  /** The viewer's remembered filter values (else the defaults), and whether they are theirs. */
  filters?: { values: FilterValues; saved: boolean }
  defaultFilters?: FilterValues
  /** The viewer may change this dashboard (edit mode, Restore). */
  canEdit?: boolean
  /** The viewer may change who sees it (the Share dialog's controls). */
  canShare?: boolean
  /** Today in the org's time zone (YYYY-MM-DD): presets resolve from it, never the browser's date. */
  today?: string
  /** The org's IANA time zone (UTC when unset). */
  timeZone?: string
}

/** The window a block's data covers, as the server reports it. */
export type BlockWindow =
  | { mode: "dashboard"; preset: TimePreset; from: string; to: string }
  | { mode: "fixed"; dates: { token: string; date: string }[] }

export interface BlockCompareWindow {
  mode: "lastYear" | "previousPeriod"
  from: string
  to: string
}

/** What came with a block's data besides the data: when, for which days, what was left out. */
export interface BlockReadInfo {
  computedAt?: string
  window?: BlockWindow
  compareWindow?: BlockCompareWindow | null
  /** Rows the server left out because a field it needed was missing or unusable. */
  skippedRows?: number
  /** The comparison run failed: the current figures still show. */
  previousError?: { error: string; message?: string }
  /** Rows the source returned (0 when it returned one object: no rows to drill into). */
  sourceRows?: number
}

/** A chart's comparison values, index by index with its labels and series (null: no match). */
export interface PreviousSeries {
  labels: Array<string | null>
  series: Array<{ name: string; values: Array<number | null> }>
}

export interface MetricData {
  kind: "metric"
  value: number | string | null
  format?: ValueFormat
  currency?: string
  truncated?: boolean
  /** The same metric over the comparison window, when one ran. */
  previous?: number | null
  target?: number
  sparkline?: { labels: string[]; values: number[] }
}

/** Where a row leads: an in-app path, or a record opened with its app's entity opener. */
export type RecordLink =
  | { kind: "path"; href: string }
  | { kind: "entity"; app: string; entityType: string; id: string }

export interface TableData {
  kind: "table"
  columns: DashboardColumn[]
  rows: Array<Record<string, unknown>>
  /** The server left rows out past its limit. */
  truncated?: boolean
  /** Each row's record link, index by index (when the block declares one). */
  links?: Array<RecordLink | null>
}

/** How a chart is drawn (absent keys: the default). */
export interface ChartDisplay {
  stacked?: boolean
  horizontal?: boolean
  /** A combo's series drawn as lines; the rest are bars. */
  lineSeries?: string[]
  /** A combo's lines read against a right-hand axis. */
  secondaryAxis?: boolean
  /** A smooth curve between points (absent: straight segments). */
  curve?: "smooth"
  /** A layered chart: the series drawn against the right-hand axis. */
  rightAxis?: string[]
}

/** One headline figure over the block's window: a total, a series' total, or a computed figure. */
export interface HeadlineFigure {
  /** "total", a series name, a layer id (a layer's total), or a computed figure's label. */
  key: string
  label: string
  value: number | null
  /** The same figure over the comparison window, when one ran. */
  previous?: number | null
  /** A layered chart: the layer the figure comes from. */
  layer?: string
  /** Computed from the layers' totals. */
  calc?: true
}

/** A layered (blended) chart's layer as drawn: its series, or why it failed. */
export interface ChartLayer {
  id: string
  label: string
  as: "bar" | "line"
  axis: "left" | "right"
  /** Its series names, as in the chart's `series`. */
  series: string[]
  format?: ValueFormat
  currency?: string
  /** This layer failed: it draws nothing, the others still show. */
  error?: { error: BlockErrorKind; message?: string }
  previousError?: { error: BlockErrorKind; message?: string }
}

export interface SeriesData {
  kind: "bar" | "line" | "area" | "combo"
  x: Array<string | number>
  series: Array<{ name: string; values: Array<number | null> }>
  format?: ValueFormat
  currency?: string
  truncated?: boolean
  previous?: PreviousSeries
  display?: ChartDisplay
  /** The period's figures, shown above the chart. */
  headline?: HeadlineFigure[]
  /** The label of the bucket that holds today: still filling, drawn dotted. */
  inProgressLabel?: string
  /** A blended chart's layers, in the block's order. */
  layers?: ChartLayer[]
}

/** Stages in order and each one's value: the conversion between steps is worked out here. */
export interface FunnelData {
  kind: "funnel"
  labels: string[]
  values: number[]
  format?: ValueFormat
  currency?: string
  truncated?: boolean
}

/** A note: markdown, rendered sanitized (never trusted as HTML). */
export interface TextData {
  kind: "text"
  markdown: string
  truncated?: undefined
}

export interface PieData {
  kind: "pie"
  labels: Array<string | number>
  values: Array<number | null>
  format?: ValueFormat
  currency?: string
  truncated?: boolean
}

export type BlockData = MetricData | TableData | SeriesData | PieData | FunnelData | TextData

/**
 * Why a block shows no data. The server's: `no_access`, `not_allowed`, `rate_limited`,
 * `unknown_tool` (the source is gone: an app removed or turned off) and `invalid_map` (the
 * block no longer fits its source's data), both permanent until the dashboard changes, and
 * `source_error` (the source failed this time). The rest are the wire's.
 */
export type BlockErrorKind =
  | "no_access"
  | "not_allowed"
  | "rate_limited"
  | "unknown_tool"
  | "invalid_map"
  | "source_error"
  | "not_found"
  | "network"

export type BlockResult =
  | { ok: true; data: BlockData; info?: BlockReadInfo }
  | {
      ok: false
      error: BlockErrorKind
      message?: string
      retryAfter?: number
      info?: BlockReadInfo
    }

/** The slice of the shell's API client these reads need. */
export interface DashboardsApi {
  get: <T = unknown>(
    path: string,
    init?: { signal?: AbortSignal; suppressGlobalError?: boolean; userInitiated?: boolean },
  ) => Promise<T>
}

/** The writes the viewer-state calls need. */
export interface DashboardsWriteApi {
  put: <T = unknown>(
    path: string,
    body?: unknown,
    init?: { suppressGlobalError?: boolean },
  ) => Promise<T>
  delete: <T = unknown>(
    path: string,
    body?: unknown,
    init?: { suppressGlobalError?: boolean },
  ) => Promise<T>
}

const SERVER_ERRORS: ReadonlySet<string> = new Set([
  "no_access",
  "not_allowed",
  "rate_limited",
  "unknown_tool",
  "invalid_map",
  "source_error",
])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** A thrown read, as the block's calm state. Never rethrows. */
export function blockErrorFrom(err: unknown): Extract<BlockResult, { ok: false }> {
  if (err instanceof ApiError) {
    const code = typeof err.code === "string" ? err.code : undefined
    if (code && SERVER_ERRORS.has(code)) {
      return {
        ok: false,
        error: code as BlockErrorKind,
        message: err.message,
        retryAfter: err.retryAfter,
      }
    }
    if (err.status === 429) return { ok: false, error: "rate_limited", retryAfter: err.retryAfter }
    if (err.status === 401 || err.status === 403) return { ok: false, error: "no_access" }
    if (err.status === 404) return { ok: false, error: "not_found" }
    if (err.status === 0) return { ok: false, error: "network" }
    return { ok: false, error: "source_error", message: err.message }
  }
  if (err instanceof TypeError) return { ok: false, error: "network" }
  return { ok: false, error: "source_error" }
}

function windowFrom(v: unknown): BlockWindow | undefined {
  if (!isRecord(v)) return undefined
  if (v.mode === "dashboard" && typeof v.from === "string" && typeof v.to === "string") {
    return { mode: "dashboard", preset: v.preset as TimePreset, from: v.from, to: v.to }
  }
  if (v.mode === "fixed") {
    const dates = Array.isArray(v.dates)
      ? v.dates.filter(
          (d): d is { token: string; date: string } =>
            isRecord(d) && typeof d.token === "string" && typeof d.date === "string",
        )
      : []
    return { mode: "fixed", dates }
  }
  return undefined
}

function compareWindowFrom(v: unknown): BlockCompareWindow | null | undefined {
  if (v === null) return null
  if (
    isRecord(v) &&
    (v.mode === "lastYear" || v.mode === "previousPeriod") &&
    typeof v.from === "string" &&
    typeof v.to === "string"
  ) {
    return { mode: v.mode, from: v.from, to: v.to }
  }
  return undefined
}

/** The read's context (when, which days, rows left out), whatever its outcome. */
function infoFrom(body: Record<string, unknown>): BlockReadInfo | undefined {
  const meta = isRecord(body.meta) ? body.meta : {}
  const info: BlockReadInfo = {}
  if (typeof body.computedAt === "string") info.computedAt = body.computedAt
  const window = windowFrom(body.window)
  if (window) info.window = window
  const cw = compareWindowFrom(body.compareWindow)
  if (cw !== undefined) info.compareWindow = cw
  if (typeof meta.sourceRows === "number") info.sourceRows = meta.sourceRows
  if (typeof meta.skippedRows === "number" && meta.skippedRows > 0) {
    info.skippedRows = meta.skippedRows
  }
  if (isRecord(body.previousError) && typeof body.previousError.error === "string") {
    info.previousError = {
      error: body.previousError.error,
      ...(typeof body.previousError.message === "string"
        ? { message: body.previousError.message }
        : {}),
    }
  }
  return Object.keys(info).length ? info : undefined
}

function previousSeriesFrom(v: unknown): PreviousSeries | undefined {
  if (!isRecord(v) || !Array.isArray(v.labels) || !Array.isArray(v.series)) return undefined
  return {
    labels: v.labels as PreviousSeries["labels"],
    series: v.series as PreviousSeries["series"],
  }
}

function displayFrom(v: unknown): ChartDisplay | undefined {
  if (!isRecord(v)) return undefined
  const d: ChartDisplay = {}
  if (v.stacked === true) d.stacked = true
  if (v.horizontal === true) d.horizontal = true
  if (Array.isArray(v.lineSeries)) {
    d.lineSeries = v.lineSeries.filter((n): n is string => typeof n === "string")
  }
  if (v.secondaryAxis === true) d.secondaryAxis = true
  if (v.curve === "smooth") d.curve = "smooth"
  if (Array.isArray(v.rightAxis)) {
    d.rightAxis = v.rightAxis.filter((n): n is string => typeof n === "string")
  }
  return Object.keys(d).length ? d : undefined
}

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null

function headlineFrom(v: unknown): HeadlineFigure[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: HeadlineFigure[] = []
  for (const f of v) {
    if (!isRecord(f) || typeof f.key !== "string") continue
    out.push({
      key: f.key,
      label: typeof f.label === "string" ? f.label : f.key,
      value: numOrNull(f.value),
      ...(f.previous !== undefined ? { previous: numOrNull(f.previous) } : {}),
      ...(typeof f.layer === "string" ? { layer: f.layer } : {}),
      ...(f.calc === true ? { calc: true as const } : {}),
    })
  }
  return out.length ? out : undefined
}

function layerErrorFrom(v: unknown): { error: BlockErrorKind; message?: string } | undefined {
  if (!isRecord(v) || typeof v.error !== "string") return undefined
  return {
    error: SERVER_ERRORS.has(v.error) ? (v.error as BlockErrorKind) : "source_error",
    ...(typeof v.message === "string" ? { message: v.message } : {}),
  }
}

function layersFrom(v: unknown): ChartLayer[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: ChartLayer[] = []
  for (const l of v) {
    if (!isRecord(l) || typeof l.id !== "string") continue
    const meta = isRecord(l.meta) ? l.meta : {}
    const error = layerErrorFrom(l.error)
    const previousError = layerErrorFrom(l.previousError)
    out.push({
      id: l.id,
      label: typeof l.label === "string" ? l.label : l.id,
      as: l.as === "line" ? "line" : "bar",
      axis: l.axis === "right" ? "right" : "left",
      series: Array.isArray(l.series)
        ? l.series.filter((n): n is string => typeof n === "string")
        : [],
      ...(typeof meta.format === "string" ? { format: meta.format as ValueFormat } : {}),
      ...(typeof meta.currency === "string" ? { currency: meta.currency } : {}),
      ...(error ? { error } : {}),
      ...(previousError ? { previousError } : {}),
    })
  }
  return out.length ? out : undefined
}

/**
 * A record link as the server sent it, checked: a path stays inside the app (starts with one
 * "/", never "//" or a URL); an entity names its app, type and id. Anything else is no link.
 */
export function recordLinkFrom(v: unknown): RecordLink | null {
  if (!isRecord(v)) return null
  if (v.kind === "path" && typeof v.href === "string" && isAppPath(v.href)) {
    return { kind: "path", href: v.href }
  }
  if (
    v.kind === "entity" &&
    typeof v.app === "string" &&
    v.app !== "" &&
    typeof v.entityType === "string" &&
    v.entityType !== "" &&
    typeof v.id === "string" &&
    v.id !== ""
  ) {
    return { kind: "entity", app: v.app, entityType: v.entityType, id: v.id }
  }
  return null
}

/** An in-app path: "/" then anything but a second "/" or a backslash (never another origin). */
export function isAppPath(href: string): boolean {
  if (!/^\/(?![/\\])/.test(href) || /\s/.test(href)) return false
  for (let i = 0; i < href.length; i++) if (href.charCodeAt(i) < 0x20) return false
  return true
}

/** What the server answered for a block, checked: an unknown shape is a source error. */
export function parseBlockResponse(body: unknown): BlockResult {
  if (!isRecord(body)) return { ok: false, error: "source_error" }
  const info = infoFrom(body)
  const withInfo = info ? { info } : {}
  if (typeof body.error === "string") {
    const error = SERVER_ERRORS.has(body.error) ? (body.error as BlockErrorKind) : "source_error"
    return {
      ok: false,
      error,
      message: typeof body.message === "string" ? body.message : undefined,
      retryAfter: typeof body.retryAfter === "number" ? body.retryAfter : undefined,
      ...withInfo,
    }
  }
  // The server's own shape (modules/dashboards/transform.ts): bar, line and pie
  // all carry `labels` + `series`, and the format rides in `meta`. `x` and a
  // pie's flat `values` are read too.
  const meta = isRecord(body.meta) ? body.meta : {}
  const format = (body.format ?? meta.format) as ValueFormat | undefined
  const currency = (body.currency ?? meta.currency) as string | undefined
  const truncated = meta.truncated === true ? { truncated: true } : {}
  const shown = {
    ...(format ? { format } : {}),
    ...(currency ? { currency } : {}),
    ...truncated,
  }
  switch (body.kind) {
    case "metric": {
      const v = body.value
      if (v === null || v === undefined || typeof v === "number" || typeof v === "string") {
        const extras: Partial<MetricData> = {}
        if (typeof body.previous === "number" || body.previous === null) {
          extras.previous = body.previous as number | null
        }
        if (typeof body.target === "number") extras.target = body.target
        if (
          isRecord(body.sparkline) &&
          Array.isArray(body.sparkline.labels) &&
          Array.isArray(body.sparkline.values)
        ) {
          extras.sparkline = {
            labels: body.sparkline.labels as string[],
            values: body.sparkline.values as number[],
          }
        }
        return {
          ok: true,
          data: { kind: "metric", value: v ?? null, ...shown, ...extras },
          ...withInfo,
        }
      }
      return { ok: false, error: "source_error" }
    }
    case "table":
      if (Array.isArray(body.columns) && Array.isArray(body.rows)) {
        const links = Array.isArray(body.links) ? body.links.map(recordLinkFrom) : undefined
        return {
          ok: true,
          data: {
            kind: "table",
            columns: body.columns as DashboardColumn[],
            rows: body.rows as TableData["rows"],
            ...truncated,
            ...(links ? { links } : {}),
          },
          ...withInfo,
        }
      }
      return { ok: false, error: "source_error" }
    case "bar":
    case "line":
    case "area":
    case "combo": {
      const x = Array.isArray(body.x) ? body.x : body.labels
      if (Array.isArray(x) && Array.isArray(body.series)) {
        const previous = previousSeriesFrom(body.previous)
        const display = displayFrom(body.display)
        const headline = headlineFrom(body.headline)
        const layers = layersFrom(body.layers)
        return {
          ok: true,
          data: {
            kind: body.kind,
            x,
            series: body.series as SeriesData["series"],
            ...shown,
            ...(previous ? { previous } : {}),
            ...(display ? { display } : {}),
            ...(headline ? { headline } : {}),
            ...(typeof body.inProgressLabel === "string"
              ? { inProgressLabel: body.inProgressLabel }
              : {}),
            ...(layers ? { layers } : {}),
          },
          ...withInfo,
        }
      }
      return { ok: false, error: "source_error" }
    }
    case "funnel": {
      const first = Array.isArray(body.series) && isRecord(body.series[0]) ? body.series[0] : null
      if (Array.isArray(body.labels) && Array.isArray(first?.values)) {
        return {
          ok: true,
          data: {
            kind: "funnel",
            labels: body.labels.map((l) => String(l)),
            values: (first.values as unknown[]).map((v) => (typeof v === "number" ? v : 0)),
            ...shown,
          },
          ...withInfo,
        }
      }
      return { ok: false, error: "source_error" }
    }
    case "text":
      if (typeof body.markdown === "string") {
        return { ok: true, data: { kind: "text", markdown: body.markdown }, ...withInfo }
      }
      return { ok: false, error: "source_error" }
    case "pie": {
      const first = Array.isArray(body.series) && isRecord(body.series[0]) ? body.series[0] : null
      const values = Array.isArray(body.values) ? body.values : first?.values
      if (Array.isArray(body.labels) && Array.isArray(values)) {
        return {
          ok: true,
          data: { kind: "pie", labels: body.labels, values: values as PieData["values"], ...shown },
          ...withInfo,
        }
      }
      return { ok: false, error: "source_error" }
    }
    default:
      return { ok: false, error: "source_error" }
  }
}

/** A list answer, whether the server sends the array or `{items}`. */
function listFrom(body: unknown): DashboardSummary[] {
  const rows = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.items)
      ? body.items
      : isRecord(body) && Array.isArray(body.dashboards)
        ? body.dashboards
        : []
  return rows.filter(
    (r): r is DashboardSummary =>
      isRecord(r) && typeof r.id === "string" && typeof r.title === "string",
  )
}

/** The viewer's dashboards: their personal ones and the org's. */
export async function listDashboards(
  api: DashboardsApi,
  init?: { signal?: AbortSignal },
): Promise<DashboardSummary[]> {
  const body = await api.get<unknown>("/dashboards", { ...init, suppressGlobalError: true })
  return listFrom(body)
}

/** One dashboard with its spec. A missing one rejects with the API's 404. */
export async function getDashboard(
  api: DashboardsApi,
  id: string,
  init?: { signal?: AbortSignal },
): Promise<Dashboard> {
  const body = await api.get<unknown>(`/dashboards/${encodeURIComponent(id)}`, {
    ...init,
    suppressGlobalError: true,
  })
  return dashboardFrom(body)
}

// At most four block reads in flight from this page: the server runs each
// block as a tool call, and caps a viewer's parallel runs at the same number.
const MAX_IN_FLIGHT = 4
let inFlight = 0
const waiting: Array<() => void> = []

/**
 * Runs `run` in one of the page's slots. A finishing read hands its slot straight to the next
 * waiter (the count never drops in between), so a newcomer can never slip past the queue and
 * make five. A read whose view closed while it waited gives its slot on without running.
 */
async function withSlot<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve))
  else inFlight++
  try {
    return signal?.aborted ? null : await run()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else inFlight--
  }
}

export const DashboardsClientTestAccess = {
  inFlight: () => inFlight,
  withSlot,
}

/** Each filter's values as query parameters: `f.<id>=v` per value, `f.<id>=` for all. */
export function appendFilterParams(q: URLSearchParams, filters: FilterValues | undefined): void {
  if (!filters) return
  for (const id of Object.keys(filters).sort()) {
    const values = filters[id] ?? []
    if (values.length === 0) q.append(`f.${id}`, "")
    else for (const v of values) q.append(`f.${id}`, v)
  }
}

function appendRange(q: URLSearchParams, r: RangeChoice | undefined, withCompare: boolean): void {
  if (!r) return
  q.set("range", r.timeRange.preset)
  if (r.timeRange.preset === "custom") {
    q.set("from", r.timeRange.from ?? "")
    q.set("to", r.timeRange.to ?? "")
  }
  if (withCompare) q.set("compare", r.compare)
}

/**
 * The block-data query: refresh, the range the viewer looks at and the filter values shown
 * (always sent when given).
 */
export function blockDataQuery(opts?: {
  refresh?: boolean
  range?: RangeChoice
  filters?: FilterValues
}): string {
  const q = new URLSearchParams()
  if (opts?.refresh) q.set("refresh", "1")
  appendRange(q, opts?.range, true)
  appendFilterParams(q, opts?.filters)
  const s = q.toString()
  return s ? `?${s}` : ""
}

/** One block's data, run as the viewer. Never rejects: a failure is the block's state. */
export function getBlockData(
  api: DashboardsApi,
  dashboardId: string,
  blockId: string,
  opts?: { refresh?: boolean; signal?: AbortSignal; range?: RangeChoice; filters?: FilterValues },
): Promise<BlockResult> {
  const path = `/dashboards/${encodeURIComponent(dashboardId)}/blocks/${encodeURIComponent(blockId)}/data${blockDataQuery(opts)}`
  const read = withSlot(async () => {
    try {
      const body = await api.get<unknown>(path, {
        signal: opts?.signal,
        suppressGlobalError: true,
        userInitiated: opts?.refresh === true,
      })
      return parseBlockResponse(body)
    } catch (err) {
      return blockErrorFrom(err)
    }
  }, opts?.signal)
  // Cancelled before it ran: the view that asked is gone, nothing is shown.
  return read.then((r) => r ?? { ok: false, error: "network" })
}

const viewerStatePath = (id: string) => `/dashboards/${encodeURIComponent(id)}/viewer-state`

/** Remembers this person's range on this dashboard (theirs alone). */
export async function saveViewerRange(
  api: DashboardsWriteApi,
  dashboardId: string,
  choice: RangeChoice,
): Promise<void> {
  await api.put(viewerStatePath(dashboardId), choice, { suppressGlobalError: true })
}

/** Remembers this person's filter values on this dashboard; `{}` forgets them. */
/** The most the server remembers of a person's filter values (with room for its own encoding). */
export const MAX_SAVED_FILTERS_BYTES = 15_000

export async function saveViewerFilters(
  api: DashboardsWriteApi,
  dashboardId: string,
  filters: FilterValues,
): Promise<void> {
  // Values too long to remember stay in this tab and its link only.
  if (new TextEncoder().encode(JSON.stringify(filters)).length > MAX_SAVED_FILTERS_BYTES) return
  await api.put(viewerStatePath(dashboardId), { filters }, { suppressGlobalError: true })
}

/** Forgets this person's range AND filters: the dashboard opens on its defaults again. */
export async function clearViewerRange(
  api: DashboardsWriteApi,
  dashboardId: string,
): Promise<void> {
  await api.delete(viewerStatePath(dashboardId), undefined, { suppressGlobalError: true })
}

// ── drill-down ───────────────────────────────────────────────────────────────

/** Which figure of a block the rows are asked for. None: every row the block aggregates. */
export interface DrillTarget {
  /** A chart's category, as in its `labels`. */
  category?: string
  /** A split series' name. */
  series?: string
  /** A table's row index. */
  row?: number
  /** A comparison series was picked: the rows come from the comparison window. */
  previous?: boolean
  /** A blended chart: the layer whose rows to read. */
  layer?: string
}

export interface BlockRowsPage {
  columns: DashboardColumn[]
  /** The fields the source's rows carry (names only): what a filter can read. */
  fields: string[]
  rows: Array<Record<string, unknown>>
  links: Array<RecordLink | null> | null
  total: number
  offset: number
  limit: number
  nextOffset: number | null
  /** The source had more rows than the server searches. */
  truncated: boolean
  computedAt?: string
}

export type BlockRowsResult =
  | { ok: true; page: BlockRowsPage }
  | { ok: false; error: BlockErrorKind; message?: string }

export const DRILL_PAGE_SIZE = 50

/** The rows query: the figure, the page, the range (no comparison) and the filter values. */
export function blockRowsQuery(opts: {
  target?: DrillTarget
  offset?: number
  limit?: number
  range?: RangeChoice
  filters?: FilterValues
}): string {
  const q = new URLSearchParams()
  const t = opts.target
  if (t?.category !== undefined) q.set("category", t.category)
  if (t?.series !== undefined) q.set("series", t.series)
  if (t?.row !== undefined) q.set("row", String(t.row))
  if (t?.layer !== undefined) q.set("layer", t.layer)
  q.set("offset", String(opts.offset ?? 0))
  q.set("limit", String(opts.limit ?? DRILL_PAGE_SIZE))
  appendRange(q, opts.range, false)
  appendFilterParams(q, opts.filters)
  return `?${q.toString()}`
}

/** The server's rows answer, checked. */
export function parseRowsResponse(body: unknown): BlockRowsResult {
  if (!isRecord(body)) return { ok: false, error: "source_error" }
  if (typeof body.error === "string") {
    return {
      ok: false,
      error: SERVER_ERRORS.has(body.error) ? (body.error as BlockErrorKind) : "source_error",
      message: typeof body.message === "string" ? body.message : undefined,
    }
  }
  if (!Array.isArray(body.columns) || !Array.isArray(body.rows)) {
    return { ok: false, error: "source_error" }
  }
  const rows = body.rows as Array<Record<string, unknown>>
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d)
  return {
    ok: true,
    page: {
      columns: body.columns as DashboardColumn[],
      fields: Array.isArray(body.fields)
        ? body.fields.filter((f): f is string => typeof f === "string")
        : [],
      rows,
      links: Array.isArray(body.links) ? body.links.map(recordLinkFrom) : null,
      total: num(body.total, rows.length),
      offset: num(body.offset, 0),
      limit: num(body.limit, DRILL_PAGE_SIZE),
      nextOffset: typeof body.nextOffset === "number" ? body.nextOffset : null,
      truncated: body.truncated === true,
      ...(typeof body.computedAt === "string" ? { computedAt: body.computedAt } : {}),
    },
  }
}

/** One page of the rows behind a figure, read as the viewer. Never rejects. */
export async function getBlockRows(
  api: DashboardsApi,
  dashboardId: string,
  blockId: string,
  opts: {
    target?: DrillTarget
    offset?: number
    limit?: number
    range?: RangeChoice
    filters?: FilterValues
    signal?: AbortSignal
  },
): Promise<BlockRowsResult> {
  const path = `/dashboards/${encodeURIComponent(dashboardId)}/blocks/${encodeURIComponent(blockId)}/rows${blockRowsQuery(opts)}`
  try {
    const body = await api.get<unknown>(path, { signal: opts.signal, suppressGlobalError: true })
    return parseRowsResponse(body)
  } catch (err) {
    return blockErrorFrom(err)
  }
}

// ── filter options ───────────────────────────────────────────────────────────

export type FilterOptionsResult =
  | { ok: true; options: string[]; truncated: boolean }
  | { ok: false; error: BlockErrorKind; message?: string }

/** The values a filter offers, for the range and the other filters' values shown. */
export async function getFilterOptions(
  api: DashboardsApi,
  dashboardId: string,
  filterId: string,
  opts: { range?: RangeChoice; filters?: FilterValues; signal?: AbortSignal; q?: string },
): Promise<FilterOptionsResult> {
  const q = new URLSearchParams()
  appendRange(q, opts.range, false)
  appendFilterParams(q, opts.filters)
  const search = opts.q?.trim()
  if (search) q.set("q", search)
  const s = q.toString()
  const path = `/dashboards/${encodeURIComponent(dashboardId)}/filters/${encodeURIComponent(filterId)}/options${s ? `?${s}` : ""}`
  try {
    const body = await api.get<unknown>(path, { signal: opts.signal, suppressGlobalError: true })
    if (!isRecord(body)) return { ok: false, error: "source_error" }
    if (typeof body.error === "string") {
      return {
        ok: false,
        error: SERVER_ERRORS.has(body.error) ? (body.error as BlockErrorKind) : "source_error",
        message: typeof body.message === "string" ? body.message : undefined,
      }
    }
    const options = Array.isArray(body.options)
      ? body.options.filter((o): o is string => typeof o === "string")
      : []
    return { ok: true, options, truncated: body.truncated === true }
  } catch (err) {
    return blockErrorFrom(err)
  }
}

// ── editing, history, duplicate (step 3) ─────────────────────────────────────

/** Where a block goes: an index (0 = first), or before / after another block. */
export type BlockPosition = number | { before: string } | { after: string }

/** A person's change to a dashboard (the same operations the agent's edit tool takes). */
export type EditOperation =
  | { op: "moveBlock"; blockId: string; position: BlockPosition }
  | { op: "resizeBlock"; blockId: string; width?: BlockWidth; height?: BlockHeight }
  | {
      op: "updateBlock"
      blockId: string
      /** map merges key by key (null removes a key); layers is replaced whole. */
      changes: {
        title?: string
        map?: Record<string, unknown>
        layers?: DashboardLayerSpec[]
      }
    }
  | { op: "setFilter"; filter: DashboardFilterDef; position?: number }
  | { op: "removeFilter"; id: string }
  | { op: "duplicateBlock"; blockId: string; title?: string; position?: BlockPosition }
  | { op: "removeBlock"; blockId: string }
  | { op: "setTitle"; title: string }
  | { op: "setDescription"; description: string | null }
  | { op: "revert"; toVersion: number }

/** The calls that change a dashboard. */
export interface DashboardsEditApi {
  post: <T = unknown>(
    path: string,
    body?: unknown,
    init?: { suppressGlobalError?: boolean },
  ) => Promise<T>
}

const dashPath = (id: string) => `/dashboards/${encodeURIComponent(id)}`

/** A dashboard record as the server answered it (a GET, an edit, a copy), checked. */
function dashboardFrom(body: unknown): Dashboard {
  const row = isRecord(body) && isRecord(body.dashboard) ? body.dashboard : body
  if (!isRecord(row) || !isRecord(row.spec)) throw new ApiError("Not found", 404, "not_found")
  const spec = row.spec as unknown as DashboardSpec
  return {
    ...(row as unknown as Dashboard),
    spec: { ...spec, blocks: Array.isArray(spec.blocks) ? spec.blocks : [] },
  }
}

/**
 * Applies `operations` to the dashboard at `ifVersion`, all or nothing, and answers it as it
 * is now. Rejects with the API's error: 409 VERSION_CONFLICT when someone saved in between.
 */
export async function editDashboard(
  api: DashboardsEditApi,
  id: string,
  ifVersion: number,
  operations: EditOperation[],
): Promise<Dashboard> {
  const body = await api.post<unknown>(
    `${dashPath(id)}/edit`,
    { ifVersion, operations },
    { suppressGlobalError: true },
  )
  return dashboardFrom(body)
}

/** Was this rejection a stale version (someone else saved first)? */
export function isVersionConflict(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 409 || err.code === "VERSION_CONFLICT")
}

/** A personal copy of the dashboard for the caller. */
export async function duplicateDashboard(
  api: DashboardsEditApi,
  id: string,
  title?: string,
): Promise<Dashboard> {
  const body = await api.post<unknown>(`${dashPath(id)}/duplicate`, title ? { title } : {}, {
    suppressGlobalError: true,
  })
  return dashboardFrom(body)
}

export interface DashboardVersionSummary {
  version: number
  title: string
  savedAt: string
  savedBy: string | null
  savedByName: string | null
  blockCount: number
  current: boolean
}

export interface DashboardVersionDetail {
  version: number
  title: string
  spec: DashboardSpec
  savedAt: string
  savedBy: string | null
  savedByName: string | null
}

/** The saved versions, newest first. */
export async function listVersions(
  api: DashboardsApi,
  id: string,
  init?: { signal?: AbortSignal },
): Promise<DashboardVersionSummary[]> {
  const body = await api.get<unknown>(`${dashPath(id)}/versions`, {
    ...init,
    suppressGlobalError: true,
  })
  const rows = isRecord(body) && Array.isArray(body.versions) ? body.versions : []
  return rows.filter(
    (r): r is DashboardVersionSummary =>
      isRecord(r) && typeof r.version === "number" && typeof r.title === "string",
  )
}

/** One saved version with its blocks. */
export async function getVersion(
  api: DashboardsApi,
  id: string,
  version: number,
  init?: { signal?: AbortSignal },
): Promise<DashboardVersionDetail> {
  const body = await api.get<unknown>(`${dashPath(id)}/versions/${version}`, {
    ...init,
    suppressGlobalError: true,
  })
  if (!isRecord(body) || !isRecord(body.spec)) throw new ApiError("Not found", 404, "not_found")
  const spec = body.spec as unknown as DashboardSpec
  return {
    ...(body as unknown as DashboardVersionDetail),
    spec: { ...spec, blocks: Array.isArray(spec.blocks) ? spec.blocks : [] },
  }
}

// ── exports ──────────────────────────────────────────────────────────────────

/** The query an export carries: the range and the filter values the view shows. */
export function exportQuery(opts: { range?: RangeChoice; filters?: FilterValues }): string {
  const q = new URLSearchParams()
  appendRange(q, opts.range, true)
  appendFilterParams(q, opts.filters)
  const s = q.toString()
  return s ? `?${s}` : ""
}

/** The dashboard's PDF, for the range and filters shown. */
export function dashboardPdfPath(
  id: string,
  opts: { range?: RangeChoice; filters?: FilterValues },
): string {
  return `${dashPath(id)}/export.pdf${exportQuery(opts)}`
}

/** A block's CSV: its mapped `data`, or the raw `rows` behind it. */
export function blockCsvPath(
  id: string,
  blockId: string,
  kind: "data" | "rows",
  opts: { range?: RangeChoice; filters?: FilterValues },
): string {
  return `${dashPath(id)}/blocks/${encodeURIComponent(blockId)}/${kind}.csv${exportQuery(opts)}`
}

/** The file name a download answer gives (`Content-Disposition`), else `fallback`. */
export function downloadName(disposition: string | null, fallback: string): string {
  const m = disposition ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition) : null
  if (!m?.[1]) return fallback
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

/** The raw download a file export needs. */
export interface DashboardsDownloadApi {
  rawGet: (path: string, init?: { suppressGlobalError?: boolean }) => Promise<Response>
}

/** Downloads an export to the person's machine. Rejects with the API's error. */
export async function downloadExport(
  api: DashboardsDownloadApi,
  path: string,
  fallbackName: string,
  save: (blob: Blob, name: string) => void = saveBlob,
): Promise<void> {
  const res = await api.rawGet(path, { suppressGlobalError: true })
  const blob = await res.blob()
  save(blob, downloadName(res.headers.get("Content-Disposition"), fallbackName))
}

/** Saves a blob through a temporary link. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

// ---------------------------------------------------------------------------
// TABLES: org data people and agents write (the dashboards module's own rows).
//
//   GET|POST /dashboards/tables                      the tables the caller sees; create one
//   GET|PATCH|DELETE /dashboards/tables/:id          one table: its columns, settings, deletion
//   GET /dashboards/tables/:id/rows                  a page of rows (`limit`, `cursor`, `sort`, `dir`, `q`)
//   POST /dashboards/tables/:id/rows                 add, update or delete rows, all or none
//   GET /dashboards/tables/:id/changes               the change history (`rowId` narrows it)
//   POST /dashboards/tables/:id/changes/:id/undo     undoes one change
//   GET|PUT /dashboards/tables/:id/sharing           who sees and edits it (as a dashboard's)
//
// Every read and write runs as the caller (row-level security): a table they cannot see answers
// as if it did not exist.

export type TableColumnType =
  | "text"
  | "number"
  | "amount"
  | "date"
  | "choice"
  | "choices"
  | "checkbox"
  | "person"
  | "link"

export const TABLE_COLUMN_TYPES: TableColumnType[] = [
  "text",
  "number",
  "amount",
  "date",
  "choice",
  "choices",
  "checkbox",
  "person",
  "link",
]

export interface TableColumn {
  /** Immutable once the column exists; `^[a-z][a-z0-9_]{0,39}$`. */
  key: string
  label: string
  type: TableColumnType
  required?: boolean
  /** A choice or choices column's values, in order. */
  choices?: string[]
  /** An amount column's currency (ISO 4217). */
  currency?: string
  /** A link column may point only at this app (and entity type). */
  linkTo?: { app: string; entityType?: string }
}

export interface LinkCell {
  app: string
  entityType: string
  id: string
  label: string
}

/** Who made a change, as it reads: "Nico", "@support", "Routine Inbound follow-up". */
export interface TableActor {
  type: "user" | "agent" | "system"
  id: string | null
  label: string
}

export type TableRole = "viewer" | "editor" | "owner"

export interface TableInfo {
  id: string
  name: string
  description?: string
  columns: TableColumn[]
  agentWritesNeedApproval: boolean
  orgAccess: "none" | "viewer" | "editor"
  myRole: TableRole
  rowCount: number
  version: number
  updatedAt: string
  /** Keys of dropped columns: retired, never re-added. */
  droppedKeys: string[]
  /** A table backed by an app's records (a project's tasks): its rows are those records. */
  backing?: TableBackingInfo
}

/** What a table is backed by: one parent record's records (e.g. a project's tasks). */
export interface TableBacking {
  app: string
  entity: string
  parentId: string
  /** The record values shown, read through (for tasks: title, status, assignee, ...). */
  fields: string[]
}

export interface TableBackingInfo extends TableBacking {
  /** The read-through column keys (first in `columns`): editing one changes the record. */
  readThrough: string[]
  /** The table's own column keys, kept per record in the table. */
  own: string[]
}

/** Keys the row itself uses: no column may take them. */
export const RESERVED_COLUMN_KEYS: ReadonlySet<string> = new Set([
  "id",
  "updated_at",
  "updated_by",
  "created_at",
])

export type TableCells = Record<string, unknown>

export interface TableRow {
  id: string
  cells: TableCells
  version: number
  updatedAt: string
  updatedBy: TableActor
}

export interface TableChange {
  id: string
  rowId: string
  op: "create" | "update" | "delete" | "undo"
  before: TableCells | null
  after: TableCells | null
  actor: TableActor
  at: string
  undoable: boolean
}

export type TableRowOp =
  | { op: "add"; cells: TableCells }
  | { op: "update"; id: string; ifVersion: number; cells: TableCells }
  | { op: "delete"; id: string; ifVersion: number }

export type TableRowResult = TableRow | { id: string; deleted: true }

/** Column changes of one PATCH, applied together. */
export interface TableColumnOps {
  add?: TableColumn[]
  rename?: Array<{ key: string; label: string }>
  setChoices?: Array<{ key: string; choices: string[] }>
  drop?: string[]
}

export interface TablePatch {
  name?: string
  description?: string
  agentWritesNeedApproval?: boolean
  columns?: TableColumnOps
}

export type TableErrorCode =
  | "invalid_cell"
  | "invalid_request"
  | "version_conflict"
  /** A table of that name exists already (409). */
  | "conflict"
  | "not_found"
  | "forbidden"
  | "limit"
  | "unknown"

/** A refused table read or write, as the screens show it. */
export interface TableError {
  code: TableErrorCode
  message?: string
  column?: string
  rowId?: string
  /** A version conflict's row as it is now. */
  current?: TableRow
}

export interface TablesApi {
  get: DashboardsApi["get"]
  post: <T = unknown>(
    path: string,
    body?: unknown,
    init?: { suppressGlobalError?: boolean },
  ) => Promise<T>
  patch: <T = unknown>(
    path: string,
    body?: unknown,
    init?: { suppressGlobalError?: boolean },
  ) => Promise<T>
  delete: <T = unknown>(
    path: string,
    body?: unknown,
    init?: { suppressGlobalError?: boolean },
  ) => Promise<T>
}

export const TABLE_PAGE_SIZE = 50
const QUIET = { suppressGlobalError: true }

function tablesPath(id?: string): string {
  return id ? `/dashboards/tables/${encodeURIComponent(id)}` : "/dashboards/tables"
}

// The API answers in the `{data}` envelope; the api client hands back its payload.

const TABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_cell",
  "invalid_request",
  "version_conflict",
  "conflict",
  "not_found",
  "forbidden",
  "limit",
])

function rowFrom(v: unknown): TableRow | undefined {
  if (!isRecord(v) || typeof v.id !== "string" || !isRecord(v.cells)) return undefined
  return v as unknown as TableRow
}

/**
 * A thrown table call, as its code and the column, row or current row it names. The fields are
 * read from the error's `details` (where the API client keeps the structured part of a refusal),
 * so a conflict carries the row as it is now when the server sends it.
 */
export function tableErrorFrom(err: unknown): TableError {
  if (!(err instanceof ApiError)) return { code: "unknown" }
  const d = err.details ?? {}
  const raw = typeof err.code === "string" ? err.code.toLowerCase() : ""
  const code: TableErrorCode = TABLE_ERROR_CODES.has(raw)
    ? (raw as TableErrorCode)
    : err.status === 409
      ? "version_conflict"
      : err.status === 404
        ? "not_found"
        : err.status === 403
          ? "forbidden"
          : "unknown"
  const current = rowFrom(d.current)
  return {
    code,
    ...(err.message ? { message: err.message } : {}),
    ...(typeof d.column === "string" ? { column: d.column } : {}),
    ...(typeof d.rowId === "string" ? { rowId: d.rowId } : {}),
    ...(current ? { current } : {}),
  }
}

/** The tables the caller can see. */
export async function listTables(api: Pick<TablesApi, "get">): Promise<TableInfo[]> {
  const body = await api.get<unknown>(tablesPath(), QUIET)
  const rows = isRecord(body) && Array.isArray(body.tables) ? body.tables : []
  return rows.filter(
    (t): t is TableInfo => isRecord(t) && typeof t.id === "string" && typeof t.name === "string",
  )
}

/** A new table (the caller owns it). A name already taken answers `conflict`. */
export async function createTable(
  api: Pick<TablesApi, "post">,
  input: { name: string; description?: string; columns?: TableColumn[]; backing?: TableBacking },
): Promise<TableInfo> {
  return (await api.post<unknown>(tablesPath(), { columns: [], ...input }, QUIET)) as TableInfo
}

export async function getTable(api: Pick<TablesApi, "get">, id: string): Promise<TableInfo> {
  return (await api.get<unknown>(tablesPath(id), QUIET)) as TableInfo
}

/** Changes the table at `ifVersion` (settings and column operations together). */
export async function patchTable(
  api: Pick<TablesApi, "patch">,
  id: string,
  ifVersion: number,
  patch: TablePatch,
): Promise<TableInfo> {
  return (await api.patch<unknown>(tablesPath(id), { ifVersion, ...patch }, QUIET)) as TableInfo
}

export interface TableRowsQuery {
  cursor?: string | null
  sort?: string
  dir?: "asc" | "desc"
  q?: string
  limit?: number
}

export interface TableRowsPage {
  rows: TableRow[]
  nextCursor: string | null
}

export function tableRowsQuery(opts: TableRowsQuery = {}): string {
  const q = new URLSearchParams({ limit: String(opts.limit ?? TABLE_PAGE_SIZE) })
  if (opts.cursor) q.set("cursor", opts.cursor)
  if (opts.sort) {
    q.set("sort", opts.sort)
    q.set("dir", opts.dir ?? "asc")
  }
  if (opts.q?.trim()) q.set("q", opts.q.trim())
  return q.toString()
}

export async function getTableRows(
  api: Pick<TablesApi, "get">,
  id: string,
  opts: TableRowsQuery = {},
): Promise<TableRowsPage> {
  const body = await api.get<unknown>(`${tablesPath(id)}/rows?${tableRowsQuery(opts)}`, QUIET)
  const rows = isRecord(body) && Array.isArray(body.rows) ? body.rows : []
  return {
    rows: rows.map(rowFrom).filter((r): r is TableRow => !!r),
    nextCursor: isRecord(body) && typeof body.nextCursor === "string" ? body.nextCursor : null,
  }
}

/** Applies the operations all or none; answers each row as it is now (or that it is gone). */
export async function writeTableRows(
  api: Pick<TablesApi, "post">,
  id: string,
  ops: TableRowOp[],
): Promise<TableRowResult[]> {
  const body = await api.post<unknown>(`${tablesPath(id)}/rows`, { ops }, QUIET)
  return isRecord(body) && Array.isArray(body.rows) ? (body.rows as TableRowResult[]) : []
}

export function isDeletedRow(r: TableRowResult): r is { id: string; deleted: true } {
  return (r as { deleted?: boolean }).deleted === true
}

export interface TableChangesPage {
  changes: TableChange[]
  nextCursor: string | null
}

export async function getTableChanges(
  api: Pick<TablesApi, "get">,
  id: string,
  opts: { rowId?: string; limit?: number; cursor?: string | null } = {},
): Promise<TableChangesPage> {
  const q = new URLSearchParams({ limit: String(opts.limit ?? TABLE_PAGE_SIZE) })
  if (opts.rowId) q.set("rowId", opts.rowId)
  if (opts.cursor) q.set("cursor", opts.cursor)
  const body = await api.get<unknown>(`${tablesPath(id)}/changes?${q}`, QUIET)
  const changes = isRecord(body) && Array.isArray(body.changes) ? body.changes : []
  return {
    changes: changes.filter(
      (c): c is TableChange => isRecord(c) && typeof c.id === "string" && isRecord(c.actor),
    ),
    nextCursor: isRecord(body) && typeof body.nextCursor === "string" ? body.nextCursor : null,
  }
}

/** Writes a change's before cells back (a new change). Rejects on a conflict. */
export async function undoTableChange(
  api: Pick<TablesApi, "post">,
  id: string,
  changeId: string,
): Promise<TableRow | null> {
  const body = await api.post<unknown>(
    `${tablesPath(id)}/changes/${encodeURIComponent(changeId)}/undo`,
    {},
    QUIET,
  )
  return rowFrom(body) ?? null
}

/** One record a link column may point at, from `GET /dashboards/tables/link-search`. */
export interface LinkPickItem {
  id: string
  label: string
  app: string
  entityType: string
}

/**
 * Records of `app` (and `entityType`) matching `q`, read as the caller: the search index for a
 * searchable entity, else the app's own pick tool (the server chooses).
 */
export async function searchTableLinks(
  api: Pick<TablesApi, "get">,
  opts: { app?: string; entityType?: string; q: string },
): Promise<LinkPickItem[]> {
  const q = new URLSearchParams({ q: opts.q })
  if (opts.app) q.set("app", opts.app)
  if (opts.entityType) q.set("entityType", opts.entityType)
  const body = await api.get<unknown>(`${tablesPath()}/link-search?${q}`, QUIET)
  const items = isRecord(body) && Array.isArray(body.items) ? body.items : []
  return items.filter(
    (i): i is LinkPickItem =>
      isRecord(i) &&
      typeof i.id === "string" &&
      typeof i.label === "string" &&
      typeof i.app === "string" &&
      typeof i.entityType === "string",
  )
}

/** The sharing routes of a table (same shape as a dashboard's). */
export function tableSharingPath(id: string): string {
  return `${tablesPath(id)}/sharing`
}

/** An editable table block: a `table` block on a table source with `map.editable`. */
export function editableTableOf(
  block: Pick<DashboardBlockSpec, "type" | "source" | "map">,
): { tableId: string; columns?: string[]; staleAfterDays?: number } | null {
  const src = block.source
  if (block.type !== "table" || !src || src.kind !== "table" || typeof src.table !== "string") {
    return null
  }
  if (block.map?.editable !== true) return null
  // `map.columns` names the column keys to show, in order (a dashboard table's map may still
  // carry `{field}` objects: their fields count the same).
  const cols = Array.isArray(block.map.columns)
    ? (block.map.columns as unknown[])
        .map((c) =>
          typeof c === "string" ? c : isRecord(c) && typeof c.field === "string" ? c.field : null,
        )
        .filter((c): c is string => !!c)
    : undefined
  const stale = block.map.staleAfterDays
  return {
    tableId: src.table,
    ...(cols && cols.length > 0 ? { columns: cols } : {}),
    ...(typeof stale === "number" && stale > 0 ? { staleAfterDays: stale } : {}),
  }
}
