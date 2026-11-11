// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dashboard's spec (kernel.dashboards.spec), version 1: a grid of at most 24
// blocks, each one chart (metric, table, bar, line, pie) over one source (a
// read-only tool, or a declared collection of the app data store) and a `map`
// that the server applies to the source's rows (transform.ts). The schema
// checks the shape and what each chart type needs; whether a source may feed a
// dashboard at all is sources.ts's question, asked at save and at every run.

import { z } from "zod"
import {
  COMPARE_MODES,
  type CompareMode,
  DEFAULT_COMPARE,
  DEFAULT_TIME_RANGE,
  dateTokenProblems,
  hasRangeTokens,
  TIME_PRESETS,
  type TimeRange,
  timeRangeProblems,
} from "~/modules/dashboards/relative-dates"

export const DASHBOARD_SPEC_VERSION = 1
export const MAX_DASHBOARD_BLOCKS = 24
export const BLOCK_TYPES = ["metric", "table", "bar", "line", "pie"] as const
export type BlockType = (typeof BLOCK_TYPES)[number]
export const AGGREGATIONS = ["sum", "count", "avg", "min", "max"] as const
export type Aggregation = (typeof AGGREGATIONS)[number]
export const DATE_BUCKETS = ["day", "week", "month"] as const
export type DateBucket = (typeof DATE_BUCKETS)[number]
export const VALUE_FORMATS = ["number", "currency", "percent", "date"] as const

/** A block's refresh interval bounds, in seconds. */
export const MIN_REFRESH_SEC = 60
export const MAX_REFRESH_SEC = 86_400
/** What a block's data is cached for when it names no interval. */
export const DEFAULT_REFRESH_SEC = 60
/** The longest a block's data is cached, tool or store source, whatever the block asks (review #8). */
export const MAX_SOURCE_TTL_SEC = 900
/** The most source rows the transform reads; the rest are dropped and the block says so. */
export const MAX_SOURCE_ROWS = 2_000
/** The most rows, groups or slices a block shows. */
export const MAX_BLOCK_OUTPUT = 100
/** Most series (lines or bar groups) one chart draws: the largest by total are kept. */
export const MAX_BLOCK_SERIES = 20
export const MAX_TABLE_COLUMNS = 20

/** How a block takes its dates: the dashboard's range, or its own. */
export const BLOCK_RANGE_MODES = ["dashboard", "fixed"] as const
export type BlockRangeMode = (typeof BLOCK_RANGE_MODES)[number]

/** A dashboard time range: a preset, or "custom" with from and to (YYYY-MM-DD, inclusive). */
export const timeRangeSchema = z
  .object({
    preset: z.enum(TIME_PRESETS),
    from: z.string().max(10).optional(),
    to: z.string().max(10).optional(),
  })
  .strict()
  .superRefine((tr, ctx) => {
    for (const message of timeRangeProblems(tr)) ctx.addIssue({ code: "custom", message })
  })

/** A field of a source row: a key, or a dotted path into nested objects (`billing.country`). */
const fieldPath = z
  .string()
  .max(200)
  .regex(
    /^[A-Za-z_$][A-Za-z0-9_$-]*(\.[A-Za-z0-9_$-]+)*$/,
    "a field is a key or a dotted path such as billing.country",
  )

const toolName = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z0-9_-]*:[A-Za-z0-9_.-]+$/, "a tool is named <app>:<tool>, e.g. tickets:search")

export const toolSourceSchema = z
  .object({
    kind: z.literal("tool"),
    tool: toolName,
    params: z.record(z.string(), z.unknown()).default({}),
    /** Where the rows are in the tool's result, when it is not the result itself or its only list. */
    rowsPath: fieldPath.optional(),
  })
  .strict()

export const storeSourceSchema = z
  .object({
    kind: z.literal("store"),
    app: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
    collection: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    /** The data store query (where, orderBy, limit, cursor); the store validates it. */
    query: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()

export const blockSourceSchema = z.discriminatedUnion("kind", [toolSourceSchema, storeSourceSchema])

const columnSchema = z
  .object({
    field: fieldPath,
    label: z.string().min(1).max(80),
    format: z.enum(VALUE_FORMATS).optional(),
  })
  .strict()

export const blockMapSchema = z
  .object({
    x: fieldPath.optional(),
    y: fieldPath.optional(),
    series: fieldPath.optional(),
    value: fieldPath.optional(),
    label: fieldPath.optional(),
    columns: z.array(columnSchema).min(1).max(MAX_TABLE_COLUMNS).optional(),
    format: z.enum(VALUE_FORMATS).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, "an ISO 4217 code such as EUR")
      .optional(),
    groupBy: z
      .object({ field: fieldPath, bucket: z.enum(DATE_BUCKETS).optional() })
      .strict()
      .optional(),
    agg: z.enum(AGGREGATIONS).optional(),
    sort: z
      .object({ field: fieldPath, dir: z.enum(["asc", "desc"]).default("asc") })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(MAX_BLOCK_OUTPUT).optional(),
    /** A metric's goal, shown beside its value. */
    target: z.number().finite().optional(),
    /** A metric's trend: the same aggregation per date bucket of `field`, from the same rows. */
    sparkline: z
      .object({ field: fieldPath, bucket: z.enum(DATE_BUCKETS).default("day") })
      .strict()
      .optional(),
  })
  .strict()

export type BlockSource = z.infer<typeof blockSourceSchema>
export type ToolSource = z.infer<typeof toolSourceSchema>
export type StoreSource = z.infer<typeof storeSourceSchema>
export type BlockMap = z.infer<typeof blockMapSchema>

/** What each chart type needs from its map, as a list of plain-words problems. */
export function mapProblems(type: BlockType, map: BlockMap): string[] {
  const out: string[] = []
  const agg = map.agg
  switch (type) {
    case "metric":
      if (!map.value && agg !== "count") {
        out.push('a metric needs map.value (the field to aggregate), or map.agg "count"')
      }
      if (map.groupBy || map.x || map.series || map.columns) {
        out.push("a metric takes map.value, map.agg, map.target and map.sparkline only")
      }
      break
    case "table":
      if (!map.columns) out.push("a table needs map.columns: [{field, label}]")
      if (map.groupBy || map.agg) out.push("a table shows rows: it takes no groupBy or agg")
      break
    case "bar":
    case "line":
      if (!map.groupBy && !map.x) {
        out.push(`a ${type} chart needs map.groupBy {field, bucket?} or map.x (the category field)`)
      }
      if (!map.y && agg !== "count") {
        out.push(`a ${type} chart needs map.y (the field to aggregate), or map.agg "count"`)
      }
      break
    case "pie":
      if (!map.groupBy && !map.label) {
        out.push("a pie chart needs map.groupBy {field} or map.label (the slice field)")
      }
      if (!map.value && agg !== "count") {
        out.push('a pie chart needs map.value (the field to aggregate), or map.agg "count"')
      }
      if (map.series) out.push("a pie chart has no series")
      break
  }
  if (type !== "metric" && (map.target !== undefined || map.sparkline)) {
    out.push("map.target and map.sparkline are for a metric only")
  }
  if (map.groupBy && map.x && map.groupBy.field !== map.x) {
    out.push("map.groupBy.field and map.x name the same thing: give one of them")
  }
  return out
}

export const dashboardBlockSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, "a block id is up to 40 letters, digits, - or _"),
    type: z.enum(BLOCK_TYPES),
    title: z.string().min(1).max(120),
    width: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
    source: blockSourceSchema,
    map: blockMapSchema.default({}),
    refreshSec: z.number().int().min(MIN_REFRESH_SEC).max(MAX_REFRESH_SEC).optional(),
    /**
     * "dashboard": the block follows the dashboard's time range through its {{range.*}} tokens
     * (and is compared). "fixed": its own dates. Absent: "dashboard" when its source uses a
     * range token, else "fixed" (every block saved before ranges existed).
     */
    timeRange: z.enum(BLOCK_RANGE_MODES).optional(),
  })
  .strict()
  .superRefine((block, ctx) => {
    for (const message of mapProblems(block.type, block.map)) {
      ctx.addIssue({ code: "custom", path: ["map"], message })
    }
    // Date tokens ({{today-30d}}) resolve at every run (relative-dates.ts); an unknown one is
    // refused here, at save and preview, never sent to a tool as written.
    const [field, value] =
      block.source.kind === "tool"
        ? (["params", block.source.params] as const)
        : (["query", block.source.query] as const)
    for (const message of dateTokenProblems(value, "")) {
      ctx.addIssue({ code: "custom", path: ["source", field], message })
    }
    const usesRange = hasRangeTokens(value)
    if (block.timeRange === "fixed" && usesRange) {
      ctx.addIssue({
        code: "custom",
        path: ["timeRange"],
        message:
          'a "fixed" block cannot use {{range.from}} / {{range.to}}: use your own dates, or timeRange "dashboard"',
      })
    }
    if (block.timeRange === "dashboard" && !usesRange) {
      ctx.addIssue({
        code: "custom",
        path: ["timeRange"],
        message: `a block that follows the dashboard range puts {{range.from}} and {{range.to}} in its source ${field}`,
      })
    }
  })

export type DashboardBlock = z.infer<typeof dashboardBlockSchema>

export const dashboardSpecSchema = z
  .object({
    v: z.literal(DASHBOARD_SPEC_VERSION),
    layout: z.literal("grid").default("grid"),
    /** The range a viewer sees first (each person's own choice is remembered apart). */
    timeRange: timeRangeSchema.optional(),
    /** What the blocks that follow the range are compared with by default. */
    compare: z.enum(COMPARE_MODES).optional(),
    blocks: z.array(dashboardBlockSchema).max(MAX_DASHBOARD_BLOCKS),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const seen = new Set<string>()
    spec.blocks.forEach((block, i) => {
      if (seen.has(block.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["blocks", i, "id"],
          message: `block id '${block.id}' is used twice`,
        })
      }
      seen.add(block.id)
    })
  })

export type DashboardSpec = z.infer<typeof dashboardSpecSchema>

/** Zod's issues as one line each, `blocks.2.map: a table needs ...`. */
export function specIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`)
}

/** How long a block's data is cached: its interval, capped for every source. */
export function blockTtlSec(block: Pick<DashboardBlock, "refreshSec">): number {
  return Math.min(block.refreshSec ?? DEFAULT_REFRESH_SEC, MAX_SOURCE_TTL_SEC)
}

/** How a block takes its dates (see dashboardBlockSchema.timeRange). */
export function blockRangeMode(
  block: Pick<DashboardBlock, "timeRange" | "source">,
): BlockRangeMode {
  if (block.timeRange) return block.timeRange
  const value = block.source.kind === "tool" ? block.source.params : block.source.query
  return hasRangeTokens(value) ? "dashboard" : "fixed"
}

/** The range and comparison a dashboard opens on: its spec's, else the defaults. */
export function dashboardDefaultRange(spec: Pick<DashboardSpec, "timeRange" | "compare">): {
  timeRange: TimeRange
  compare: CompareMode
} {
  return {
    timeRange: spec.timeRange ?? DEFAULT_TIME_RANGE,
    compare: spec.compare ?? DEFAULT_COMPARE,
  }
}
