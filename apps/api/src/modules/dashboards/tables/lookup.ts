// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dashboard table's lookup columns: read-only cells read live from an app's read tool (a
// product's stock from a shop's product search, the units waiting in a shipping queue), joined
// to the table's rows on one of its columns.
//
// - The read IS a dashboard tool source (execute.ts runSource): once per table read per column,
//   as the READER (their scopes, their RLS), on a read-only run, refused when the tool is not a
//   dashboard source (sources.ts) or the reader may not call it. Reading the column taints the
//   calling turn exactly as calling the tool would (scope-taint.ts), a cached read included.
// - Cached per reader like a dashboard source (cache.ts: their user id and permission hash), for
//   LOOKUP_TTL_SEC; only the join pairs are kept. A failed read is kept FAILED_BLOCK_TTL_SEC. A
//   read the cache could not keep counts toward the viewer's run budget, as a dashboard's does.
// - A failed, forbidden or rate-limited read leaves that column's cells empty and says why in a
//   column note; the rows are always returned.
// - The join: a tool row's `match.field` equals the row's `match.on` cell (a link cell by its
//   record id), compared as trimmed, case-insensitive text. Several tool rows with one key: a
//   number column shows their sum, a text column their distinct values joined by ", ".
import type { UserContext } from "~/db/rls"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import {
  FAILED_BLOCK_TTL_SEC,
  failedBlockCacheKey,
  isUncacheable,
  markUncacheable,
  permissionHash,
  readCachedBlock,
  singleFlight,
  sourceHash,
  takeCustomWindowRun,
  withViewerSlot,
  writeCachedBlock,
} from "~/modules/dashboards/cache"
import type { ToolSource } from "~/modules/dashboards/spec"
import type { Column, LookupDef } from "~/modules/dashboards/tables/columns"
import { MAX_TEXT_CELL } from "~/modules/dashboards/tables/columns"
import { readPath, toNumber } from "~/modules/dashboards/transform"

/** How long a lookup read is kept for one reader: a table read within it reads no tool. */
export const LOOKUP_TTL_SEC = 60

/** The largest cached lookup (its join pairs); a larger one is not kept, and counts toward the budget. */
const MAX_CACHED_LOOKUP_BYTES = 512 * 1024

export type LookupValue = number | string

/** A lookup read as kept: each key a tool row carried, with its value (null: none to show). */
export type LookupPairs = Array<[string, LookupValue | null]>

/** A join key: a scalar as trimmed lower-case text, a link cell by its record id; else none. */
export function joinKey(v: unknown): string | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const id = (v as { id?: unknown }).id
    return typeof id === "string" || typeof id === "number" ? joinKey(id) : null
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v)
  if (typeof v === "string") {
    const s = v.trim().toLowerCase()
    return s === "" ? null : s
  }
  return null
}

/** A tool row's value as the column shows it: a number (numeric text read as one), or text. */
export function lookupValue(v: unknown, type: LookupDef["valueType"]): LookupValue | null {
  if (type === "number") return toNumber(v)
  if (typeof v === "string") return v === "" ? null : v.slice(0, MAX_TEXT_CELL)
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return null
}

/** The join pairs of a tool's rows: [key, value] per row that carries a key. */
export function lookupPairs(def: LookupDef, rows: readonly Record<string, unknown>[]): LookupPairs {
  const out: LookupPairs = []
  for (const row of rows) {
    const key = joinKey(readPath(row, def.match.field))
    if (key === null) continue
    out.push([key, lookupValue(readPath(row, def.value), def.valueType)])
  }
  return out
}

/** The value of each key: one row's, or (several rows with one key) a sum or distinct texts. */
export function lookupIndex(
  pairs: LookupPairs,
  type: LookupDef["valueType"],
): Map<string, LookupValue> {
  const nums = new Map<string, number>()
  const texts = new Map<string, string[]>()
  for (const [key, value] of pairs) {
    if (value === null) continue
    if (type === "number" && typeof value === "number") {
      nums.set(key, (nums.get(key) ?? 0) + value)
    } else if (type === "text") {
      const list = texts.get(key) ?? []
      const s = String(value)
      if (!list.includes(s)) list.push(s)
      texts.set(key, list)
    }
  }
  if (type === "number") return nums
  return new Map([...texts].map(([k, list]) => [k, list.join(", ").slice(0, MAX_TEXT_CELL)]))
}

/** Each row's cells with the lookup column's value in (a row without a match stays empty). */
export function joinLookup<R extends { cells: Record<string, unknown> }>(
  column: Column,
  index: ReadonlyMap<string, LookupValue>,
  rows: readonly R[],
): R[] {
  const on = column.lookup?.match.on
  if (!on) return [...rows]
  return rows.map((r) => {
    const key = joinKey(r.cells[on])
    const value = key === null ? undefined : index.get(key)
    if (value === undefined) return r
    return { ...r, cells: { ...r.cells, [column.key]: value } }
  })
}

/** The tool source a lookup reads (as a dashboard block's). */
export function lookupSource(def: LookupDef): ToolSource {
  return {
    kind: "tool",
    tool: def.source.tool,
    params: def.source.params ?? {},
    ...(def.source.rowsPath ? { rowsPath: def.source.rowsPath } : {}),
  }
}

type LookupRead = { ok: true; pairs: LookupPairs } | { ok: false; note: string }

interface CachedLookup {
  pairs: LookupPairs
}

interface CachedLookupFailure {
  note: string
}

function lookupCacheKey(
  viewer: UserContext,
  tableId: string,
  column: string,
  source: ToolSource,
): string {
  return `dash:lookup:${viewer.orgId}:${tableId}:${column}:${sourceHash(source)}:${viewer.userId}:${permissionHash(viewer)}`
}

/**
 * One lookup column's read for `viewer`: checked as a dashboard source, its turn tainted as a
 * call of the tool, from the cache or read once (concurrent readers of one key wait on one read).
 */
async function readLookup(
  viewer: UserContext,
  tableId: string,
  column: Column,
  signal: AbortSignal | undefined,
): Promise<LookupRead> {
  const def = column.lookup!
  const [{ resolveSourceDates, runSource }, { checkToolSource }] = await Promise.all([
    import("~/modules/dashboards/execute"),
    import("~/modules/dashboards/sources"),
  ])
  let source: ToolSource
  try {
    source = await resolveSourceDates(lookupSource(def), viewer.orgId)
  } catch (err) {
    return { ok: false, note: err instanceof Error ? err.message : String(err) }
  }
  // Checked on every read, a cached one too: a tool turned off or a scope lost since shows nothing.
  const check = await checkToolSource(viewer.orgId, source.tool, viewer)
  if (!check.ok) return { ok: false, note: check.message }
  // The turn read what the tool reads, whether the rows come from the cache or a run.
  currentRunContext()?.turnScopeAccumulator?.record(check.tool)

  const key = lookupCacheKey(viewer, tableId, column.key, source)
  const failedKey = failedBlockCacheKey(key)
  const hit = await readCachedBlock<CachedLookup>(key)
  if (hit) return { ok: true, pairs: hit.pairs }
  const failed = await readCachedBlock<CachedLookupFailure>(failedKey)
  if (failed) return { ok: false, note: failed.note }
  if (
    (await isUncacheable(key)) &&
    !(await takeCustomWindowRun(viewer, `table-${tableId}`, `lookup:${column.key}`))
  ) {
    return {
      ok: false,
      note: "too many reads the cache cannot keep in the last minute: try again in a minute",
    }
  }
  return singleFlight(
    key,
    async (shared): Promise<LookupRead> => {
      const outcome = await withViewerSlot(viewer, () =>
        runSource(
          source,
          { viewer, dashboardId: null, signal: shared },
          { tableId, lookupColumn: column.key },
        ),
      )
      let read: LookupRead
      if (!outcome.ok) read = { ok: false, note: outcome.message }
      else if (!outcome.read.rows) {
        read = {
          ok: false,
          note: `${source.tool} answered no list of rows: name where they are with source.rowsPath`,
        }
      } else read = { ok: true, pairs: lookupPairs(def, outcome.read.rows) }
      if (shared.aborted) return read
      if (!read.ok) {
        await writeCachedBlock(
          failedKey,
          { note: read.note } satisfies CachedLookupFailure,
          FAILED_BLOCK_TTL_SEC,
        )
        return read
      }
      const entry: CachedLookup = { pairs: read.pairs }
      const kept =
        JSON.stringify(entry).length <= MAX_CACHED_LOOKUP_BYTES &&
        (await writeCachedBlock(key, entry, LOOKUP_TTL_SEC))
      if (!kept) await markUncacheable(key, LOOKUP_TTL_SEC)
      return read
    },
    signal,
  )
}

/**
 * The rows with every lookup column's cells in, and a note per lookup column whose read failed
 * (its cells stay empty). One read per lookup column, run together.
 */
export async function applyLookups<R extends { cells: Record<string, unknown> }>(
  viewer: UserContext,
  tableId: string,
  columns: readonly Column[],
  rows: readonly R[],
  opts: { signal?: AbortSignal } = {},
): Promise<{ rows: R[]; notes: Record<string, string> }> {
  const lookups = columns.filter((c) => c.type === "lookup" && c.lookup)
  if (lookups.length === 0) return { rows: [...rows], notes: {} }
  const reads = await Promise.all(lookups.map((c) => readLookup(viewer, tableId, c, opts.signal)))
  let out = [...rows]
  const notes: Record<string, string> = {}
  lookups.forEach((c, i) => {
    const read = reads[i]!
    if (!read.ok) {
      notes[c.key] = read.note
      return
    }
    out = joinLookup(c, lookupIndex(read.pairs, c.lookup!.valueType), out)
  })
  return { rows: out, notes }
}
