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

import { APPROVAL_SUMMARY_LONG_LINES_MAX } from "@liaison/shared"
import { z } from "zod"
import {
  COMPARE_MODES,
  type CompareMode,
  DateTokenError,
  type DayWindow,
  dateTokensIn,
  filterTokensIn,
  hasRangeTokens,
  resolveDateTokens,
  resolveTimeRange,
  type TimeRange,
} from "~/modules/dashboards/relative-dates"
import {
  type DashboardSpec,
  dashboardDefaultRange,
  dashboardSpecSchema,
  MAX_DASHBOARD_BLOCKS,
  MAX_DESCRIPTION_LENGTH,
  MAX_FILTERS,
  timeRangeSchema,
} from "~/modules/dashboards/spec"

/**
 * The most changes one dashboard approval card lists, one numbered line each: the bound of
 * dashboards_edit's operations and of the changes one dashboards_update makes to an org
 * dashboard. One request is one card however many changes it pools (owner, 2026-11-11);
 * this bounds it against abuse, as the shared summary schema does for these card kinds.
 */
export const MAX_CARD_CHANGES = APPROVAL_SUMMARY_LONG_LINES_MAX

/** The refusal of a request with more changes than one card lists. */
export function tooManyChangesMessage(count: number): string {
  return `${count} changes is more than one approval card lists (${MAX_CARD_CHANGES}). Split the request: send the first ${MAX_CARD_CHANGES} changes now, and send the rest only once that approval is decided and applied, reading the dashboard again (kernel__dashboards_get) for its new version.`
}

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
      block: blockRecord.describe(
        "The whole new block: {id, type, title, width?, source, map} (a blended combo: layers instead of source).",
      ),
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
  z
    .object({
      op: z.literal("resizeBlock"),
      blockId,
      width: z
        .union([z.literal(1), z.literal(2), z.literal(3)])
        .optional()
        .describe("Columns of the grid (1-3)."),
      height: z
        .union([z.literal(1), z.literal(2)])
        .optional()
        .describe("Rows of the grid (1-2)."),
    })
    .strict()
    .refine((o) => o.width !== undefined || o.height !== undefined, "give a width or a height"),
  z
    .object({
      op: z.literal("duplicateBlock"),
      blockId,
      newId: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/)
        .optional()
        .describe('The copy\'s id. Default: "<id>-copy" (or -copy-2, ...).'),
      title: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional()
        .describe('The copy\'s title. Default: "<title> (copy)".'),
      position: positionSchema
        .optional()
        .describe("Where the copy goes. Default: right after the original."),
    })
    .strict(),
  z
    .object({
      op: z.literal("setDescription"),
      description: z
        .string()
        .trim()
        .min(1)
        .max(MAX_DESCRIPTION_LENGTH)
        .nullable()
        .describe("Plain text under the title; null removes it."),
    })
    .strict(),
  z
    .object({
      op: z.literal("revert"),
      toVersion: z
        .number()
        .int()
        .min(1)
        .describe(
          "A saved version (kernel__dashboards_history): its title and blocks come back as a new version.",
        ),
    })
    .strict(),
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

/** A saved version a `revert` brings back (service.ts reads them before applying). */
export interface SavedVersion {
  version: number
  title: string
  spec: Record<string, unknown>
  savedAt: string
  savedByName: string | null
}

/** The versions an operation list reverts to, by number. */
export type VersionLookup = ReadonlyMap<number, SavedVersion>

/** The version numbers `operations` revert to (to read before applying or describing them). */
export function revertTargets(operations: readonly EditOperation[]): number[] {
  return [...new Set(operations.flatMap((op) => (op.op === "revert" ? [op.toVersion] : [])))]
}

/** A free block id from `base`: `<base>-copy`, then `<base>-copy-2`, ... (40 characters at most). */
function copyId(blocks: Record<string, unknown>[], base: string): string {
  for (let n = 1; n < 100; n++) {
    const suffix = n === 1 ? "-copy" : `-copy-${n}`
    const id = `${base.slice(0, 40 - suffix.length)}${suffix}`
    if (indexOf(blocks, id) < 0) return id
  }
  return `${base.slice(0, 30)}-${Date.now().toString(36)}`.slice(0, 40)
}

/** A copy's title: "<title> (copy)", cut to the 120 characters a title holds. */
function copyTitle(title: unknown): string {
  const suffix = " (copy)"
  return `${String(title ?? "").slice(0, 120 - suffix.length)}${suffix}`
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
  versions: VersionLookup = new Map(),
): { title: string; visibility: "personal" | "org"; spec: Record<string, unknown> } {
  let title = current.title
  let visibility = current.visibility
  let spec: Record<string, unknown> = { ...(current.spec as unknown as Record<string, unknown>) }
  let blocks = ((current.spec.blocks ?? []) as unknown as Record<string, unknown>[]).map((b) => ({
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
      case "resizeBlock": {
        const at = indexOf(blocks, op.blockId)
        if (at < 0) throw new EditOperationError(i, `no block '${op.blockId}'`)
        const b = { ...blocks[at]! }
        if (op.width !== undefined) b.width = op.width
        if (op.height !== undefined) {
          if (op.height === 1) delete b.height
          else b.height = op.height
        }
        blocks[at] = b
        return
      }
      case "duplicateBlock": {
        const at = indexOf(blocks, op.blockId)
        if (at < 0) throw new EditOperationError(i, `no block '${op.blockId}'`)
        const original = blocks[at]!
        const id = op.newId ?? copyId(blocks, op.blockId)
        if (indexOf(blocks, id) >= 0) {
          throw new EditOperationError(i, `a block '${id}' is already on the dashboard`)
        }
        const copy = structuredClone(original)
        copy.id = id
        copy.title = op.title ?? copyTitle(original.title)
        const to = op.position === undefined ? at + 1 : resolvePosition(blocks, op.position, i)
        blocks.splice(to, 0, copy)
        return
      }
      case "setDescription":
        if (op.description === null) delete spec.description
        else spec.description = op.description
        return
      case "revert": {
        const saved = versions.get(op.toVersion)
        if (!saved) {
          throw new EditOperationError(
            i,
            `no saved version ${op.toVersion} (kernel__dashboards_history lists the ones kept)`,
          )
        }
        title = saved.title
        spec = { ...saved.spec }
        blocks = (Array.isArray(saved.spec.blocks) ? saved.spec.blocks : []).map((b) => ({
          ...(b as Record<string, unknown>),
        }))
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
  /** The saved versions a revert names (absent: the line says it could not be read). */
  versions?: VersionLookup
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

/** A note shown inline on its operation's line when it is this short. */
const NOTE_INLINE_MAX = 200
/** The length of each line a longer note's text, or its links, run over. */
const NOTE_CHUNK = 440

/** Every link target a note's markdown holds: inline and reference links, autolinks, bare URLs. */
export function noteLinkTargets(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\]\(\s*<?([^\s)>]+)/g)) out.add(m[1]!)
  for (const m of text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)/gm)) out.add(m[1]!)
  for (const m of text.matchAll(/<((?:https?:|mailto:)[^\s>]+)>/gi)) out.add(m[1]!)
  for (const m of text.matchAll(/(?:https?:\/\/|mailto:)[^\s<>()[\]"']+/gi)) {
    if (![...out].some((t) => t.startsWith(m[0]))) out.add(m[0])
  }
  return [...out]
}

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ↵ ")

function chunks(text: string, size = NOTE_CHUNK): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

/** A note on its operation's line: in full when short, else its length (the text follows). */
function noteHead(text: string): string {
  const links = noteLinkTargets(text).length
  const linkWords = links ? `; ${links} link${links === 1 ? "" : "s"}, listed below` : ""
  return text.length <= NOTE_INLINE_MAX
    ? `the note "${oneLine(text)}"${linkWords}`
    : `a note of ${text.length} characters, its full text below${linkWords}`
}

/**
 * The lines a note adds under its operation: its full text when it is not on the line itself,
 * then every link target it holds, so an admin sees all of it, links included.
 */
export function noteExtraLines(text: string): string[] {
  const out: string[] = []
  if (text.length > NOTE_INLINE_MAX) {
    const parts = chunks(oneLine(text))
    parts.forEach((part, i) => {
      out.push(`   Note text (${i + 1}/${parts.length}): ${part}`)
    })
  }
  const links = noteLinkTargets(text)
  if (links.length) {
    for (const part of chunks(links.join(" , "))) out.push(`   Links in the note: ${part}`)
  }
  return out
}

/** The note text an operation sets, if any. */
function noteOf(op: EditOperation): string | null {
  if (op.op === "addBlock" && op.block.type === "text" && typeof op.block.text === "string") {
    return op.block.text
  }
  if (op.op === "updateBlock" && typeof op.changes.text === "string") return op.changes.text
  return null
}

/** How many lines the approval card of `ops` lists: one per operation, plus each note's own. */
export function cardLineCount(ops: EditOperation[]): number {
  return ops.reduce((n, op) => {
    const note = noteOf(op)
    return n + 1 + (note === null ? 0 : noteExtraLines(note).length)
  }, 0)
}

/** Params as written when short; else each one by name, its value cut (the tokens follow). */
function paramWords(params: Record<string, unknown>): string {
  const whole = JSON.stringify(params)
  if (whole.length <= 300) return whole
  return Object.entries(params)
    .map(([k, v]) => `${k}: ${compact(v, 50)}`)
    .join(", ")
}

/** One aggregation in words: "sum of total", "a count of rows". */
function aggWords(field: unknown, agg: unknown): string {
  const a = agg ?? (field ? "sum" : "count")
  return a === "count" && !field ? "a count of rows" : `${String(a)} of ${String(field)}`
}

/**
 * What a block's map draws, in words: "sum of total by status, target 5000; keeps only rows
 * where status is not cancelled". `spec` names the filters a where clause reads.
 */
function mapWords(rawMap: unknown, spec: Record<string, unknown> = {}, layered = false): string {
  const map = isObject(rawMap) ? rawMap : {}
  if (layered) return displayWords(map).join(", ") || "the layers as they are drawn"
  const field = map.value ?? map.y
  const parts: string[] = []
  const measureList = (list: unknown) =>
    (Array.isArray(list) ? list : [])
      .filter(isObject)
      .map((m) =>
        typeof m.expr === "string"
          ? `${String(m.label)} (computed: ${compact(m.expr, 80)})`
          : `${String(m.label)}${m.name ? ` [${String(m.name)}]` : ""} (${aggWords(m.field, m.agg)}${typeof m.dataset === "string" ? ` from the shared dataset '${m.dataset}'` : ""})`,
      )
      .join(", ")
  if (Array.isArray(map.columns)) {
    parts.push(
      `columns ${map.columns.map((c) => String(isObject(c) ? (c.label ?? c.field) : c)).join(", ")}`,
    )
  } else if (Array.isArray(map.stages)) parts.push(`the stages ${measureList(map.stages)}`)
  else if (Array.isArray(map.measures)) parts.push(measureList(map.measures))
  else if (typeof map.expr === "string" && isObject(map.values)) {
    const named = Object.entries(map.values)
      .map(([n, v]) => {
        const c = isObject(v) ? v : {}
        const where =
          Array.isArray(c.where) && c.where.length ? ` where ${whereWords(c.where, spec)}` : ""
        return `${n} = ${aggWords(c.field, c.agg)}${typeof c.dataset === "string" ? ` from the shared dataset '${c.dataset}'` : ""}${where}`
      })
      .join(", ")
    parts.push(`the computed value ${compact(map.expr, 120)} (${named})`)
  } else parts.push(aggWords(field, map.agg))
  if (isObject(map.groupBy)) {
    const bucket = map.groupBy.bucket ? ` per ${String(map.groupBy.bucket)}` : ""
    parts[0] += ` by ${String(map.groupBy.field)}${bucket}`
  } else if (map.x ?? map.label) parts[0] += ` by ${String(map.x ?? map.label)}`
  if (Array.isArray(map.order)) parts.push(`stages in the order ${map.order.join(", ")}`)
  if (map.series) parts.push(`split by ${String(map.series)}`)
  if (map.stacked) parts.push("stacked")
  if (map.horizontal) parts.push("horizontal bars")
  if (Array.isArray(map.lineSeries)) parts.push(`drawn as lines: ${map.lineSeries.join(", ")}`)
  if (map.secondaryAxis) parts.push("lines on their own axis")
  parts.push(...displayWords(map).filter((w) => !w.startsWith("shown as")))
  if (map.scale !== undefined) parts.push(`every value multiplied by ${String(map.scale)}`)
  if (map.percentOfTotal) parts.push("each value as a percentage of its total")
  if (map.target !== undefined) parts.push(`target ${String(map.target)}`)
  if (isObject(map.sparkline)) {
    parts.push(
      `sparkline of ${String(map.sparkline.field)} per ${String(map.sparkline.bucket ?? "day")}`,
    )
  }
  if (map.link !== undefined) parts.push(`each row links to ${compact(map.link, 80)}`)
  if (isObject(map.sort)) {
    parts.push(
      `sorted by ${String(map.sort.field)} ${map.sort.dir === "asc" ? "ascending" : "descending"}`,
    )
  }
  if (map.limit !== undefined) parts.push(`at most ${String(map.limit)} rows`)
  if (map.format !== undefined) {
    parts.push(`shown as ${String(map.format)}${map.currency ? ` (${String(map.currency)})` : ""}`)
  }
  if (Array.isArray(map.drillColumns)) {
    parts.push(
      `its rows open with the columns ${map.drillColumns.map((c) => String(isObject(c) ? (c.label ?? c.field) : c)).join(", ")}`,
    )
  }
  let out = parts.join(", ")
  if (Array.isArray(map.where) && map.where.length) {
    out += `; keeps only rows where ${whereWords(map.where, spec)}`
  }
  return out
}

/** The display words a layered block's own map shares with any chart: curve, headline, format. */
function displayWords(map: Record<string, unknown>): string[] {
  const out: string[] = []
  if (map.curve === "smooth") out.push("smooth curve")
  if (map.curve === "linear") out.push("straight lines between points")
  if (map.headline === "total") {
    out.push("headline: the period's total with its change against the comparison")
  }
  if (map.headline === "series") {
    out.push("headline: one figure per series with its change against the comparison")
  }
  if (Array.isArray(map.headlineCalc)) {
    for (const c of map.headlineCalc.filter(isObject)) {
      out.push(`headline figure "${String(c.label)}" = ${compact(c.expr, 80)}`)
    }
  }
  if (map.format !== undefined) {
    out.push(`shown as ${String(map.format)}${map.currency ? ` (${String(map.currency)})` : ""}`)
  }
  return out
}

/** A layered block's layers in words: how each is drawn, what it shows, where it reads. */
function layersWords(
  layers: unknown,
  spec: Record<string, unknown>,
  window: DayWindow,
  ctx: DescribeContext,
): string {
  const list = (Array.isArray(layers) ? layers : []).filter(isObject)
  const each = list.map((l) => {
    const drawn = `${l.as === "line" ? "a line" : "bars"}${l.axis === "right" ? " on the right axis" : ""}`
    return `"${String(l.label ?? l.id)}" (${drawn}, ${mapWords(l.map, spec)}) ${blockSourceWords(l, spec, window, ctx)}`
  })
  return `blending ${list.length} layer${list.length === 1 ? "" : "s"} joined on their date bucket: ${each.join("; ")}`
}

/** Whether a block follows the dashboard range (spec.ts blockRangeMode, on an unchecked block). */
function rangeModeWords(
  block: Record<string, unknown>,
  spec: Record<string, unknown> = {},
): string {
  if (block.type === "text") return "no dates"
  if (Array.isArray(block.layers) && block.timeRange === undefined) {
    return block.layers.some(
      (l) => isObject(l) && rangeModeWords(l, spec) === "follows the dashboard range",
    )
      ? "follows the dashboard range"
      : "keeps its own dates"
  }
  const shared =
    typeof block.dataset === "string" && isObject(spec.datasets)
      ? spec.datasets[block.dataset]
      : undefined
  const s = isObject(block.source) ? block.source : isObject(shared) ? shared : {}
  const follows =
    block.timeRange === "dashboard" ||
    (block.timeRange !== "fixed" && hasRangeTokens(s.kind === "store" ? s.query : s.params))
  return follows ? "follows the dashboard range" : "keeps its own dates"
}

/** Each date token of `value` and what it means today. */
function tokenMeanings(value: unknown, window: DayWindow, ctx: DescribeContext): string {
  const out = dateTokensIn(value)
    .slice(0, 8)
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
      ? ` with ${paramWords(s.params)}`
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
  if (b.type === "text") return `showing ${noteHead(String(b.text ?? ""))}`
  if (Array.isArray(b.layers)) return layersWords(b.layers, spec, window, ctx)
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

/** A filter in words: its label, kind, options and default. */
function filterWords(f: Record<string, unknown>, spec: Record<string, unknown>): string {
  const kind = f.type === "multi" ? "several values" : f.type === "text" ? "free text" : "one value"
  const o = f.options
  let options = ""
  if (Array.isArray(o)) options = `, options ${compact(o.join(", "), 100)}`
  else if (isObject(o) && typeof o.fromDataset === "string")
    options = `, options: the values of ${String(o.field)} in the dataset '${o.fromDataset}'`
  else if (isObject(o) && isObject(o.fromSource)) {
    const src = o.fromSource
    const how =
      src.kind === "store"
        ? `the ${String(src.app)} collection "${String(src.collection)}"${isObject(src.query) && Object.keys(src.query).length ? ` query ${compact(src.query, 200)}` : ""}`
        : `${String(src.tool ?? "a source")}${isObject(src.params) && Object.keys(src.params).length ? ` with ${compact(src.params, 200)}` : " with no params"}`
    options = `, options: the values of ${String(o.field)} read from ${how}`
  }
  const def =
    f.default === undefined || (Array.isArray(f.default) && f.default.length === 0)
      ? ", default all"
      : `, default ${compact(f.default, 60)}`
  const datasets = isObject(spec.datasets) ? spec.datasets : {}
  const reads = (source: unknown) =>
    isObject(source) &&
    filterTokensIn(source.kind === "store" ? source.query : source.params).includes(String(f.id))
  const blocks = ((spec.blocks ?? []) as Record<string, unknown>[]).filter((b) => {
    const map = isObject(b.map) ? b.map : {}
    const where = Array.isArray(map.where) ? map.where : []
    const layers = (Array.isArray(b.layers) ? b.layers : []).filter(isObject)
    return (
      reads(b.source) ||
      (typeof b.dataset === "string" && reads(datasets[b.dataset])) ||
      where.some((w) => isObject(w) && isObject(w.value) && w.value.filter === f.id) ||
      layers.some((l) => {
        const lw = isObject(l.map) && Array.isArray(l.map.where) ? l.map.where : []
        return (
          reads(l.source) ||
          (typeof l.dataset === "string" && reads(datasets[l.dataset])) ||
          lw.some((w) => isObject(w) && isObject(w.value) && w.value.filter === f.id)
        )
      })
    )
  }).length
  return `"${String(f.label ?? f.id)}" (id ${String(f.id)}, ${kind}${options}${def}${blocks ? `; read by ${blocks} block${blocks === 1 ? "" : "s"}` : ""})`
}

/** Whether a block (or one of its layers) reads the shared dataset `id`. */
const readsDataset = (b: Record<string, unknown>, id: string) =>
  b.dataset === id ||
  (Array.isArray(b.layers) && b.layers.some((l) => isObject(l) && l.dataset === id))

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
  // Short, human parts first (title, dates, dataset), the long source and map words last:
  // a line over the length cap loses its end, never the title change.
  const rank = (k: string) =>
    k === "title" ? 0 : k === "source" || k === "map" || k === "layers" ? 2 : 1
  const entries = Object.entries(changes).sort(([a], [b]) => rank(a) - rank(b))
  for (const [k, v] of entries) {
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
    } else if (k === "text") parts.push(`now shows ${noteHead(String(v ?? ""))}`)
    else if (k === "map") {
      parts.push(
        `now shows ${mapWords(mergeKeys(before.map, v), spec, Array.isArray(before.layers) || Array.isArray(changes.layers))}`,
      )
    } else if (k === "layers") {
      parts.push(v === null ? "no layers any more" : `now ${layersWords(v, spec, window, ctx)}`)
    } else if (k === "timeRange") {
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
  // Range tokens are explained with the default range the dashboard has once the whole
  // request applied: a setTimeRange anywhere in the list is the range viewers open on, so
  // describing them with the range before it would show dates nobody will see.
  let finalSpec: DashboardSpec = current.spec
  try {
    finalSpec = applyOperations(current, operations, ctx.versions).spec as unknown as DashboardSpec
  } catch {
    // Described as asked; the save itself refuses it, naming the problem.
  }
  let window: DayWindow
  try {
    window = resolveTimeRange(dashboardDefaultRange(finalSpec).timeRange, ctx)
  } catch {
    window = resolveTimeRange({ preset: "last30d" }, ctx)
  }
  operations.forEach((op, i) => {
    const blocks = (state.spec.blocks ?? []) as unknown as Record<string, unknown>[]
    const defaults = dashboardDefaultRange(state.spec)
    let line: string
    /** Lines under this one (a revert's changes). */
    let sub: string[] = []
    let next: EditableDashboard = state
    try {
      const applied = applyOperations(state, [op], ctx.versions)
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
        const refresh =
          b.refreshSec !== undefined ? `, refreshed every ${String(b.refreshSec)} s` : ""
        const shows =
          b.type === "text"
            ? ""
            : `; it shows ${mapWords(b.map, specOf(next), Array.isArray(b.layers))}, ${rangeModeWords(b, specOf(next))}`
        line = `Add a ${String(b.type ?? "")} block "${String(b.title ?? b.id)}" (width ${String(b.width ?? 1)})${at >= 0 ? ` at ${positionWords(nextBlocks, at)}` : ""}, ${blockSourceWords(b, specOf(next), window, ctx)}${shows}${refresh}`
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
          .filter((b) => readsDataset(b, op.id))
          .map((b) => blockName(b, String(b.id)))
        line = `${had ? "Change" : "Add"} the shared dataset '${op.id}': it reads ${sourceWords(op.source, window, ctx)}, once per view for every block that uses it${users.length ? ` (${users.join(", ")})` : " (no block uses it yet)"}`
        break
      }
      case "removeDataset":
        line = `Remove the shared dataset '${op.id}'${
          blocks.some((b) => readsDataset(b, op.id))
            ? " (blocks still read it: this edit will be refused unless they change too)"
            : ""
        }`
        break
      case "setFilter": {
        const had =
          Array.isArray(specOf(state).filters) &&
          (specOf(state).filters as Record<string, unknown>[]).some((f) => f.id === op.filter.id)
        const list = (specOf(next).filters ?? []) as Record<string, unknown>[]
        const at = list.findIndex((f) => f.id === op.filter.id)
        const where = at >= 0 ? `, position ${at + 1} of ${list.length} in the filter bar` : ""
        line = `${had ? "Change" : "Add"} the filter ${filterWords(op.filter, specOf(next))}${where}; each person picks their own value`
        break
      }
      case "removeFilter": {
        const f = ((specOf(state).filters ?? []) as Record<string, unknown>[]).find(
          (x) => x.id === op.id,
        )
        line = `Remove the filter ${f ? `"${String(f.label ?? op.id)}"` : `'${op.id}' (not on the dashboard: this edit will be refused)`}`
        break
      }
      case "resizeBlock": {
        const before = blocks[indexOf(blocks, op.blockId)]
        if (!before) {
          line = `Resize the block '${op.blockId}' (not on the dashboard: this edit will be refused)`
          break
        }
        const parts: string[] = []
        if (op.width !== undefined) parts.push(`width ${String(before.width ?? 1)} → ${op.width}`)
        if (op.height !== undefined) {
          parts.push(`height ${String(before.height ?? 1)} → ${op.height}`)
        }
        line = `Resize the block ${blockName(before, op.blockId)}: ${parts.join(", ")}`
        break
      }
      case "duplicateBlock": {
        const before = blocks[indexOf(blocks, op.blockId)]
        const copy = nextBlocks.find((b) => !blocks.some((x) => x.id === b.id))
        const at = copy ? indexOf(nextBlocks, String(copy.id)) : -1
        line =
          before && copy
            ? `Duplicate the ${String(before.type)} block ${blockName(before, op.blockId)} as "${String(copy.title)}" (id ${String(copy.id)}) at ${positionWords(nextBlocks, at)}, ${blockSourceWords(copy, specOf(next), window, ctx)}`
            : `Duplicate the block '${op.blockId}' (not on the dashboard, or the new id is taken: this edit will be refused)`
        break
      }
      case "setDescription": {
        const was = specOf(state).description
        line =
          op.description === null
            ? was
              ? `Remove the description "${compact(was, 100)}"`
              : "Remove the description (there is none)"
            : was
              ? `Description "${compact(was, 100)}" → "${compact(op.description, 200)}"`
              : `Add the description "${compact(op.description, 200)}"`
        break
      }
      case "revert": {
        const saved = ctx.versions?.get(op.toVersion)
        if (!saved) {
          line = `Revert to version ${op.toVersion} (not kept any more: this edit will be refused)`
          break
        }
        // The restored state as an edit card lists it: each change on its own line under this
        // one (blocks with their source, params and map; settings old → new).
        const changes = diffDashboards(state, { title: saved.title, spec: saved.spec })
        const saidAt = `saved ${saved.savedAt.slice(0, 10)}${saved.savedByName ? ` by ${saved.savedByName}` : ""}`
        line =
          changes.length === 0
            ? `Revert to version ${op.toVersion} (${saidAt}): no difference with the dashboard as it is`
            : `Revert to version ${op.toVersion} (${saidAt}): ${changes.length} change${changes.length === 1 ? "" : "s"}, listed below`
        sub = describeOperations(state, changes, { ...ctx, versions: new Map() }).map((l) =>
          /^\d+\. /.test(l) ? `   ${i + 1}.${l}` : `   ${l}`,
        )
        break
      }
    }
    lines.push(`${i + 1}. ${line}.`)
    lines.push(...sub)
    const note = noteOf(op)
    if (note !== null) lines.push(...noteExtraLines(note))
    state = next
  })
  return lines
}

// ── a whole new spec, as operations ────────────────────────────────────────
// (title, visibility, range, description, datasets, filters, then blocks; removed datasets and
// filters last)

/** JSON with object keys sorted: two values are the same when this is. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b)

/** The keys of `next` that differ from `base`: the new value, or null where a key went. */
function patchOf(base: unknown, next: unknown): Record<string, unknown> {
  const b = isObject(base) ? base : {}
  const n = isObject(next) ? next : {}
  const out: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(b), ...Object.keys(n)])) {
    if (n[k] === undefined) {
      if (b[k] !== undefined) out[k] = null
    } else if (!same(b[k], n[k])) out[k] = n[k]
  }
  return out
}

/** An updateBlock's `changes` turning `before` into `after` (mergeBlock's rules, reversed). */
function blockChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === "id" || same(before[k], after[k])) continue
    const was = before[k]
    const now = after[k]
    if (now === undefined) changes[k] = null
    else if (k === "map") changes.map = patchOf(was, now)
    else if (k === "source" && isObject(was) && isObject(now) && was.kind === now.kind) {
      const source: Record<string, unknown> = {}
      for (const sk of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (same(was[sk], now[sk])) continue
        if (sk === "params" || sk === "query") source[sk] = patchOf(was[sk], now[sk])
        else source[sk] = now[sk] === undefined ? null : now[sk]
      }
      changes.source = source
    } else changes[k] = now
  }
  return changes
}

/** The indexes of a longest increasing run of `values` (the blocks that need not move). */
function longestIncreasing(values: number[]): Set<number> {
  const length = values.map(() => 1)
  const prev = values.map(() => -1)
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < i; j++) {
      if (values[j]! < values[i]! && length[j]! + 1 > length[i]!) {
        length[i] = length[j]! + 1
        prev[i] = j
      }
    }
  }
  let at = length.indexOf(Math.max(0, ...length))
  const out = new Set<number>()
  while (at >= 0) {
    out.add(at)
    at = prev[at]!
  }
  return out
}

/**
 * The operations that turn `current` into `next` (a whole-spec save, dashboards_update),
 * so its approval card lists each change as dashboards_edit's does: title, visibility,
 * the default range and comparison, each block removed, changed (with what changed),
 * added or moved. Applying them to `current` gives `next`'s blocks in `next`'s order.
 */
export function diffDashboards(
  current: EditableDashboard,
  next: { title?: string; visibility?: "personal" | "org"; spec?: unknown },
): EditOperation[] {
  const ops: EditOperation[] = []
  if (next.title !== undefined && next.title !== current.title) {
    ops.push({ op: "setTitle", title: next.title })
  }
  if (next.visibility !== undefined && next.visibility !== current.visibility) {
    ops.push({ op: "setVisibility", visibility: next.visibility })
  }
  if (!isObject(next.spec)) return ops
  const was = current.spec as unknown as Record<string, unknown>
  // Compared as it would be saved (its defaults filled in), so a default is not a change.
  const parsed = dashboardSpecSchema.safeParse(next.spec)
  const now = parsed.success ? (parsed.data as unknown as Record<string, unknown>) : next.spec
  const rangeChanged = !same(was.timeRange, now.timeRange)
  const compareChanged = !same(was.compare, now.compare)
  if (rangeChanged || compareChanged) {
    ops.push({
      op: "setTimeRange",
      ...(rangeChanged ? { timeRange: (now.timeRange ?? null) as TimeRange | null } : {}),
      ...(compareChanged ? { compare: (now.compare ?? null) as CompareMode | null } : {}),
    })
  }
  if (!same(was.description, now.description)) {
    ops.push({
      op: "setDescription",
      description: typeof now.description === "string" ? now.description : null,
    })
  }
  // Shared datasets and filters first (a block may read a new one), their removals last.
  const removals: EditOperation[] = []
  const oldDatasets = isObject(was.datasets) ? was.datasets : {}
  const newDatasets = isObject(now.datasets) ? now.datasets : {}
  for (const [id, source] of Object.entries(newDatasets)) {
    if (!same(oldDatasets[id], source) && isObject(source)) {
      ops.push({ op: "setDataset", id, source })
    }
  }
  for (const id of Object.keys(oldDatasets)) {
    if (!(id in newDatasets)) removals.push({ op: "removeDataset", id })
  }
  const filtersOf = (spec: Record<string, unknown>) =>
    (Array.isArray(spec.filters) ? spec.filters : []).filter(isObject)
  const oldFilters = filtersOf(was)
  const newFilters = filtersOf(now)
  const newFilterIds = new Set(newFilters.map((f) => String(f.id)))
  for (const f of oldFilters) {
    if (!newFilterIds.has(String(f.id))) removals.push({ op: "removeFilter", id: String(f.id) })
  }
  const keptFilterOrder = oldFilters
    .filter((f) => newFilterIds.has(String(f.id)))
    .map((f) => String(f.id))
  newFilters.forEach((f, i) => {
    const at = oldFilters.find((o) => o.id === f.id)
    const sameOrder = keptFilterOrder.indexOf(String(f.id)) === i
    if (!at || !same(at, f) || !sameOrder) ops.push({ op: "setFilter", filter: f, position: i })
  })
  const blocksOf = (spec: Record<string, unknown>) =>
    (Array.isArray(spec.blocks) ? spec.blocks : []).filter(isObject)
  const oldBlocks = blocksOf(was)
  const newBlocks = blocksOf(now)
  const newIndex = new Map(newBlocks.map((b, i) => [String(b.id), i]))
  const oldById = new Map(oldBlocks.map((b) => [String(b.id), b]))
  for (const b of oldBlocks) {
    if (!newIndex.has(String(b.id))) ops.push({ op: "removeBlock", blockId: String(b.id) })
  }
  const kept = oldBlocks.filter((b) => newIndex.has(String(b.id)))
  for (const b of kept) {
    const changes = blockChanges(b, newBlocks[newIndex.get(String(b.id))!]!)
    if (Object.keys(changes).length) {
      ops.push({ op: "updateBlock", blockId: String(b.id), changes })
    }
  }
  const staying = longestIncreasing(kept.map((b) => newIndex.get(String(b.id))!))
  const stays = new Set([...staying].map((i) => String(kept[i]!.id)))
  newBlocks.forEach((b, i) => {
    const id = String(b.id)
    const position: BlockPosition = i === 0 ? 0 : { after: String(newBlocks[i - 1]!.id) }
    if (!oldById.has(id)) ops.push({ op: "addBlock", block: b, position })
    else if (!stays.has(id)) ops.push({ op: "moveBlock", blockId: id, position })
  })
  ops.push(...removals)
  return ops
}
