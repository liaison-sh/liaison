// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Running one dashboard block for the person VIEWING it: their scopes, their
// dimension grants, their RLS. Never the author's: a viewer who may not call a
// block's tool sees `no_access` for that block, and the other blocks render.
//
// A tool source runs through the tool core with origin "dashboard" on a
// READ-ONLY run (execute-tool.ts): a call that would need an approval is
// refused (`not_allowed`), never parked, and the sandbox bridge refuses every
// write, so a manifest that marks a writing tool readOnly gets nothing out of a
// view. Its eligibility (sources.ts) is checked again here, before every run.
// ctx.fetch stays callable on a read-only run (the bridge's known bound): an
// app's outbound POST is not stopped by this layer.
//
// A store source reads a declared, agent-readable collection under the
// viewer's RLS, with the declared read scope.
//
// Date tokens in a source's params ({{today-30d}}, relative-dates.ts) are resolved first, in
// the org's timezone (kernel.organizations.timezone; UTC when unset or not a valid zone), so
// eligibility, the cache key (service.ts) and the tool call all see the dates of this run.
//
// A source is read on its own (runSource) and mapped apart (transform.ts), so a dataset
// shared by several blocks is read once and mapped per block (service.ts).
//
// Every run writes one audit row (`dashboard.block_run`) naming the dashboard
// and the block (or the dataset, or the filter whose options it lists).

import { APP_DISABLED_CODE } from "@liaison/shared"
import { and, eq, inArray } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { organizations, users } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { READ_ONLY_RUN_BLOCKED_CODE } from "~/modules/agent/runtime/read-only-run"
import {
  currentRunContext,
  type RunContext,
  runContextStore,
} from "~/modules/agent/runtime/run-context"
import { DASHBOARD_NOT_ALLOWED_CODE, executeToolCore } from "~/modules/apps/execute-tool"
import { writeAuditLog } from "~/modules/audit/service"
import type { ResolvedWhere } from "~/modules/dashboards/filters"
import {
  DateTokenError,
  type DayWindow,
  dayIn,
  hasDateTokens,
  resolveDateTokens,
} from "~/modules/dashboards/relative-dates"
import {
  checkStoreSource,
  checkTableSource,
  checkToolSource,
  type SourceRefusalCode,
} from "~/modules/dashboards/sources"
import {
  type BlockSource,
  blockSourceOf,
  calcDatasets,
  type DashboardBlock,
  type DashboardSpec,
  layerBlocks,
  MAX_SOURCE_ROWS,
  type StoreSource,
  sourceValue,
  type TableSource,
  type ToolSource,
  type WhereClause,
  withSourceValue,
} from "~/modules/dashboards/spec"
import { loadTable, readAllRows, rowsOf, TableError } from "~/modules/dashboards/tables/service"
import {
  type BlockData,
  extractRows,
  mergeLayers,
  TransformError,
  transformBlock,
  unfenceSourceResult,
} from "~/modules/dashboards/transform"
import { DataStoreError, queryDocuments, type Where } from "~/modules/data-store/service"
import { isValidTimezone } from "~/modules/notifications/quiet-window"

const log = rootLogger.child({ module: "dashboards-execute" })

/** Pages a tool source is read for, when it answers with a cursor. */
export const MAX_SOURCE_PAGES = 10

export type BlockErrorCode = SourceRefusalCode | "source_failed" | "invalid_map" | "rate_limited"

export type BlockOutcome =
  | { ok: true; data: BlockData }
  | { ok: false; error: BlockErrorCode; message: string }

export interface BlockRunContext {
  viewer: UserContext
  /** The saved dashboard, or null for a preview. */
  dashboardId: string | null
  /**
   * The dashboard range this run reads (a block that follows it): its {{range.*}} tokens
   * become these days, and a metric's sparkline is filled over them.
   */
  range?: DayWindow | null
  /** The conversation a preview runs in: a source's outside text marks it, as a direct read would. */
  threadId?: string
  signal?: AbortSignal
}

const fail = (error: BlockErrorCode, message: string): BlockOutcome => ({
  ok: false,
  error,
  message,
})

/** The viewer's request ended mid-read: nothing to show, and nothing worth caching. */
const cancelled = (): BlockOutcome => fail("source_failed", "the read was cancelled")

/** The run frame a block's source runs in: read-only, and the calling turn's own when there is one. */
function readOnlyFrame(runId: string): RunContext {
  const parent = currentRunContext()
  if (parent) return { ...parent, readOnlyTools: true }
  return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, readOnlyTools: true }
}

function errorCodeFor(code: string): BlockErrorCode {
  if (code === "forbidden") return "no_access"
  if (code === "tool_not_found") return "unknown_tool"
  if (
    code === DASHBOARD_NOT_ALLOWED_CODE ||
    code === READ_ONLY_RUN_BLOCKED_CODE ||
    code === APP_DISABLED_CODE
  ) {
    return "not_allowed"
  }
  return "source_failed"
}

function nextCursorOf(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null
  const r = result as Record<string, unknown>
  const c = r.nextCursor ?? r.next_cursor
  return typeof c === "string" && c !== "" ? c : null
}

async function readToolSource(source: ToolSource, ctx: BlockRunContext, runId: string) {
  const viewer = ctx.viewer
  const check = await checkToolSource(viewer.orgId, source.tool, viewer)
  if (!check.ok) return { outcome: fail(check.code, check.message) }
  const frame = readOnlyFrame(runId)
  // The calling turn read what this source reads (a preview in a conversation).
  currentRunContext()?.turnScopeAccumulator?.record(check.tool)

  const rows: Record<string, unknown>[] = []
  let cursor: string | null = null
  const seen = new Set<string>()
  for (let page = 0; page < MAX_SOURCE_PAGES; page++) {
    // A viewer who left (tab closed, request timed out) stops the paging at the next page.
    if (ctx.signal?.aborted) return { outcome: cancelled() }
    const params = cursor ? { ...source.params, cursor } : source.params
    const envelope = await runContextStore.run(frame, () =>
      executeToolCore({
        toolName: source.tool,
        orgId: viewer.orgId,
        actor: viewer,
        params,
        origin: "dashboard",
        readOnlyRun: true,
        ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
    )
    if ("error" in envelope) {
      const code = errorCodeFor(envelope.error.code)
      if (code === "source_failed") {
        log.warn(
          {
            tool: source.tool,
            code: envelope.error.code,
            message: envelope.error.message,
            dashboardId: ctx.dashboardId,
          },
          "dashboard block source failed",
        )
      }
      return { outcome: fail(code, envelope.error.message) }
    }
    if ("blocked" in envelope) {
      return {
        outcome: fail(
          "not_allowed",
          `${source.tool} needs an approval and cannot run on a dashboard`,
        ),
      }
    }
    const result = unfenceSourceResult(envelope.data)
    const { rows: pageRows } = extractRows(result, source.rowsPath)
    // The first page decides the shape: one object (a metric's totals) is the result itself.
    // A later page without a row list ends the paging and keeps the rows already read.
    if (!pageRows) {
      if (page === 0) return { result }
      break
    }
    rows.push(...pageRows)
    cursor = nextCursorOf(result)
    if (!cursor || seen.has(cursor) || rows.length >= MAX_SOURCE_ROWS) break
    seen.add(cursor)
  }
  return { result: rows, paged: true }
}

async function readStoreSource(source: StoreSource, ctx: BlockRunContext) {
  const viewer = ctx.viewer
  const check = await checkStoreSource(viewer.orgId, source.app, source.collection, viewer)
  if (!check.ok) return { outcome: fail(check.code, check.message) }
  currentRunContext()?.turnScopeAccumulator?.recordInjected([check.declared.readScope])
  const caller = { orgId: viewer.orgId, app: source.app, userId: viewer.userId }
  const rows: Record<string, unknown>[] = []
  try {
    let cursor: string | undefined = (source.query as { cursor?: string }).cursor
    for (let page = 0; page < MAX_SOURCE_PAGES; page++) {
      if (ctx.signal?.aborted) return { outcome: cancelled() }
      const query = { ...source.query, ...(cursor ? { cursor } : {}) }
      const res = await withRlsContext(viewer, (tx) =>
        queryDocuments(tx, caller, source.collection, query),
      )
      for (const doc of res.items) rows.push({ ...doc.data, id: doc.id, updated_at: doc.updatedAt })
      if (!res.nextCursor || rows.length >= MAX_SOURCE_ROWS) break
      cursor = res.nextCursor
    }
  } catch (err) {
    if (err instanceof DataStoreError)
      return { outcome: fail("source_failed", `${err.code}: ${err.message}`) }
    throw err
  }
  return { result: rows }
}

/**
 * A dashboard table's rows as a source (A11): at most MAX_SOURCE_ROWS, read under the viewer's
 * RLS, `totalRows` past the cut when more matched (the block says it is truncated). Each row is
 * its visible cells plus `id`, `updated_at` and `updated_by` (who changed it last); a link cell
 * reads as its label, a person as their name and a multi choice as its choices joined, so a chart
 * groups and shows them as people read them.
 */
async function readTableSource(source: TableSource, ctx: BlockRunContext) {
  const viewer = ctx.viewer
  const check = await checkTableSource(viewer.orgId, source.table, viewer)
  if (!check.ok) return { outcome: fail(check.code, check.message) }
  try {
    return await withRlsContext(viewer, async (tx) => {
      const loaded = await loadTable(tx, viewer, source.table)
      const where = Object.keys(source.where ?? {}).length ? (source.where as Where) : undefined
      const { docs, truncated } = await readAllRows(tx, viewer, loaded, {
        ...(where ? { where } : {}),
        max: MAX_SOURCE_ROWS,
      })
      const rows = await rowsOf(tx, viewer, loaded, docs)
      const people = new Set<string>()
      for (const col of loaded.columns) {
        if (col.type !== "person") continue
        for (const r of rows)
          if (typeof r.cells[col.key] === "string") people.add(r.cells[col.key] as string)
      }
      const names = people.size
        ? new Map(
            (
              await tx
                .select({ id: users.id, name: users.name })
                .from(users)
                .where(and(eq(users.orgId, viewer.orgId), inArray(users.id, [...people])))
            ).map((u) => [u.id, u.name]),
          )
        : new Map<string, string>()
      const flat = rows.map((r) => {
        const out: Record<string, unknown> = {}
        for (const col of loaded.columns) {
          const v = r.cells[col.key]
          if (v === undefined) continue
          if (col.type === "link" && v && typeof v === "object") {
            out[col.key] = (v as { label?: unknown }).label ?? null
          } else if (col.type === "person" && typeof v === "string") {
            out[col.key] = names.get(v) ?? v
          } else if (col.type === "choices" && Array.isArray(v)) {
            out[col.key] = v.join(", ")
          } else out[col.key] = v
        }
        return { ...out, id: r.id, updated_at: r.updatedAt, updated_by: r.updatedBy.label }
      })
      return { result: flat, totalRows: truncated ? MAX_SOURCE_ROWS + 1 : flat.length }
    })
  } catch (err) {
    if (err instanceof TableError) {
      return {
        outcome: fail(err.code === "not_found" ? "no_access" : "source_failed", err.message),
      }
    }
    throw err
  }
}

/** What a source run is for, as its audit row names it. */
export type RunTarget = { blockId: string } | { datasetId: string } | { filterId: string }

function sourceLabel(source: BlockSource): string {
  if (source.kind === "tool") return source.tool
  return source.kind === "store"
    ? `store:${source.app}/${source.collection}`
    : `table:${source.table}`
}

async function auditRun(
  ctx: BlockRunContext,
  target: RunTarget,
  source: BlockSource,
  outcome: { ok: true } | { ok: false; error: BlockErrorCode },
) {
  try {
    await withPrivilegedDb(ctx.viewer.orgId, "dashboard-block-audit", (tx) =>
      writeAuditLog(tx, {
        orgId: ctx.viewer.orgId,
        actorId: ctx.viewer.userId,
        actorType: "user",
        app: "kernel",
        entityType: "dashboard",
        ...(ctx.dashboardId ? { entityId: ctx.dashboardId } : {}),
        action: ctx.dashboardId ? "dashboard.block_run" : "dashboard.block_preview",
        metadata: {
          dashboardId: ctx.dashboardId,
          ...target,
          source: sourceLabel(source),
          outcome: outcome.ok ? "ok" : outcome.error,
        },
      }),
    )
  } catch (err) {
    log.error({ err, dashboardId: ctx.dashboardId, ...target }, "dashboard block audit row failed")
  }
}

/** How long an org's timezone is kept in this process: a changed zone applies within a minute. */
const ORG_TIMEZONE_TTL_MS = 60_000
const dashboardTimezones = new Map<string, { tz: string; until: number }>()

/** The zone a block's date tokens resolve in: the org's, else UTC. */
export async function dashboardTimezone(orgId: string): Promise<string> {
  const now = Date.now()
  const hit = dashboardTimezones.get(orgId)
  if (hit && hit.until > now) return hit.tz
  const [row] = await withPrivilegedDb(orgId, "dashboard-org-timezone", (tx) =>
    tx
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  const tz = isValidTimezone(row?.timezone) ? row.timezone : "UTC"
  dashboardTimezones.set(orgId, { tz, until: now + ORG_TIMEZONE_TTL_MS })
  return tz
}

/**
 * `source` with its date tokens replaced by the dates of `now` in the org's timezone, its range
 * tokens by `range`. A source without tokens is returned as it is (no lookup). Filter tokens
 * must be resolved first (filters.ts). Throws DateTokenError on an unknown token, or a range
 * token without a range.
 */
export async function resolveSourceDates<S extends BlockSource>(
  source: S,
  orgId: string,
  now: Date = new Date(),
  range: DayWindow | null = null,
): Promise<S> {
  const value = sourceValue(source)
  if (!hasDateTokens(value)) return source
  const resolved = resolveDateTokens(value, {
    timeZone: await dashboardTimezone(orgId),
    now,
    range,
  })
  return withSourceValue(source, resolved)
}

/** A source's rows as read: at most MAX_SOURCE_ROWS, or the one object it answered. */
export interface SourceRows {
  rows: Record<string, unknown>[] | null
  /** The result itself when it holds no rows (a metric reads a path into it); else null. */
  object: unknown
  /** Rows the source returned, before the cut. */
  totalRows: number
  /**
   * The fields the source's rows carried before the cache kept only what the dashboard reads
   * (names only): what a person can add a filter on.
   */
  fieldNames?: string[]
}

export type SourceOutcome =
  | { ok: true; read: SourceRows }
  | { ok: false; error: BlockErrorCode; message: string }

/**
 * Reads one source (its tokens resolved) as the viewer: one run, one audit row. The rows are
 * found as the map would find them (rowsPath, a list field), cut to MAX_SOURCE_ROWS.
 */
export async function runSource(
  source: BlockSource,
  ctx: BlockRunContext,
  target: RunTarget,
): Promise<SourceOutcome> {
  let outcome: SourceOutcome
  try {
    const name =
      "blockId" in target
        ? target.blockId
        : "datasetId" in target
          ? `ds-${target.datasetId}`
          : `filter-${target.filterId}`
    const runId = `dashboard:${ctx.dashboardId ?? "preview"}:${name}`
    const read =
      source.kind === "tool"
        ? await readToolSource(source, ctx, runId)
        : source.kind === "store"
          ? await readStoreSource(source, ctx)
          : await readTableSource(source, ctx)
    if ("outcome" in read && read.outcome) {
      outcome = read.outcome as SourceOutcome
    } else {
      const paged = "paged" in read && read.paged === true
      const rowsPath = source.kind === "tool" && !paged ? source.rowsPath : undefined
      const { rows, object } = extractRows(read.result, rowsPath)
      outcome = {
        ok: true,
        read: rows
          ? {
              rows: rows.slice(0, MAX_SOURCE_ROWS),
              object: null,
              totalRows:
                "totalRows" in read && typeof read.totalRows === "number"
                  ? read.totalRows
                  : rows.length,
            }
          : { rows: null, object, totalRows: 0 },
      }
    }
  } catch (err) {
    if (err instanceof TransformError || err instanceof DateTokenError) {
      outcome = { ok: false, error: "invalid_map", message: err.message }
    } else {
      log.error({ err, dashboardId: ctx.dashboardId, ...target }, "dashboard source failed")
      outcome = {
        ok: false,
        error: "source_failed",
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }
  await auditRun(ctx, target, source, outcome)
  return outcome
}

/** The app a source's records belong to (an entity link's default). */
export function sourceApp(source: BlockSource | null): string | undefined {
  if (!source) return undefined
  if (source.kind === "tool") return source.tool.slice(0, source.tool.indexOf(":"))
  return source.kind === "store" ? source.app : "dashboards"
}

/** Maps a read source into what one block draws. */
export function mapBlock(
  block: DashboardBlock,
  read: SourceRows,
  opts: {
    window?: DayWindow | null
    where?: ResolvedWhere[]
    linkApp?: string
    timeZone?: string
    datasetRows?: Record<string, Record<string, unknown>[] | null>
    /** Today in the org's zone: a date chart's bucket holding it is in progress. */
    today?: string
  },
): BlockOutcome {
  try {
    return {
      ok: true,
      data: transformBlock(block.type, block.map, read.rows ?? read.object, {
        window: opts.window ?? null,
        totalRows: read.totalRows,
        ...(opts.where ? { where: opts.where } : {}),
        ...(opts.linkApp ? { linkApp: opts.linkApp } : {}),
        ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
        ...(opts.datasetRows ? { datasetRows: opts.datasetRows } : {}),
        ...(opts.today ? { today: opts.today } : {}),
        ...(block.text !== undefined ? { text: block.text } : {}),
      }),
    }
  } catch (err) {
    if (err instanceof TransformError) return fail("invalid_map", err.message)
    throw err
  }
}

/**
 * Runs one block's source as the viewer and maps it (a preview: no cache). A dataset block
 * reads `datasets`; its filter tokens must be resolved already.
 */
export async function computeBlock(
  block: DashboardBlock,
  ctx: BlockRunContext & {
    datasets?: DashboardSpec["datasets"]
    where?: ResolvedWhere[]
    /** A dataset with this request's filter values in (a preview resolves its filter tokens). */
    resolveDataset?: (source: BlockSource) => BlockSource
    /** A layer's map.where with this request's filter values in. */
    resolveWhere?: (where: WhereClause[] | undefined) => ResolvedWhere[]
  },
): Promise<BlockOutcome> {
  if (block.type === "text") {
    return mapBlock(block, { rows: [], object: null, totalRows: 0 }, {})
  }
  if (block.layers) {
    // Each layer runs as a block of its own, then they join on their date buckets.
    const layers = block.layers
    const outs = await Promise.all(
      layerBlocks(block).map((lb) =>
        computeBlock(
          lb.source && ctx.resolveDataset ? { ...lb, source: ctx.resolveDataset(lb.source) } : lb,
          { ...ctx, where: ctx.resolveWhere ? ctx.resolveWhere(lb.map.where) : [] },
        ),
      ),
    )
    if (!outs.some((o) => o.ok)) {
      const first = outs[0] as Extract<BlockOutcome, { ok: false }>
      return fail(first.error, `layer '${layers[0]!.id}': ${first.message}`)
    }
    return {
      ok: true,
      data: mergeLayers(
        layers.map((layer, i) => {
          const o = outs[i]!
          return o.ok
            ? { layer, data: o.data }
            : { layer, error: { error: o.error, message: o.message } }
        }),
        block.map,
      ),
    }
  }
  const saved = blockSourceOf(block, ctx.datasets)
  if (!saved) return fail("invalid_map", `no dataset '${block.dataset ?? ""}' for this block`)
  let source: BlockSource
  try {
    source = await resolveSourceDates(saved, ctx.viewer.orgId, new Date(), ctx.range ?? null)
  } catch (err) {
    if (err instanceof DateTokenError) return fail("invalid_map", err.message)
    throw err
  }
  const outcome = await runSource(source, ctx, { blockId: block.id })
  if (!outcome.ok) return outcome
  const datasetRows: Record<string, Record<string, unknown>[] | null> = {}
  for (const id of calcDatasets(block)) {
    const ds = ctx.datasets?.[id]
    if (!ds) return fail("invalid_map", `no dataset '${id}' for this block`)
    let resolved: BlockSource
    try {
      resolved = await resolveSourceDates(
        ctx.resolveDataset ? ctx.resolveDataset(ds) : ds,
        ctx.viewer.orgId,
        new Date(),
        ctx.range ?? null,
      )
    } catch (err) {
      if (err instanceof DateTokenError) return fail("invalid_map", err.message)
      throw err
    }
    const read = await runSource(resolved, ctx, { datasetId: id })
    if (!read.ok) return read
    datasetRows[id] = read.read.rows
  }
  const timeZone = await dashboardTimezone(ctx.viewer.orgId)
  return mapBlock(block, outcome.read, {
    ...(Object.keys(datasetRows).length ? { datasetRows } : {}),
    window: ctx.range ?? null,
    timeZone,
    today: dayIn(timeZone, new Date()),
    ...(ctx.where ? { where: ctx.where } : {}),
    ...(sourceApp(source) ? { linkApp: sourceApp(source)! } : {}),
  })
}
