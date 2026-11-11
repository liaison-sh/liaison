// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dashboard's spec (kernel.dashboards.spec), version 1: a grid of at most 24
// blocks, each one chart (metric, table, bar, line, area, pie, combo, funnel) over
// one source (a read-only tool, or a declared collection of the app data store) and
// a `map` that the server applies to the source's rows (transform.ts), or a text
// note (markdown, no source). A source is the block's own, or a shared dataset
// (`spec.datasets`, run once for every block that names it). Dashboard filters
// (`spec.filters`) reach a source through `{{filter.<id>}}` tokens and the rows
// through `map.where` (filters.ts). The schema checks the shape and what each chart
// type needs; whether a source may feed a dashboard at all is sources.ts's
// question, asked at save and at every run.

import { z } from "zod"
import {
  COMPARE_MODES,
  type CompareMode,
  DEFAULT_COMPARE,
  DEFAULT_TIME_RANGE,
  dateTokenProblems,
  filterTokensIn,
  hasRangeTokens,
  TIME_PRESETS,
  type TimeRange,
  timeRangeProblems,
} from "~/modules/dashboards/relative-dates"

export const DASHBOARD_SPEC_VERSION = 1
export const MAX_DASHBOARD_BLOCKS = 24
export const BLOCK_TYPES = [
  "metric",
  "table",
  "bar",
  "line",
  "pie",
  "area",
  "combo",
  "funnel",
  "text",
] as const
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
/** Shared sources one dashboard declares. */
export const MAX_DATASETS = 12
/** Filters one dashboard declares. */
export const MAX_FILTERS = 8
/** Static options one filter lists. */
export const MAX_FILTER_OPTIONS = 100
/** Row conditions one block's map.where holds. */
export const MAX_WHERE = 10
/** A text block's markdown. */
export const MAX_TEXT_LENGTH = 4_000
export const MAX_MEASURES = 6
export const MAX_FUNNEL_STAGES = 12

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

export const FILTER_ID = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
export const DATASET_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
const filterId = z
  .string()
  .regex(FILTER_ID, "a filter id is a letter then up to 39 letters, digits or _")
const datasetId = z
  .string()
  .regex(DATASET_ID, "a dataset id is a letter then up to 39 letters, digits, - or _")

export const WHERE_OPS = [
  "eq",
  "neq",
  "in",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "empty",
  "notEmpty",
] as const
export type WhereOp = (typeof WHERE_OPS)[number]
const scalar = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()])

export const whereClauseSchema = z
  .object({
    field: fieldPath,
    op: z.enum(WHERE_OPS),
    /** A value, a list (for in), or a dashboard filter's current value. */
    value: z
      .union([scalar, z.array(scalar).max(100), z.object({ filter: filterId }).strict()])
      .optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    const needsNone = w.op === "empty" || w.op === "notEmpty"
    if (needsNone && w.value !== undefined) {
      ctx.addIssue({ code: "custom", message: `where op "${w.op}" takes no value` })
    }
    if (!needsNone && w.value === undefined) {
      ctx.addIssue({ code: "custom", message: `where op "${w.op}" needs a value` })
    }
    if (Array.isArray(w.value) && w.op !== "in" && w.op !== "contains") {
      ctx.addIssue({ code: "custom", message: `a list of values goes with op "in"` })
    }
  })
export type WhereClause = z.infer<typeof whereClauseSchema>

/** An app path such as /shopify/orders/{{id}}: never a URL, so a link cannot leave the app. */
const linkTemplate = z
  .string()
  .max(300)
  .regex(
    /^\/(?!\/)[^\s\\]*$/,
    "a link is an app path starting with / such as /tickets/{{id}}, never a full URL",
  )
export const linkSchema = z.union([
  linkTemplate,
  z
    .object({
      entity: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,62}$/),
      idField: fieldPath,
      app: z
        .string()
        .regex(/^[a-z][a-z0-9_-]{0,62}$/)
        .optional(),
    })
    .strict(),
])

const measureSchema = z
  .object({
    label: z.string().min(1).max(80),
    field: fieldPath.optional(),
    agg: z.enum(AGGREGATIONS).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (!m.field && m.agg && m.agg !== "count") {
      ctx.addIssue({ code: "custom", message: `"${m.label}" needs a field for agg ${m.agg}` })
    }
  })

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
    /** Row conditions applied to the source's rows before anything else (filters.ts). */
    where: z.array(whereClauseSchema).max(MAX_WHERE).optional(),
    /** Where a row leads: an app path template, or a record the app opens. */
    link: linkSchema.optional(),
    /** What a drill-down shows of each row. */
    drillColumns: z.array(columnSchema).min(1).max(MAX_TABLE_COLUMNS).optional(),
    /** bar, area, combo: series stacked. */
    stacked: z.boolean().optional(),
    /** bar: categories down the side. */
    horizontal: z.boolean().optional(),
    /** bar, line, area, combo: several values per category, one series each. */
    measures: z.array(measureSchema).min(1).max(MAX_MEASURES).optional(),
    /** combo: the series drawn as lines (default the last one); the others are bars. */
    lineSeries: z.array(z.string().min(1).max(120)).min(1).max(MAX_BLOCK_SERIES).optional(),
    /** combo: the lines on their own axis, on the right. */
    secondaryAxis: z.boolean().optional(),
    /** funnel from fields: each stage one aggregation over all rows. */
    stages: z.array(measureSchema).min(2).max(MAX_FUNNEL_STAGES).optional(),
    /** funnel from categories: the stages in order (the category labels). */
    order: z.array(z.string().min(1).max(200)).min(1).max(MAX_FUNNEL_STAGES).optional(),
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
  const chart = type === "bar" || type === "line" || type === "area" || type === "combo"
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
    case "area":
    case "combo":
      if (!map.groupBy && !map.x) {
        out.push(`a ${type} chart needs map.groupBy {field, bucket?} or map.x (the category field)`)
      }
      if (map.measures) {
        if (map.y || map.series || map.agg) {
          out.push(
            "map.measures gives each series its own field and agg: no map.y, map.series or map.agg beside it",
          )
        }
      } else if (!map.y && agg !== "count") {
        out.push(
          `a ${type} chart needs map.y (the field to aggregate), map.agg "count", or map.measures`,
        )
      }
      if (type === "combo") {
        if (!map.series && (!map.measures || map.measures.length < 2)) {
          out.push(
            "a combo chart draws bars and lines: give map.measures (two or more) or map.series",
          )
        }
        if (map.measures && map.lineSeries) {
          const names = new Set(map.measures.map((m) => m.label))
          for (const n of map.lineSeries) {
            if (!names.has(n)) out.push(`map.lineSeries names '${n}', which is not a measure label`)
          }
        }
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
    case "funnel":
      if (map.stages) {
        if (map.groupBy || map.x || map.y || map.order || map.agg) {
          out.push(
            "a funnel takes map.stages (each a field and agg), or categories (map.x or map.groupBy, with map.y or agg, and map.order): not both",
          )
        }
      } else {
        if (!map.groupBy && !map.x) {
          out.push(
            "a funnel needs map.stages [{label, field, agg}], or map.x / map.groupBy (the stage field)",
          )
        }
        if (!map.y && agg !== "count") {
          out.push(
            'a funnel over categories needs map.y (the field to aggregate), or map.agg "count"',
          )
        }
      }
      if (map.series || map.groupBy?.bucket) out.push("a funnel has no series and no date bucket")
      break
    case "text":
      if (Object.keys(map).length) out.push("a text block has no map")
      break
  }
  if (type !== "metric" && (map.target !== undefined || map.sparkline)) {
    out.push("map.target and map.sparkline are for a metric only")
  }
  if (map.groupBy && map.x && map.groupBy.field !== map.x) {
    out.push("map.groupBy.field and map.x name the same thing: give one of them")
  }
  if (map.stacked && type !== "bar" && type !== "area" && type !== "combo") {
    out.push("map.stacked is for a bar, area or combo chart")
  }
  if (map.horizontal && type !== "bar") out.push("map.horizontal is for a bar chart")
  if (map.measures && !chart) out.push("map.measures is for a bar, line, area or combo chart")
  if (map.measures && new Set(map.measures.map((m) => m.label)).size !== map.measures.length) {
    out.push("each measure needs its own label")
  }
  if ((map.lineSeries || map.secondaryAxis) && type !== "combo") {
    out.push("map.lineSeries and map.secondaryAxis are for a combo chart")
  }
  if ((map.stages || map.order) && type !== "funnel") {
    out.push("map.stages and map.order are for a funnel")
  }
  return out
}

/** A filter's options: a static list, or the distinct values of a field of a dataset or a source. */
const filterOptionsSchema = z.union([
  z.array(z.string().min(1).max(200)).min(1).max(MAX_FILTER_OPTIONS),
  z.object({ fromDataset: datasetId, field: fieldPath }).strict(),
  z.object({ fromSource: blockSourceSchema, field: fieldPath }).strict(),
])

export const FILTER_TYPES = ["select", "multi", "text"] as const
export type FilterType = (typeof FILTER_TYPES)[number]

export const filterDefSchema = z
  .object({
    id: filterId,
    label: z.string().min(1).max(60),
    type: z.enum(FILTER_TYPES),
    options: filterOptionsSchema.optional(),
    default: z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.type === "text" && f.options) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "a text filter takes no options" })
    }
    if (f.type !== "text" && !f.options) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: `a ${f.type} filter needs options: a list, {fromDataset, field} or {fromSource, field}`,
      })
    }
    if (Array.isArray(f.default) && f.type !== "multi") {
      ctx.addIssue({
        code: "custom",
        path: ["default"],
        message: "only a multi filter defaults to a list",
      })
    }
    if (Array.isArray(f.options) && f.default !== undefined) {
      const allowed = new Set(f.options)
      for (const v of Array.isArray(f.default) ? f.default : [f.default]) {
        if (v !== "" && !allowed.has(v)) {
          ctx.addIssue({
            code: "custom",
            path: ["default"],
            message: `'${v}' is not one of the options`,
          })
        }
      }
    }
    if (f.options && !Array.isArray(f.options) && "fromSource" in f.options) {
      const src = f.options.fromSource
      const value = src.kind === "tool" ? src.params : src.query
      for (const message of dateTokenProblems(value, "options.fromSource")) {
        ctx.addIssue({ code: "custom", path: ["options"], message })
      }
      if (filterTokensIn(value).length) {
        ctx.addIssue({
          code: "custom",
          path: ["options"],
          message: "a filter's option source cannot read a filter",
        })
      }
    }
  })
export type FilterDef = z.infer<typeof filterDefSchema>

/** The params (tool) or query (store) of a source: where its tokens live. */
export function sourceValue(source: BlockSource): Record<string, unknown> {
  return source.kind === "tool" ? source.params : source.query
}

export const dashboardBlockSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, "a block id is up to 40 letters, digits, - or _"),
    type: z.enum(BLOCK_TYPES),
    title: z.string().min(1).max(120),
    width: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
    /** The block's own source; or `dataset`, a shared one; a text block has neither. */
    source: blockSourceSchema.optional(),
    dataset: datasetId.optional(),
    /** A text block's markdown. */
    text: z.string().min(1).max(MAX_TEXT_LENGTH).optional(),
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
    if (block.type === "text") {
      if (!block.text)
        ctx.addIssue({
          code: "custom",
          path: ["text"],
          message: "a text block needs text (markdown)",
        })
      if (block.source || block.dataset) {
        ctx.addIssue({ code: "custom", path: ["source"], message: "a text block reads no source" })
      }
      if (block.timeRange === "dashboard") {
        ctx.addIssue({ code: "custom", path: ["timeRange"], message: "a text block has no dates" })
      }
      return
    }
    if (block.text !== undefined) {
      ctx.addIssue({ code: "custom", path: ["text"], message: "only a text block has text" })
    }
    if (!block.source === !block.dataset) {
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "a block reads either its own source or a dataset (one of source, dataset)",
      })
    }
    if (!block.source) return // a dataset block: checked against the spec's datasets
    // Date tokens ({{today-30d}}) resolve at every run (relative-dates.ts); an unknown one is
    // refused here, at save and preview, never sent to a tool as written.
    const field = block.source.kind === "tool" ? "params" : "query"
    const value = sourceValue(block.source)
    for (const message of dateTokenProblems(value, "")) {
      ctx.addIssue({ code: "custom", path: ["source", field], message })
    }
    for (const message of rangeModeProblems(block.timeRange, value, field)) {
      ctx.addIssue({ code: "custom", path: ["timeRange"], message })
    }
  })

/** A block's declared time-range mode against the tokens its source holds. */
function rangeModeProblems(
  mode: BlockRangeMode | undefined,
  value: unknown,
  field: string,
): string[] {
  const usesRange = hasRangeTokens(value)
  if (mode === "fixed" && usesRange) {
    return [
      'a "fixed" block cannot use {{range.from}} / {{range.to}}: use your own dates, or timeRange "dashboard"',
    ]
  }
  if (mode === "dashboard" && !usesRange) {
    return [
      `a block that follows the dashboard range puts {{range.from}} and {{range.to}} in its source ${field}`,
    ]
  }
  return []
}

export type DashboardBlock = z.infer<typeof dashboardBlockSchema>

export const dashboardSpecSchema = z
  .object({
    v: z.literal(DASHBOARD_SPEC_VERSION),
    layout: z.literal("grid").default("grid"),
    /** The range a viewer sees first (each person's own choice is remembered apart). */
    timeRange: timeRangeSchema.optional(),
    /** What the blocks that follow the range are compared with by default. */
    compare: z.enum(COMPARE_MODES).optional(),
    /** Shared sources: each runs once per view for every block that names it. */
    datasets: z
      .record(datasetId, blockSourceSchema)
      .refine((d) => Object.keys(d).length <= MAX_DATASETS, `at most ${MAX_DATASETS} datasets`)
      .optional(),
    /** The dashboard's filters: their values reach sources ({{filter.<id>}}) and map.where. */
    filters: z.array(filterDefSchema).max(MAX_FILTERS).optional(),
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
    const datasets = spec.datasets ?? {}
    const filterIds = new Set<string>()
    for (const [i, f] of (spec.filters ?? []).entries()) {
      if (filterIds.has(f.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["filters", i, "id"],
          message: `filter id '${f.id}' is used twice`,
        })
      }
      filterIds.add(f.id)
      if (f.options && !Array.isArray(f.options) && "fromDataset" in f.options) {
        if (!datasets[f.options.fromDataset]) {
          ctx.addIssue({
            code: "custom",
            path: ["filters", i, "options"],
            message: `no dataset '${f.options.fromDataset}' in spec.datasets`,
          })
        }
      }
    }
    const unknownFilters = (value: unknown, path: (string | number)[]) => {
      for (const id of filterTokensIn(value)) {
        if (!filterIds.has(id)) {
          ctx.addIssue({
            code: "custom",
            path,
            message: `{{filter.${id}}} names no filter in spec.filters`,
          })
        }
      }
    }
    for (const [id, source] of Object.entries(datasets)) {
      const field = source.kind === "tool" ? "params" : "query"
      for (const message of dateTokenProblems(sourceValue(source), "")) {
        ctx.addIssue({ code: "custom", path: ["datasets", id, field], message })
      }
      unknownFilters(sourceValue(source), ["datasets", id, field])
    }
    const used = new Set<string>()
    spec.blocks.forEach((block, i) => {
      if (block.source) unknownFilters(sourceValue(block.source), ["blocks", i, "source"])
      for (const [w, clause] of (block.map.where ?? []).entries()) {
        const v = clause.value
        if (v && typeof v === "object" && !Array.isArray(v) && !filterIds.has(v.filter)) {
          ctx.addIssue({
            code: "custom",
            path: ["blocks", i, "map", "where", w],
            message: `names no filter '${v.filter}' in spec.filters`,
          })
        }
      }
      if (!block.dataset) return
      used.add(block.dataset)
      const source = datasets[block.dataset]
      if (!source) {
        ctx.addIssue({
          code: "custom",
          path: ["blocks", i, "dataset"],
          message: `no dataset '${block.dataset}' in spec.datasets`,
        })
        return
      }
      const field = source.kind === "tool" ? "params" : "query"
      for (const message of rangeModeProblems(
        block.timeRange,
        sourceValue(source),
        `(dataset ${block.dataset}) ${field}`,
      )) {
        ctx.addIssue({ code: "custom", path: ["blocks", i, "timeRange"], message })
      }
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
  block: Pick<DashboardBlock, "timeRange" | "source" | "dataset" | "type">,
  datasets: DashboardSpec["datasets"] = undefined,
): BlockRangeMode {
  if (block.type === "text") return "fixed"
  if (block.timeRange) return block.timeRange
  const source = blockSourceOf(block, datasets)
  return source && hasRangeTokens(sourceValue(source)) ? "dashboard" : "fixed"
}

/** The source a block reads: its own, or its dataset's (null for a text block or a missing dataset). */
export function blockSourceOf(
  block: Pick<DashboardBlock, "source" | "dataset">,
  datasets: DashboardSpec["datasets"] = undefined,
): BlockSource | null {
  if (block.source) return block.source
  if (block.dataset) return datasets?.[block.dataset] ?? null
  return null
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
