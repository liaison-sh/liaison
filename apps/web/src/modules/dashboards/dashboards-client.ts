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
//   GET|PUT|DELETE /dashboards/:id/viewer-state      the range this person last chose
//
// A block's data is either one of the four shapes below, or a refusal
// `{error: "no_access" | "not_allowed" | "rate_limited" | "source_error"}`
// that concerns that block alone. The rest of the dashboard renders.
import { ApiError } from "~/lib/api-error"
import type { CompareMode, DayWindow, RangeChoice, TimePreset, TimeRange } from "./time-range"

export type DashboardVisibility = "personal" | "org"
export type DashboardBlockType = "metric" | "table" | "bar" | "line" | "pie"
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
  sparkline?: { field: string; bucket?: "day" | "week" | "month" }
  [key: string]: unknown
}

export interface DashboardBlockSpec {
  id: string
  type: DashboardBlockType
  title: string
  width: 1 | 2 | 3
  source: Record<string, unknown>
  map?: DashboardBlockMap
  refreshSec?: number
  /** Follows the dashboard's range, or keeps its own window. The server says which (`blockTimeRange`). */
  timeRange?: BlockRangeMode
}

export type BlockRangeMode = "dashboard" | "fixed"

export interface DashboardSpec {
  v: 1
  layout: "grid"
  blocks: DashboardBlockSpec[]
  timeRange?: TimeRange
  compare?: CompareMode
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

export interface TableData {
  kind: "table"
  columns: DashboardColumn[]
  rows: Array<Record<string, unknown>>
  /** The server left rows out past its limit. */
  truncated?: boolean
}

export interface SeriesData {
  kind: "bar" | "line"
  x: Array<string | number>
  series: Array<{ name: string; values: Array<number | null> }>
  format?: ValueFormat
  currency?: string
  truncated?: boolean
  previous?: PreviousSeries
}

export interface PieData {
  kind: "pie"
  labels: Array<string | number>
  values: Array<number | null>
  format?: ValueFormat
  currency?: string
  truncated?: boolean
}

export type BlockData = MetricData | TableData | SeriesData | PieData

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
        return {
          ok: true,
          data: {
            kind: "table",
            columns: body.columns as DashboardColumn[],
            rows: body.rows as TableData["rows"],
            ...truncated,
          },
          ...withInfo,
        }
      }
      return { ok: false, error: "source_error" }
    case "bar":
    case "line": {
      const x = Array.isArray(body.x) ? body.x : body.labels
      if (Array.isArray(x) && Array.isArray(body.series)) {
        const previous = previousSeriesFrom(body.previous)
        return {
          ok: true,
          data: {
            kind: body.kind,
            x,
            series: body.series as SeriesData["series"],
            ...shown,
            ...(previous ? { previous } : {}),
          },
          ...withInfo,
        }
      }
      return { ok: false, error: "source_error" }
    }
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
  const row = isRecord(body) && isRecord(body.dashboard) ? body.dashboard : body
  if (!isRecord(row) || !isRecord(row.spec)) throw new ApiError("Not found", 404, "not_found")
  const spec = row.spec as unknown as DashboardSpec
  return {
    ...(row as unknown as Dashboard),
    spec: { ...spec, blocks: Array.isArray(spec.blocks) ? spec.blocks : [] },
  }
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

/** The block-data query: refresh, and the range the viewer looks at (always sent when given). */
export function blockDataQuery(opts?: { refresh?: boolean; range?: RangeChoice }): string {
  const q = new URLSearchParams()
  if (opts?.refresh) q.set("refresh", "1")
  const r = opts?.range
  if (r) {
    q.set("range", r.timeRange.preset)
    if (r.timeRange.preset === "custom") {
      q.set("from", r.timeRange.from ?? "")
      q.set("to", r.timeRange.to ?? "")
    }
    q.set("compare", r.compare)
  }
  const s = q.toString()
  return s ? `?${s}` : ""
}

/** One block's data, run as the viewer. Never rejects: a failure is the block's state. */
export function getBlockData(
  api: DashboardsApi,
  dashboardId: string,
  blockId: string,
  opts?: { refresh?: boolean; signal?: AbortSignal; range?: RangeChoice },
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

/** Forgets this person's range: the dashboard opens on its default again. */
export async function clearViewerRange(
  api: DashboardsWriteApi,
  dashboardId: string,
): Promise<void> {
  await api.delete(viewerStatePath(dashboardId), undefined, { suppressGlobalError: true })
}
