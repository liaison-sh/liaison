// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE WEB APP'S ONE VIEW OF THE DASHBOARDS API. Every dashboard read the web
// app makes goes through here, so the wire shape lives in one place:
//
//   GET /dashboards                                  the viewer's personal + org dashboards
//   GET /dashboards/:id                              one dashboard and its spec
//   GET /dashboards/:id/blocks/:blockId/data[?refresh=1]
//                                                    one block's mapped data, run as the viewer
//
// A block's data is either one of the four shapes below, or a refusal
// `{error: "no_access" | "not_allowed" | "rate_limited" | "source_error"}`
// that concerns that block alone. The rest of the dashboard renders.
import { ApiError } from "~/lib/api-error"

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
}

export interface DashboardSpec {
  v: 1
  layout: "grid"
  blocks: DashboardBlockSpec[]
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
}

export interface MetricData {
  kind: "metric"
  value: number | string | null
  format?: ValueFormat
  currency?: string
  truncated?: boolean
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
  | { ok: true; data: BlockData }
  | { ok: false; error: BlockErrorKind; message?: string; retryAfter?: number }

/** The slice of the shell's API client these reads need. */
export interface DashboardsApi {
  get: <T = unknown>(
    path: string,
    init?: { signal?: AbortSignal; suppressGlobalError?: boolean; userInitiated?: boolean },
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

/** What the server answered for a block, checked: an unknown shape is a source error. */
export function parseBlockResponse(body: unknown): BlockResult {
  if (!isRecord(body)) return { ok: false, error: "source_error" }
  if (typeof body.error === "string") {
    const error = SERVER_ERRORS.has(body.error) ? (body.error as BlockErrorKind) : "source_error"
    return {
      ok: false,
      error,
      message: typeof body.message === "string" ? body.message : undefined,
      retryAfter: typeof body.retryAfter === "number" ? body.retryAfter : undefined,
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
        return { ok: true, data: { kind: "metric", value: v ?? null, ...shown } }
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
        }
      }
      return { ok: false, error: "source_error" }
    case "bar":
    case "line": {
      const x = Array.isArray(body.x) ? body.x : body.labels
      if (Array.isArray(x) && Array.isArray(body.series)) {
        return {
          ok: true,
          data: { kind: body.kind, x, series: body.series as SeriesData["series"], ...shown },
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

/** One block's data, run as the viewer. Never rejects: a failure is the block's state. */
export function getBlockData(
  api: DashboardsApi,
  dashboardId: string,
  blockId: string,
  opts?: { refresh?: boolean; signal?: AbortSignal },
): Promise<BlockResult> {
  const path = `/dashboards/${encodeURIComponent(dashboardId)}/blocks/${encodeURIComponent(blockId)}/data${opts?.refresh ? "?refresh=1" : ""}`
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
