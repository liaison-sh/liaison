// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Editing a dashboard by operations: an ordered list (add, change, remove or move a
// block, set the title, the default time range or the visibility, set or remove a shared
// dataset or a filter) applied to the saved
// dashboard in one go (service.ts editDashboard), so an agent's request changes exactly
// what it names and one approval covers it. applyOperations is pure; the result is
// validated as a whole spec by the service, so a list either applies entirely or not at all.
//
// describeOperations writes one plain-language line per operation for the approval card
// (tools.ts): what changes, from where a block reads (tool or collection, its params with
// each date token and what it is today), its position, the range.

import { z } from "zod"
import {
  COMPARE_MODES,
  type CompareMode,
  DateTokenError,
  type DayWindow,
  dateTokensIn,
  resolveDateTokens,
  resolveTimeRange,
  type TimeRange,
} from "~/modules/dashboards/relative-dates"
import {
  type DashboardSpec,
  dashboardDefaultRange,
  MAX_DASHBOARD_BLOCKS,
  MAX_FILTERS,
  timeRangeSchema,
} from "~/modules/dashboards/spec"

/** The most operations one edit takes: each one is one line of its approval card. */
export const MAX_EDIT_OPERATIONS = 8

const blockId = z.string().min(1).max(40)
const blockRecord = z.record(z.string(), z.unknown())

/** Where a block goes: an index (0 is first), or before / after another block. */
const positionSchema = z.union([
  z.number().int().min(0).max(MAX_DASHBOARD_BLOCKS),
  z.object({ before: blockId }).strict(),
  z.object({ after: blockId }).strict(),
])
export type BlockPosition = z.infer<typeof positionSchema>

export const editOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("addBlock"),
      block: blockRecord.describe("The whole new block: {id, type, title, width?, source, map}."),
      position: positionSchema
        .optional()
        .describe("Index (0 = first), {before: blockId} or {after: blockId}. Default: the end."),
    })
    .strict(),
  z
    .object({
      op: z.literal("updateBlock"),
      blockId,
      changes: blockRecord.describe(
        "The block's fields to change. map and source.params / source.query merge key by key (null removes a key); any other field, source.tool included, is replaced. The id stays.",
      ),
    })
    .strict(),
  z.object({ op: z.literal("removeBlock"), blockId }).strict(),
  z.object({ op: z.literal("moveBlock"), blockId, position: positionSchema }).strict(),
  z.object({ op: z.literal("setTitle"), title: z.string().trim().min(1).max(200) }).strict(),
  z
    .object({
      op: z.literal("setTimeRange"),
      timeRange: timeRangeSchema
        .nullable()
        .optional()
        .describe("The range the dashboard opens on; null removes it (last 30 days)."),
      compare: z
        .enum(COMPARE_MODES)
        .nullable()
        .optional()
        .describe("The default comparison; null removes it (same period last year)."),
    })
    .strict(),
  z.object({ op: z.literal("setVisibility"), visibility: z.enum(["personal", "org"]) }).strict(),
  z
    .object({
      op: z.literal("setDataset"),
      id: z.string().min(1).max(40),
      source: blockRecord.describe(
        'The shared source, as a block\'s: {kind:"tool", tool, params, rowsPath?} or {kind:"store", app, collection, query}. Adds it, or replaces the one with this id.',
      ),
    })
    .strict(),
  z.object({ op: z.literal("removeDataset"), id: z.string().min(1).max(40) }).strict(),
  z
    .object({
      op: z.literal("setFilter"),
      filter: blockRecord.describe(
        "The whole filter: {id, label, type: select|multi|text, options?, default?}. Adds it, or replaces the one with this id.",
      ),
      position: z
        .number()
        .int()
        .min(0)
        .max(MAX_FILTERS)
        .optional()
        .describe("Its place in the filter bar (0 = first). Default: where it was, or the end."),
    })
    .strict(),
  z.object({ op: z.literal("removeFilter"), id: z.string().min(1).max(40) }).strict(),
])
export type EditOperation = z.infer<typeof editOperationSchema>

export class EditOperationError extends Error {
  constructor(
    readonly index: number,
    message: string,
  ) {
    super(`operations.${index}: ${message}`)
  }
}

export interface EditableDashboard {
  title: string
  visibility: "personal" | "org"
  spec: DashboardSpec
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

/** `base` with `patch` merged key by key; a null in `patch` removes that key. */
function mergeKeys(base: unknown, patch: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = isObject(base) ? { ...base } : {}
  if (!isObject(patch)) return out
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]
    else out[k] = v
  }
  return out
}

function mergeBlock(
  block: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...block }
  for (const [k, v] of Object.entries(changes)) {
    if (k === "id") continue
    if (k === "map") out.map = mergeKeys(block.map, v)
    else if (k === "source" && isObject(v)) {
      const old = isObject(block.source) ? block.source : {}
      const sameKind = v.kind === undefined || v.kind === old.kind
      const source: Record<string, unknown> = sameKind ? { ...old } : {}
      for (const [sk, sv] of Object.entries(v)) {
        if ((sk === "params" || sk === "query") && sameKind) source[sk] = mergeKeys(old[sk], sv)
        else if (sv === null) delete source[sk]
        else source[sk] = sv
      }
      out.source = source
    } else if (v === null) delete out[k]
    else out[k] = v
  }
  return out
}

function indexOf(blocks: Record<string, unknown>[], id: string): number {
  return blocks.findIndex((b) => b.id === id)
}

/** The index a position names in `blocks` (the block being placed already taken out). */
function resolvePosition(
  blocks: Record<string, unknown>[],
  position: BlockPosition | undefined,
  i: number,
): number {
  if (position === undefined) return blocks.length
  if (typeof position === "number") return Math.min(position, blocks.length)
  const ref = "before" in position ? position.before : position.after
  const at = indexOf(blocks, ref)
  if (at < 0) throw new EditOperationError(i, `no block '${ref}' to place it next to`)
  return "before" in position ? at : at + 1
}

/**
 * The dashboard after `operations`, in order. Throws EditOperationError naming the first
 * operation that cannot apply (an unknown block, a duplicate id). The spec it returns is
 * not yet validated: the service does that, on the whole.
 */
export function applyOperations(
  current: EditableDashboard,
  operations: EditOperation[],
): { title: string; visibility: "personal" | "org"; spec: Record<string, unknown> } {
  let title = current.title
  let visibility = current.visibility
  const spec: Record<string, unknown> = { ...(current.spec as unknown as Record<string, unknown>) }
  const blocks = ((current.spec.blocks ?? []) as unknown as Record<string, unknown>[]).map((b) => ({
    ...b,
  }))
  operations.forEach((op, i) => {
    switch (op.op) {
      case "addBlock": {
        const id = op.block.id
        if (typeof id === "string" && indexOf(blocks, id) >= 0) {
          throw new EditOperationError(i, `a block '${id}' is already on the dashboard`)
        }
        blocks.splice(resolvePosition(blocks, op.position, i), 0, { ...op.block })
        return
      }
      case "updateBlock": {
        const at = indexOf(blocks, op.blockId)
        if (at < 0) throw new EditOperationError(i, `no block '${op.blockId}'`)
        blocks[at] = mergeBlock(blocks[at]!, op.changes)
        return
      }
      case "removeBlock": {
        const at = indexOf(blocks, op.blockId)
        if (at < 0) throw new EditOperationError(i, `no block '${op.blockId}'`)
        blocks.splice(at, 1)
        return
      }
      case "moveBlock": {
        const at = indexOf(blocks, op.blockId)
        if (at < 0) throw new EditOperationError(i, `no block '${op.blockId}'`)
        const [moved] = blocks.splice(at, 1)
        blocks.splice(resolvePosition(blocks, op.position, i), 0, moved!)
        return
      }
      case "setTitle":
        title = op.title
        return
      case "setTimeRange":
        if (op.timeRange !== undefined) {
          if (op.timeRange === null) delete spec.timeRange
          else spec.timeRange = op.timeRange
        }
        if (op.compare !== undefined) {
          if (op.compare === null) delete spec.compare
          else spec.compare = op.compare
        }
        return
      case "setVisibility":
        visibility = op.visibility
        return
      case "setDataset":
        spec.datasets = { ...(isObject(spec.datasets) ? spec.datasets : {}), [op.id]: op.source }
        return
      case "removeDataset": {
        const datasets = isObject(spec.datasets) ? { ...spec.datasets } : {}
        if (!(op.id in datasets)) throw new EditOperationError(i, `no dataset '${op.id}'`)
        delete datasets[op.id]
        if (Object.keys(datasets).length) spec.datasets = datasets
        else delete spec.datasets
        return
      }
      case "setFilter": {
        const filters = (Array.isArray(spec.filters) ? [...spec.filters] : []) as Record<
          string,
          unknown
        >[]
        const at = filters.findIndex((f) => f.id === op.filter.id)
        if (at >= 0) filters.splice(at, 1)
        const to = op.position ?? (at >= 0 ? at : filters.length)
        filters.splice(Math.min(to, filters.length), 0, { ...op.filter })
        spec.filters = filters
        return
      }
      case "removeFilter": {
        const filters = (Array.isArray(spec.filters) ? spec.filters : []) as Record<
          string,
          unknown
        >[]
        if (!filters.some((f) => f.id === op.id)) {
          throw new EditOperationError(i, `no filter '${op.id}'`)
        }
        const rest = filters.filter((f) => f.id !== op.id)
        if (rest.length) spec.filters = rest
        else delete spec.filters
        return
      }
    }
  })
  spec.blocks = blocks
  return { title, visibility, spec }
}

// ── the approval card ──────────────────────────────────────────────────────

const PRESET_WORDS: Record<TimeRange["preset"], string> = {
  last7d: "the last 7 days",
  last30d: "the last 30 days",
  last90d: "the last 90 days",
  mtd: "this month to date",
  lastMonth: "last month",
  qtd: "this quarter to date",
  lastQuarter: "last quarter",
  ytd: "this year to date",
  lastYear: "last year",
  custom: "a custom range",
}

const COMPARE_WORDS: Record<CompareMode, string> = {
  lastYear: "the same period last year",
  previousPeriod: "the previous period",
  none: "nothing",
}

export interface DescribeContext {
  timeZone: string
  now: Date
}

function rangeWords(tr: TimeRange, ctx: DescribeContext): string {
  try {
    const w = resolveTimeRange(tr, ctx)
    return tr.preset === "custom"
      ? `${w.from} to ${w.to}`
      : `${PRESET_WORDS[tr.preset]} (today ${w.from} to ${w.to})`
  } catch {
    return PRESET_WORDS[tr.preset]
  }
}

/** A JSON value, short: long text is cut so a line stays a line. */
function compact(value: unknown, max = 160): string {
  const s = typeof value === "string" ? value : JSON.stringify(value)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Each date token of `value` and what it means today. */
function tokenMeanings(value: unknown, window: DayWindow, ctx: DescribeContext): string {
  const out = dateTokensIn(value)
    .slice(0, 4)
    .map((token) => {
      if (token.startsWith("{{range.")) {
        const today = (() => {
          try {
            return resolveDateTokens(token, { ...ctx, range: window })
          } catch (err) {
            if (err instanceof DateTokenError) return null
            throw err
          }
        })()
        return `${token} = the dashboard range's ${token.includes("from") ? "start" : "end"}${today ? ` (${today} by default today)` : ""}`
      }
      try {
        return `${token} = ${resolveDateTokens(token, ctx)} today`
      } catch (err) {
        if (err instanceof DateTokenError) return `${token} (not a date token)`
        throw err
      }
    })
  return out.length ? `; ${out.join(", ")}` : ""
}

function sourceWords(source: unknown, window: DayWindow, ctx: DescribeContext): string {
  const s = isObject(source) ? source : {}
  if (s.kind === "store") {
    const query =
      isObject(s.query) && Object.keys(s.query).length ? ` query ${compact(s.query)}` : ""
    return `the ${String(s.app)} collection "${String(s.collection)}"${query}${tokenMeanings(s.query, window, ctx)}`
  }
  const params =
    isObject(s.params) && Object.keys(s.params).length
      ? ` with ${compact(s.params)}`
      : " with no params"
  return `${String(s.tool ?? "(no source)")}${params}${tokenMeanings(s.params, window, ctx)}`
}

/** Where a block reads, in words: its own source, a shared dataset, or nothing (a note). */
function blockSourceWords(
  b: Record<string, unknown>,
  spec: Record<string, unknown>,
  window: DayWindow,
  ctx: DescribeContext,
): string {
  if (b.type === "text") return `showing the note "${compact(String(b.text ?? ""), 100)}"`
  if (typeof b.dataset === "string") {
    const ds = isObject(spec.datasets) ? spec.datasets[b.dataset] : undefined
    return `reading the shared dataset '${b.dataset}' (${ds ? sourceWords(ds, window, ctx) : "not declared: this edit will be refused"})`
  }
  return `reading ${sourceWords(b.source, window, ctx)}`
}

const OP_WORDS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  in: "is one of",
  contains: "contains",
  gt: "is above",
  gte: "is at least",
  lt: "is below",
  lte: "is at most",
  empty: "is empty",
  notEmpty: "is not empty",
}

/** A where list in words: `market is the "Market" filter's value, total is above 0`. */
function whereWords(where: unknown, spec: Record<string, unknown>): string {
  if (!Array.isArray(where) || where.length === 0) return "all rows"
  const filters = (Array.isArray(spec.filters) ? spec.filters : []) as Record<string, unknown>[]
  return where
    .map((w) => {
      const c = isObject(w) ? w : {}
      const op = OP_WORDS[String(c.op)] ?? String(c.op)
      const v = c.value
      let value = ""
      if (isObject(v) && typeof v.filter === "string") {
        const f = filters.find((x) => x.id === v.filter)
        value = ` the "${String(f?.label ?? v.filter)}" filter's value (all rows while it is empty)`
      } else if (v !== undefined) value = ` ${compact(v, 60)}`
      return `${String(c.field)} ${op}${value}`
    })
    .join(", ")
}

/** A map change in words, key by key (null removes). */
function mapWords(change: unknown, spec: Record<string, unknown>): string {
  if (!isObject(change)) return `map ${compact(change, 120)}`
  const parts: string[] = []
  for (const [k, v] of Object.entries(change)) {
    if (v === null) parts.push(`no more map.${k}`)
    else if (k === "where") parts.push(`keeps only rows where ${whereWords(v, spec)}`)
    else if (k === "stacked") parts.push(v ? "stacked" : "not stacked")
    else if (k === "horizontal") parts.push(v ? "horizontal bars" : "vertical bars")
    else if (k === "link") parts.push(`each row links to ${compact(v, 80)}`)
    else parts.push(`map.${k} ${compact(v, 80)}`)
  }
  return parts.join("; ")
}

/** A filter in words: its label, kind, options and default. */
function filterWords(f: Record<string, unknown>, spec: Record<string, unknown>): string {
  const kind = f.type === "multi" ? "several values" : f.type === "text" ? "free text" : "one value"
  const o = f.options
  let options = ""
  if (Array.isArray(o)) options = `, options ${compact(o.join(", "), 100)}`
  else if (isObject(o) && typeof o.fromDataset === "string")
    options = `, options: the values of ${String(o.field)} in the dataset '${o.fromDataset}'`
  else if (isObject(o) && isObject(o.fromSource))
    options = `, options: the values of ${String(o.field)} read from ${String(o.fromSource.tool ?? o.fromSource.collection ?? "a source")}`
  const def =
    f.default === undefined || (Array.isArray(f.default) && f.default.length === 0)
      ? ", default all"
      : `, default ${compact(f.default, 60)}`
  const blocks = ((spec.blocks ?? []) as Record<string, unknown>[]).filter((b) =>
    JSON.stringify([b.source, b.map]).includes(String(f.id)),
  ).length
  return `"${String(f.label ?? f.id)}" (id ${String(f.id)}, ${kind}${options}${def}${blocks ? `; read by ${blocks} block${blocks === 1 ? "" : "s"}` : ""})`
}

const specOf = (d: EditableDashboard) => d.spec as unknown as Record<string, unknown>

const blockName = (b: Record<string, unknown> | undefined, id: string) =>
  b ? `"${String(b.title ?? id)}"` : `'${id}'`

function positionWords(blocks: Record<string, unknown>[], at: number): string {
  const total = blocks.length
  const where =
    at === 0 ? "first" : at === total - 1 ? "last" : `after ${blockName(blocks[at - 1], "")}`
  return `position ${at + 1} of ${total} (${where})`
}

function changeWords(
  before: Record<string, unknown>,
  changes: Record<string, unknown>,
  spec: Record<string, unknown>,
  window: DayWindow,
  ctx: DescribeContext,
): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(changes)) {
    if (k === "id") continue
    if (k === "title") parts.push(`title "${String(before.title)}" → "${String(v)}"`)
    else if (k === "source") {
      if (v === null) parts.push("no own source any more")
      else {
        const after = mergeBlock(before, { source: v }).source
        parts.push(`source now ${sourceWords(after, window, ctx)}`)
      }
    } else if (k === "dataset") {
      parts.push(
        v === null
          ? "no longer reads a shared dataset"
          : `now reads the shared dataset '${String(v)}'`,
      )
    } else if (k === "text") parts.push(`note now "${compact(v, 100)}"`)
    else if (k === "map") parts.push(mapWords(v, spec))
    else if (k === "timeRange") {
      parts.push(
        v === "fixed"
          ? "keeps its own dates"
          : v === "dashboard"
            ? "follows the dashboard range"
            : `time range ${compact(v)}`,
      )
    } else parts.push(`${k} ${compact(before[k] ?? "(none)", 40)} → ${compact(v, 60)}`)
  }
  return parts.join("; ") || "no field"
}

/**
 * One plain-language line per operation, numbered, as it applies in order to `current`:
 * "2. Add a bar block "Spend by campaign" (width 2) at position 3 of 8 (after "Orders"),
 * reading ads:insights_query with {...}; {{range.from}} = the dashboard range's start (...)".
 */
export function describeOperations(
  current: EditableDashboard,
  operations: EditOperation[],
  ctx: DescribeContext,
): string[] {
  let state: EditableDashboard = current
  const lines: string[] = []
  operations.forEach((op, i) => {
    const blocks = (state.spec.blocks ?? []) as unknown as Record<string, unknown>[]
    const defaults = dashboardDefaultRange(state.spec)
    let window: DayWindow
    try {
      window = resolveTimeRange(defaults.timeRange, ctx)
    } catch {
      window = resolveTimeRange({ preset: "last30d" }, ctx)
    }
    let line: string
    let next: EditableDashboard = state
    try {
      const applied = applyOperations(state, [op])
      next = {
        title: applied.title,
        visibility: applied.visibility,
        spec: applied.spec as unknown as DashboardSpec,
      }
    } catch {
      // Described as asked; the save itself refuses it, naming the problem.
    }
    const nextBlocks = (next.spec.blocks ?? []) as unknown as Record<string, unknown>[]
    switch (op.op) {
      case "addBlock": {
        const b = op.block
        const at = indexOf(nextBlocks, String(b.id))
        const where =
          isObject(b.map) && Array.isArray(b.map.where) && b.map.where.length
            ? `, keeping only rows where ${whereWords(b.map.where, specOf(next))}`
            : ""
        line = `Add a ${String(b.type ?? "")} block "${String(b.title ?? b.id)}" (width ${String(b.width ?? 1)})${at >= 0 ? ` at ${positionWords(nextBlocks, at)}` : ""}, ${blockSourceWords(b, specOf(next), window, ctx)}${where}`
        break
      }
      case "updateBlock": {
        const before = blocks[indexOf(blocks, op.blockId)]
        line = before
          ? `Change the block ${blockName(before, op.blockId)}: ${changeWords(before, op.changes, specOf(state), window, ctx)}`
          : `Change the block '${op.blockId}' (not on the dashboard: this edit will be refused)`
        break
      }
      case "removeBlock": {
        const before = blocks[indexOf(blocks, op.blockId)]
        line = before
          ? `Remove the ${String(before.type)} block ${blockName(before, op.blockId)} (${blockSourceWords(
              before,
              specOf(state),
              window,
              ctx,
            )
              .replace(/^reading/, "it read")
              .replace(/^showing/, "it showed")})`
          : `Remove the block '${op.blockId}' (not on the dashboard: this edit will be refused)`
        break
      }
      case "moveBlock": {
        const from = indexOf(blocks, op.blockId)
        const to = indexOf(nextBlocks, op.blockId)
        line =
          from >= 0 && to >= 0
            ? `Move the block ${blockName(blocks[from], op.blockId)} from position ${from + 1} to ${positionWords(nextBlocks, to)}`
            : `Move the block '${op.blockId}' (not on the dashboard: this edit will be refused)`
        break
      }
      case "setTitle":
        line = `Rename the dashboard "${state.title}" → "${op.title}"`
        break
      case "setTimeRange": {
        const parts: string[] = []
        if (op.timeRange !== undefined) {
          const was = rangeWords(defaults.timeRange, ctx)
          const now = op.timeRange
            ? rangeWords(op.timeRange, ctx)
            : rangeWords({ preset: "last30d" }, ctx)
          parts.push(`opens on ${now} instead of ${was}`)
        }
        if (op.compare !== undefined) {
          parts.push(
            `compares with ${COMPARE_WORDS[op.compare ?? "lastYear"]} instead of ${COMPARE_WORDS[defaults.compare]}`,
          )
        }
        line = `Default time range: the dashboard ${parts.join(", and ") || "keeps its range"} (each person's own choice stays theirs)`
        break
      }
      case "setVisibility":
        line =
          op.visibility === "org"
            ? "Share the dashboard with the whole organisation"
            : "Make the dashboard personal: only its owner sees it"
        break
      case "setDataset": {
        const had = isObject(specOf(state).datasets) && op.id in (specOf(state).datasets as object)
        const users = nextBlocks
          .filter((b) => b.dataset === op.id)
          .map((b) => blockName(b, String(b.id)))
        line = `${had ? "Change" : "Add"} the shared dataset '${op.id}': it reads ${sourceWords(op.source, window, ctx)}, once per view for every block that uses it${users.length ? ` (${users.join(", ")})` : " (no block uses it yet)"}`
        break
      }
      case "removeDataset":
        line = `Remove the shared dataset '${op.id}'${
          blocks.some((b) => b.dataset === op.id)
            ? " (blocks still read it: this edit will be refused unless they change too)"
            : ""
        }`
        break
      case "setFilter": {
        const had =
          Array.isArray(specOf(state).filters) &&
          (specOf(state).filters as Record<string, unknown>[]).some((f) => f.id === op.filter.id)
        line = `${had ? "Change" : "Add"} the filter ${filterWords(op.filter, specOf(next))}; each person picks their own value`
        break
      }
      case "removeFilter": {
        const f = ((specOf(state).filters ?? []) as Record<string, unknown>[]).find(
          (x) => x.id === op.id,
        )
        line = `Remove the filter ${f ? `"${String(f.label ?? op.id)}"` : `'${op.id}' (not on the dashboard: this edit will be refused)`}`
        break
      }
    }
    lines.push(`${i + 1}. ${line}.`)
    state = next
  })
  return lines
}
