// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Dashboards (kernel.dashboards): CRUD under the caller's RLS, and a block's
// data for the person viewing it.
//
// Who may do what (persons; the agent's tools add an approval for org ones, tools.ts):
// - kernel:dashboards:write: create, edit and delete one's own personal dashboards.
// - kernel:dashboards:share: also make one's own dashboard org-visible, and edit
//   or delete one's own org dashboards.
// - kernel:dashboards:admin: edit or delete any org dashboard.
// Nobody reads another person's personal dashboard (RLS). The service checks the
// same rules as the row policies (migration 0275) so a refusal names its scope.
//
// A saved spec is valid (spec.ts) and every block's source may feed a dashboard
// for its AUTHOR (sources.ts): an unknown tool, a write, a gated tool or a
// source the author cannot read is refused at save. The same check runs again
// on every view, as the viewer.

import { and, desc, eq, inArray, isNull, lte, ne, or, type SQL } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import {
  type DashboardRow,
  dashboards,
  dashboardVersions,
  dashboardViewerStates,
  users,
} from "~/db/schema/kernel"
import {
  FAILED_BLOCK_TTL_SEC,
  failedBlockCacheKey,
  isUncacheable,
  markUncacheable,
  REFRESH_WINDOW_SEC,
  readCachedBlock,
  type SourceKey,
  singleFlight,
  sourceCacheKey,
  takeCustomWindowRun,
  takeRefresh,
  withViewerSlot,
  writeCachedBlock,
} from "~/modules/dashboards/cache"
import {
  applyOperations,
  cardLineCount,
  describeOperations,
  type EditOperation,
  EditOperationError,
  revertTargets,
  type SavedVersion,
  type VersionLookup,
} from "~/modules/dashboards/edit"
import {
  type BlockErrorCode,
  dashboardTimezone,
  mapBlock,
  type RunTarget,
  resolveSourceDates,
  runSource,
  type SourceRows,
  sourceApp,
} from "~/modules/dashboards/execute"
import {
  defaultFilterValues,
  FilterValueError,
  type FilterValues,
  normalizeFilterValues,
  resolveFilterTokens,
  resolveWhere,
  sanitizeSavedFilterValues,
} from "~/modules/dashboards/filters"
import {
  type CompareMode,
  compareWindow,
  DateTokenError,
  type DayWindow,
  dateTokensIn,
  dayIn,
  filterTokensIn,
  hasRangeTokens,
  resolveDateTokens,
  resolveTimeRange,
  type TimePreset,
  type TimeRange,
} from "~/modules/dashboards/relative-dates"
import { checkStoreSource, checkToolSource } from "~/modules/dashboards/sources"
import {
  type BlockRangeMode,
  type BlockSource,
  blockRangeMode,
  blockSourceOf,
  blockTtlSec,
  calcDatasets,
  type DashboardBlock,
  type DashboardSpec,
  dashboardDefaultRange,
  dashboardSpecSchema,
  LAYER_SEP,
  layerBlocks,
  MAX_SOURCE_ROWS,
  MAX_SOURCE_TTL_SEC,
  runnableBlocks,
  sourceValue,
  specIssues,
  timeRangeSchema,
} from "~/modules/dashboards/spec"
import {
  attachPrevious,
  type BlockData,
  blockRows,
  categoryField,
  categoryOf,
  linkFields,
  mergeLayers,
  NONE_LABEL,
  projectRow,
  type RecordLink,
  readPath,
  recordLink,
  seriesNameOf,
  sortedTableRows,
  TransformError,
} from "~/modules/dashboards/transform"
import { hasScope } from "~/modules/permissions/permissions"

export type DashboardVisibility = "personal" | "org"

export type DashboardErrorCode =
  | "NOT_FOUND"
  | "SCOPE_DENIED"
  | "INVALID_SPEC"
  | "VERSION_CONFLICT"
  | "INVALID_REQUEST"

export class DashboardError extends Error {
  constructor(
    readonly code: DashboardErrorCode,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message)
  }
}

export const WRITE_SCOPE = "kernel:dashboards:write"
export const SHARE_SCOPE = "kernel:dashboards:share"
export const ADMIN_SCOPE = "kernel:dashboards:admin"

/** The person a dashboard is read or written for: a user actor. */
export type DashboardViewer = UserContext

export interface DashboardRecord {
  id: string
  title: string
  visibility: DashboardVisibility
  ownerUserId: string | null
  spec: DashboardSpec
  version: number
  createdBy: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  /** May this viewer edit it (title, blocks, visibility) and delete it. */
  canEdit: boolean
}

export interface DashboardSummary {
  id: string
  title: string
  visibility: DashboardVisibility
  ownerUserId: string | null
  /** The owner's display name, for "by <name>" in the list (null when the owner is gone). */
  ownerName: string | null
  /** The spec's description, or null. */
  description: string | null
  version: number
  blockCount: number
  updatedAt: string
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : String(d))

/** May `viewer` edit or delete this dashboard (the row policies, in words)? */
export function canEditDashboard(
  viewer: DashboardViewer,
  row: Pick<DashboardRow, "visibility" | "ownerUserId">,
): boolean {
  if (row.visibility === "org" && hasScope(ADMIN_SCOPE, viewer.scopes)) return true
  if (row.ownerUserId !== viewer.userId) return false
  if (row.visibility === "personal") return hasScope(WRITE_SCOPE, viewer.scopes)
  return hasScope(SHARE_SCOPE, viewer.scopes)
}

/** May `viewer` own a dashboard of this visibility (create one, or switch theirs to it)? */
function mayHold(viewer: DashboardViewer, visibility: DashboardVisibility): boolean {
  if (visibility === "personal") return hasScope(WRITE_SCOPE, viewer.scopes)
  return hasScope(SHARE_SCOPE, viewer.scopes) || hasScope(ADMIN_SCOPE, viewer.scopes)
}

function toRecord(viewer: DashboardViewer, row: DashboardRow): DashboardRecord {
  return {
    id: row.id,
    title: row.title,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    spec: row.spec as unknown as DashboardSpec,
    version: row.version,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    canEdit: canEditDashboard(viewer, row),
  }
}

export type DashboardEventAction = "created" | "updated" | "deleted"

/**
 * What a `kernel:dashboard` frame carries: ids, visibility and version, never the
 * title or the spec. A client that hears one re-reads its list (and an open view
 * its record) through the REST routes, under its own RLS. Delivery
 * (infra/websocket.ts, `hasDashboardVisibilityAccess`): an org dashboard's frame
 * reaches every member who reads dashboards; a personal one's reaches its owner
 * only. `previousVisibility: "org"` on a switch to personal tells the members who
 * saw it to drop it.
 */
export interface DashboardEventData {
  dashboardId: string
  visibility: DashboardVisibility
  previousVisibility?: DashboardVisibility
  ownerUserId: string | null
  version: number
}

async function queueDashboardEvent(
  t: RlsClient,
  viewer: DashboardViewer,
  action: DashboardEventAction,
  row: Pick<DashboardRow, "id" | "visibility" | "ownerUserId" | "version">,
  previousVisibility?: DashboardVisibility,
): Promise<void> {
  const data: DashboardEventData = {
    dashboardId: row.id,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    version: row.version,
    ...(previousVisibility && previousVisibility !== row.visibility ? { previousVisibility } : {}),
  }
  await t.queueEvent({
    app: "kernel",
    entity: "dashboard",
    action,
    entityId: row.id,
    data: data as unknown as Record<string, unknown>,
    actorId: viewer.userId,
    actorType: "user",
    orgId: viewer.orgId,
    timestamp: new Date().toISOString(),
  })
}

/** Runs on `tx` when the caller holds one (an agent tool's), else in a fresh RLS transaction. */
function inTx<T>(
  viewer: DashboardViewer,
  tx: RlsClient | undefined,
  fn: (t: RlsClient) => Promise<T>,
) {
  return tx ? fn(tx) : withRlsContext(viewer, fn)
}

/**
 * A spec as saved: valid, and every block's source one `author` may put on a
 * dashboard. Throws INVALID_SPEC listing every problem.
 */
export async function validateSpec(author: DashboardViewer, raw: unknown): Promise<DashboardSpec> {
  const parsed = dashboardSpecSchema.safeParse(raw)
  if (!parsed.success) {
    throw new DashboardError(
      "INVALID_SPEC",
      "the dashboard spec is not valid",
      specIssues(parsed.error),
    )
  }
  const problems: string[] = []
  const sourceCheck = (source: BlockSource) =>
    source.kind === "tool"
      ? checkToolSource(author.orgId, source.tool, author)
      : checkStoreSource(author.orgId, source.app, source.collection, author)
  for (const [id, source] of Object.entries(parsed.data.datasets ?? {})) {
    const check = await sourceCheck(source)
    if (!check.ok) problems.push(`datasets.${id}: ${check.code}: ${check.message}`)
  }
  for (const [i, block] of parsed.data.blocks.entries()) {
    for (const [l, layer] of (block.layers ?? []).entries()) {
      if (!layer.source) continue
      const check = await sourceCheck(layer.source)
      if (!check.ok) {
        problems.push(
          `blocks.${i}.layers.${l} (${block.id}, layer ${layer.id}): ${check.code}: ${check.message}`,
        )
      }
    }
    if (!block.source) continue
    const check = await sourceCheck(block.source)
    if (!check.ok) problems.push(`blocks.${i} (${block.id}): ${check.code}: ${check.message}`)
  }
  for (const [i, f] of (parsed.data.filters ?? []).entries()) {
    if (!f.options || Array.isArray(f.options) || !("fromSource" in f.options)) continue
    const check = await sourceCheck(f.options.fromSource)
    if (!check.ok) problems.push(`filters.${i} (${f.id}): ${check.code}: ${check.message}`)
  }
  if (problems.length) {
    throw new DashboardError(
      "INVALID_SPEC",
      "a block's source cannot feed this dashboard",
      problems,
    )
  }
  return parsed.data
}

export async function listDashboards(
  viewer: DashboardViewer,
  tx?: RlsClient,
): Promise<DashboardSummary[]> {
  const rows = await inTx(viewer, tx, (t) =>
    t
      .select({ d: dashboards, ownerName: users.name })
      .from(dashboards)
      .leftJoin(users, eq(users.id, dashboards.ownerUserId))
      .orderBy(desc(dashboards.updatedAt))
      .limit(200),
  )
  return rows.map(({ d: r, ownerName }) => ({
    id: r.id,
    title: r.title,
    visibility: r.visibility,
    ownerUserId: r.ownerUserId,
    ownerName: ownerName ?? null,
    description:
      typeof (r.spec as { description?: unknown }).description === "string"
        ? ((r.spec as { description: string }).description ?? null)
        : null,
    version: r.version,
    blockCount: Array.isArray((r.spec as { blocks?: unknown }).blocks)
      ? (r.spec as { blocks: unknown[] }).blocks.length
      : 0,
    updatedAt: iso(r.updatedAt),
  }))
}

async function loadRow(viewer: DashboardViewer, id: string, tx?: RlsClient): Promise<DashboardRow> {
  const [row] = await inTx(viewer, tx, (t) =>
    t.select().from(dashboards).where(eq(dashboards.id, id)).limit(1),
  )
  if (!row) throw new DashboardError("NOT_FOUND", "no such dashboard")
  return row
}

/** A dashboard's range as one person sees it: their remembered choice, else its default. */
export interface DashboardRangeView {
  timeRange: TimeRange
  compare: CompareMode
  /** True when this is the viewer's own remembered choice. */
  saved: boolean
  /** The range's days today, in the org's timezone. */
  window: DayWindow
  compareWindow: DayWindow | null
}

export interface DashboardView extends DashboardRecord {
  range: DashboardRangeView
  defaultRange: { timeRange: TimeRange; compare: CompareMode }
  /** Each block: does it follow the dashboard range, or keep its own dates. */
  blockTimeRange: Record<string, BlockRangeMode>
  /** At least one block follows the dashboard range (the range picker is worth showing). */
  usesTimeRange: boolean
  /** The filter values the viewer opens on: their remembered ones, else the defaults. */
  filters: { values: FilterValues; saved: boolean }
  defaultFilters: FilterValues
  /** Today in the org's zone (YYYY-MM-DD): what the presets resolve from. */
  today: string
  /** The org's IANA zone (UTC when unset): dates and buckets are its calendar days. */
  timeZone: string
}

/** One person's remembered state on one dashboard, as stored (any part may be unset). */
interface StoredViewerState {
  timeRange: unknown
  compare: string | null
  filters: unknown
}

/**
 * A remembered range and comparison read back, each on its own (a comparison remembered without
 * a range still counts): a part another release wrote in a shape this one refuses is ignored.
 */
function parseViewerState(
  row: { timeRange: unknown; compare: string | null } | undefined,
): { timeRange?: TimeRange; compare?: CompareMode } | null {
  if (!row) return null
  const tr = row.timeRange === null ? null : timeRangeSchema.safeParse(row.timeRange)
  const compare =
    row.compare !== null && ["lastYear", "previousPeriod", "none"].includes(row.compare)
      ? (row.compare as CompareMode)
      : undefined
  const out = { ...(tr?.success ? { timeRange: tr.data } : {}), ...(compare ? { compare } : {}) }
  return Object.keys(out).length ? out : null
}

/** What 0290's CHECK measures: the jsonb text of the remembered filters (`{"a": ["x", "y"]}`). */
export const MAX_VIEWER_FILTERS_BYTES = 16_384

function jsonbTextBytes(filters: FilterValues): number {
  const entries = Object.values(filters)
  const separators =
    2 * entries.length + entries.reduce((n, list) => n + Math.max(list.length - 1, 0), 0)
  return Buffer.byteLength(JSON.stringify(filters)) + separators
}

export async function getDashboard(
  viewer: DashboardViewer,
  id: string,
  tx?: RlsClient,
  now: Date = new Date(),
): Promise<DashboardView> {
  const { row, state, stored } = await inTx(viewer, tx, async (t) => {
    const [found] = await t.select().from(dashboards).where(eq(dashboards.id, id)).limit(1)
    if (!found) throw new DashboardError("NOT_FOUND", "no such dashboard")
    const [saved] = await t
      .select({
        timeRange: dashboardViewerStates.timeRange,
        compare: dashboardViewerStates.compare,
        filters: dashboardViewerStates.filters,
      })
      .from(dashboardViewerStates)
      .where(
        and(
          eq(dashboardViewerStates.dashboardId, id),
          eq(dashboardViewerStates.userId, viewer.userId),
        ),
      )
      .limit(1)
    return { row: found, state: parseViewerState(saved), stored: saved }
  })
  const record = toRecord(viewer, row)
  const spec = record.spec
  const defaultFilters = defaultFilterValues(spec ?? {})
  const savedFilters = sanitizeSavedFilterValues(spec ?? {}, stored?.filters)
  const filtersSaved = Object.keys(savedFilters).length > 0
  const defaults = dashboardDefaultRange(spec ?? {})
  const chosen = state
    ? {
        timeRange: state.timeRange ?? defaults.timeRange,
        compare: state.compare ?? defaults.compare,
      }
    : defaults
  const timeZone = await dashboardTimezone(viewer.orgId)
  const window = resolveTimeRange(chosen.timeRange, { timeZone, now })
  const blockTimeRange: Record<string, BlockRangeMode> = {}
  for (const b of spec?.blocks ?? []) {
    // A saved block of a shape this release does not know reads as fixed.
    try {
      blockTimeRange[b.id] = blockRangeMode(b, spec.datasets)
    } catch {
      blockTimeRange[b.id] = "fixed"
    }
  }
  return {
    ...record,
    range: {
      ...chosen,
      saved: state !== null,
      window,
      compareWindow: compareWindow(chosen.timeRange.preset, window, chosen.compare),
    },
    defaultRange: defaults,
    blockTimeRange,
    usesTimeRange: Object.values(blockTimeRange).includes("dashboard"),
    filters: { values: { ...defaultFilters, ...savedFilters }, saved: filtersSaved },
    defaultFilters,
    today: dayIn(timeZone, now),
    timeZone,
  }
}

// ── a person's remembered range and filters ─────────────────────────────────

export interface ViewerState {
  timeRange: TimeRange | null
  compare: CompareMode | null
  filters: FilterValues
}

/** What a PUT changes: any of the three (filters replaces the whole remembered map). */
export interface ViewerStateInput {
  timeRange?: TimeRange
  compare?: CompareMode
  filters?: Record<string, string[]>
}

function viewerStateOf(spec: Pick<DashboardSpec, "filters">, row: StoredViewerState): ViewerState {
  const tr = row.timeRange === null ? null : timeRangeSchema.safeParse(row.timeRange)
  const compare =
    row.compare !== null && ["lastYear", "previousPeriod", "none"].includes(row.compare)
      ? (row.compare as CompareMode)
      : null
  return {
    timeRange: tr?.success ? tr.data : null,
    compare,
    filters: sanitizeSavedFilterValues(spec, row.filters),
  }
}

function selectState(t: RlsClient, viewer: DashboardViewer, dashboardId: string) {
  return t
    .select({
      timeRange: dashboardViewerStates.timeRange,
      compare: dashboardViewerStates.compare,
      filters: dashboardViewerStates.filters,
    })
    .from(dashboardViewerStates)
    .where(
      and(
        eq(dashboardViewerStates.dashboardId, dashboardId),
        eq(dashboardViewerStates.userId, viewer.userId),
      ),
    )
    .limit(1)
}

/** What `viewer` last chose on this dashboard, or null. NOT_FOUND when they cannot see it. */
export async function getViewerRange(
  viewer: DashboardViewer,
  dashboardId: string,
): Promise<ViewerState | null> {
  return withRlsContext(viewer, async (t) => {
    const dashboard = await loadRow(viewer, dashboardId, t)
    const [row] = await selectState(t, viewer, dashboardId)
    return row ? viewerStateOf(dashboard.spec as unknown as DashboardSpec, row) : null
  })
}

/**
 * Remembers this person's choice on this dashboard (only they ever read it), merged into what
 * was remembered: a range, a comparison, the filter values (the whole map at once).
 */
export async function setViewerRange(
  viewer: DashboardViewer,
  dashboardId: string,
  input: ViewerStateInput,
): Promise<ViewerState> {
  let timeRange: TimeRange | undefined
  if (input.timeRange !== undefined) {
    const parsed = timeRangeSchema.safeParse(input.timeRange)
    if (!parsed.success) {
      throw new DashboardError(
        "INVALID_SPEC",
        "the time range is not valid",
        specIssues(parsed.error),
      )
    }
    timeRange = parsed.data
  }
  return withRlsContext(viewer, async (t) => {
    const dashboard = await loadRow(viewer, dashboardId, t)
    const spec = dashboard.spec as unknown as DashboardSpec
    let filters: FilterValues | undefined
    if (input.filters !== undefined) {
      try {
        const all = normalizeFilterValues(spec, input.filters)
        filters = Object.fromEntries(Object.keys(input.filters).map((id) => [id, all[id] ?? []]))
      } catch (err) {
        if (err instanceof FilterValueError) {
          throw new DashboardError("INVALID_REQUEST", err.message)
        }
        throw err
      }
      const bytes = jsonbTextBytes(filters)
      if (bytes > MAX_VIEWER_FILTERS_BYTES) {
        throw new DashboardError(
          "INVALID_REQUEST",
          `the filter values are too long to remember (${bytes} bytes, at most ${MAX_VIEWER_FILTERS_BYTES})`,
        )
      }
    }
    const [before] = await selectState(t, viewer, dashboardId)
    const next = {
      timeRange: (timeRange ?? before?.timeRange ?? null) as Record<string, unknown> | null,
      compare: input.compare ?? before?.compare ?? null,
      filters: filters ?? (before?.filters as Record<string, string[]> | undefined) ?? {},
    }
    await t
      .insert(dashboardViewerStates)
      .values({ orgId: viewer.orgId, dashboardId, userId: viewer.userId, ...next })
      .onConflictDoUpdate({
        target: [dashboardViewerStates.dashboardId, dashboardViewerStates.userId],
        set: { ...next, updatedAt: new Date() },
      })
    return viewerStateOf(spec, next)
  })
}

/** Forgets this person's choices: the dashboard opens on its defaults again. */
export async function clearViewerRange(
  viewer: DashboardViewer,
  dashboardId: string,
): Promise<void> {
  await withRlsContext(viewer, async (t) => {
    await loadRow(viewer, dashboardId, t)
    await t
      .delete(dashboardViewerStates)
      .where(
        and(
          eq(dashboardViewerStates.dashboardId, dashboardId),
          eq(dashboardViewerStates.userId, viewer.userId),
        ),
      )
  })
}

// ── version history ────────────────────────────────────────────────────────

/** Saved versions kept per dashboard (older ones are deleted with the save that passes it). */
export const KEPT_VERSIONS = 20

/** Keeps `row`'s title and spec as its version, and prunes past KEPT_VERSIONS. */
async function recordVersion(
  t: RlsClient,
  viewer: DashboardViewer,
  row: DashboardRow,
  opts: { ifMissing?: boolean } = {},
): Promise<void> {
  await t
    .insert(dashboardVersions)
    .values({
      orgId: viewer.orgId,
      dashboardId: row.id,
      version: row.version,
      title: row.title,
      spec: row.spec,
      visibility: row.visibility,
      savedBy: opts.ifMissing ? row.updatedBy : viewer.userId,
      savedAt: opts.ifMissing ? new Date(row.updatedAt) : new Date(),
    })
    .onConflictDoNothing()
  if (opts.ifMissing) return
  await t
    .delete(dashboardVersions)
    .where(
      and(
        eq(dashboardVersions.dashboardId, row.id),
        lte(dashboardVersions.version, row.version - KEPT_VERSIONS),
      ),
    )
}

/**
 * Versions saved while the dashboard was personal are its owner's drafts: once it is shared,
 * everyone else sees (and reverts to) only those saved while it was shared, or before this was
 * recorded. Undefined (no condition) for its owner.
 */
function ownersDraftsHidden(viewer: DashboardViewer, row: DashboardRow): SQL | undefined {
  if (row.ownerUserId === viewer.userId) return undefined
  return or(isNull(dashboardVersions.visibility), ne(dashboardVersions.visibility, "personal"))
}

export interface DashboardVersionSummary {
  version: number
  title: string
  savedAt: string
  savedBy: string | null
  savedByName: string | null
  blockCount: number
  /** The version the dashboard is at now. */
  current: boolean
}

/** The kept versions of a dashboard `viewer` sees, newest first. NOT_FOUND when they cannot. */
export async function listVersions(
  viewer: DashboardViewer,
  dashboardId: string,
  tx?: RlsClient,
): Promise<DashboardVersionSummary[]> {
  return inTx(viewer, tx, async (t) => {
    const row = await loadRow(viewer, dashboardId, t)
    const rows = await t
      .select({ v: dashboardVersions, savedByName: users.name })
      .from(dashboardVersions)
      .leftJoin(users, eq(users.id, dashboardVersions.savedBy))
      .where(and(eq(dashboardVersions.dashboardId, dashboardId), ownersDraftsHidden(viewer, row)))
      .orderBy(desc(dashboardVersions.version))
      .limit(KEPT_VERSIONS + 1)
    return rows.map(({ v, savedByName }) => ({
      version: v.version,
      title: v.title,
      savedAt: iso(v.savedAt),
      savedBy: v.savedBy,
      savedByName: savedByName ?? null,
      blockCount: Array.isArray((v.spec as { blocks?: unknown }).blocks)
        ? (v.spec as { blocks: unknown[] }).blocks.length
        : 0,
      current: v.version === row.version,
    }))
  })
}

export interface DashboardVersionDetail {
  version: number
  title: string
  spec: Record<string, unknown>
  savedAt: string
  savedBy: string | null
  savedByName: string | null
}

/** One kept version (its whole spec). NOT_FOUND when the dashboard is not visible or it was pruned. */
export async function getVersion(
  viewer: DashboardViewer,
  dashboardId: string,
  version: number,
  tx?: RlsClient,
): Promise<DashboardVersionDetail> {
  const found = await inTx(viewer, tx, async (t) => {
    const row = await loadRow(viewer, dashboardId, t)
    return readVersions(t, dashboardId, [version], ownersDraftsHidden(viewer, row))
  })
  const v = found.get(version)
  if (!v) throw new DashboardError("NOT_FOUND", `version ${version} is not kept`)
  return { ...v, savedBy: v.savedBy }
}

/** The kept versions `numbers` of a dashboard, read on `t` (the caller's RLS, or a summarizer's). */
export async function readVersions(
  t: Pick<RlsClient, "select">,
  dashboardId: string,
  numbers: number[],
  /** A further condition (ownersDraftsHidden): versions it leaves out read as not kept. */
  visible?: SQL,
): Promise<Map<number, SavedVersion & { savedBy: string | null }>> {
  const out = new Map<number, SavedVersion & { savedBy: string | null }>()
  if (numbers.length === 0) return out
  const rows = await t
    .select({ v: dashboardVersions, savedByName: users.name })
    .from(dashboardVersions)
    .leftJoin(users, eq(users.id, dashboardVersions.savedBy))
    .where(
      and(
        eq(dashboardVersions.dashboardId, dashboardId),
        inArray(dashboardVersions.version, numbers),
        visible,
      ),
    )
  for (const { v, savedByName } of rows) {
    out.set(v.version, {
      version: v.version,
      title: v.title,
      spec: v.spec,
      savedAt: iso(v.savedAt),
      savedBy: v.savedBy,
      savedByName: savedByName ?? null,
    })
  }
  return out
}

/**
 * A copy of a dashboard `viewer` sees, as their own new PERSONAL dashboard: same spec, title
 * "<title> (copy)" unless given. Needs kernel:dashboards:write, and every source must be one the
 * viewer may read (validated as for any save).
 */
export async function duplicateDashboard(
  viewer: DashboardViewer,
  id: string,
  input: { title?: string } = {},
  tx?: RlsClient,
): Promise<DashboardRecord> {
  const source = await loadRow(viewer, id, tx)
  const suffix = " (copy)"
  const title = input.title ?? `${source.title.slice(0, 200 - suffix.length)}${suffix}`
  return createDashboard(viewer, { title, visibility: "personal", spec: source.spec }, tx)
}

export interface CreateDashboardInput {
  title: string
  visibility: DashboardVisibility
  spec: unknown
}

export async function createDashboard(
  viewer: DashboardViewer,
  input: CreateDashboardInput,
  tx?: RlsClient,
): Promise<DashboardRecord> {
  if (!mayHold(viewer, input.visibility)) {
    throw new DashboardError(
      "SCOPE_DENIED",
      input.visibility === "org"
        ? `an org dashboard needs ${SHARE_SCOPE}`
        : `a dashboard needs ${WRITE_SCOPE}`,
    )
  }
  const spec = await validateSpec(viewer, input.spec)
  const row = await inTx(viewer, tx, async (t) => {
    const [inserted] = await t
      .insert(dashboards)
      .values({
        orgId: viewer.orgId,
        title: input.title,
        visibility: input.visibility,
        ownerUserId: viewer.userId,
        spec: spec as unknown as Record<string, unknown>,
        createdBy: viewer.userId,
        updatedBy: viewer.userId,
      })
      .returning()
    await recordVersion(t, viewer, inserted!)
    await queueDashboardEvent(t, viewer, "created", inserted!)
    return inserted!
  })
  return toRecord(viewer, row)
}

export interface UpdateDashboardInput {
  title?: string
  visibility?: DashboardVisibility
  spec?: unknown
  /** The version the caller last read: a newer save refuses with VERSION_CONFLICT. */
  ifVersion?: number
}

export async function updateDashboard(
  viewer: DashboardViewer,
  id: string,
  input: UpdateDashboardInput,
  tx?: RlsClient,
): Promise<DashboardRecord> {
  const current = await loadRow(viewer, id, tx)
  if (!canEditDashboard(viewer, current)) {
    throw new DashboardError(
      "SCOPE_DENIED",
      current.visibility === "org"
        ? `editing an org dashboard needs ${SHARE_SCOPE} (your own) or ${ADMIN_SCOPE}`
        : "only its owner edits a personal dashboard",
    )
  }
  const visibility = input.visibility ?? current.visibility
  if (visibility !== current.visibility) {
    // Only the owner changes who sees it; to org needs share (or admin), to personal needs an owner.
    if (current.ownerUserId !== viewer.userId || !mayHold(viewer, visibility)) {
      throw new DashboardError(
        "SCOPE_DENIED",
        visibility === "org"
          ? `sharing with the org needs ${SHARE_SCOPE}`
          : "only its owner makes a dashboard personal",
      )
    }
  }
  if (input.ifVersion !== undefined && input.ifVersion !== current.version) {
    throw new DashboardError(
      "VERSION_CONFLICT",
      `the dashboard is at version ${current.version}, not ${input.ifVersion}`,
    )
  }
  const spec = input.spec === undefined ? undefined : await validateSpec(viewer, input.spec)
  const row = await inTx(viewer, tx, async (t) => {
    const [updated] = await t
      .update(dashboards)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(spec !== undefined ? { spec: spec as unknown as Record<string, unknown> } : {}),
        visibility,
        version: current.version + 1,
        updatedBy: viewer.userId,
        updatedAt: new Date(),
      })
      .where(and(eq(dashboards.id, id), eq(dashboards.version, current.version)))
      .returning()
    if (updated) {
      // The version it replaces is kept too when it predates the history (saved before it).
      await recordVersion(t, viewer, current, { ifMissing: true })
      await recordVersion(t, viewer, updated)
      await queueDashboardEvent(t, viewer, "updated", updated, current.visibility)
    }
    return updated
  })
  if (!row)
    throw new DashboardError(
      "VERSION_CONFLICT",
      "the dashboard changed while saving: read it again",
    )
  return toRecord(viewer, row)
}

export interface EditDashboardInput {
  /** The version the operations were written against: a newer save refuses with VERSION_CONFLICT. */
  ifVersion: number
  operations: EditOperation[]
}

/**
 * Applies `operations` in order to the saved dashboard and saves the result as one new
 * version, or nothing: the resulting spec is validated whole (spec.ts, and every block's
 * source for `viewer`), and an operation that cannot apply refuses the whole edit.
 */
export async function editDashboard(
  viewer: DashboardViewer,
  id: string,
  input: EditDashboardInput,
  tx?: RlsClient,
): Promise<DashboardRecord> {
  const { current, next } = await planEdit(viewer, id, input, tx)
  return updateDashboard(
    viewer,
    id,
    {
      ifVersion: input.ifVersion,
      spec: next.spec,
      ...(next.title !== current.title ? { title: next.title } : {}),
      ...(next.visibility !== current.visibility ? { visibility: next.visibility } : {}),
    },
    tx,
  )
}

/**
 * An edit checked without saving anything, before it waits for an approval: the version,
 * every operation applying in order, and the resulting spec whole (blocks, maps, and each
 * source one `viewer` may read). Throws as the save would.
 */
export async function checkEdit(
  viewer: DashboardViewer,
  id: string,
  input: EditDashboardInput,
): Promise<{ cardLines: number }> {
  const { current, next, versions } = await planEdit(viewer, id, input)
  await validateSpec(viewer, next.spec)
  // How many lines its approval card lists: a revert lists each change it restores.
  const cardLines = versions.size
    ? describeOperations(
        {
          title: current.title,
          visibility: current.visibility,
          spec: current.spec as unknown as DashboardSpec,
        },
        input.operations,
        { timeZone: await dashboardTimezone(viewer.orgId), now: new Date(), versions },
      ).length
    : cardLineCount(input.operations)
  return { cardLines }
}

async function planEdit(
  viewer: DashboardViewer,
  id: string,
  input: EditDashboardInput,
  tx?: RlsClient,
): Promise<{
  current: DashboardRow
  next: ReturnType<typeof applyOperations>
  versions: VersionLookup
}> {
  const current = await loadRow(viewer, id, tx)
  if (input.ifVersion !== current.version) {
    throw new DashboardError(
      "VERSION_CONFLICT",
      `the dashboard is at version ${current.version}, not ${input.ifVersion}: read it again`,
    )
  }
  const targets = revertTargets(input.operations)
  const versions: VersionLookup = targets.length
    ? await inTx(viewer, tx, (t) =>
        readVersions(t, id, targets, ownersDraftsHidden(viewer, current)),
      )
    : new Map()
  let next: ReturnType<typeof applyOperations>
  try {
    next = applyOperations(
      {
        title: current.title,
        visibility: current.visibility,
        spec: current.spec as unknown as DashboardSpec,
      },
      input.operations,
      versions,
    )
  } catch (err) {
    if (err instanceof EditOperationError) {
      throw new DashboardError("INVALID_SPEC", "an operation cannot apply", [err.message])
    }
    throw err
  }
  return { current, next, versions }
}

export async function deleteDashboard(
  viewer: DashboardViewer,
  id: string,
  tx?: RlsClient,
): Promise<void> {
  const current = await loadRow(viewer, id, tx)
  if (!canEditDashboard(viewer, current)) {
    throw new DashboardError(
      "SCOPE_DENIED",
      current.visibility === "org"
        ? `deleting an org dashboard needs ${SHARE_SCOPE} (your own) or ${ADMIN_SCOPE}`
        : "only its owner deletes a personal dashboard",
    )
  }
  await inTx(viewer, tx, async (t) => {
    await t.delete(dashboards).where(eq(dashboards.id, id))
    await queueDashboardEvent(t, viewer, "deleted", current)
  })
}

/** The days a block read: the dashboard range, or its own dates as tokens and what they were. */
export type BlockWindow =
  | { mode: "dashboard"; preset: TimePreset; from: string; to: string }
  | { mode: "fixed"; dates: { token: string; date: string }[] }

export interface BlockCompareWindow {
  mode: Exclude<CompareMode, "none">
  from: string
  to: string
}

export type BlockDataResponse =
  | {
      blockId: string
      ok: true
      data: BlockData
      cached: boolean
      computedAt: string
      window: BlockWindow
      compareWindow: BlockCompareWindow | null
      /** The comparison run failed: the current data stands alone. */
      previousError?: { error: BlockErrorCode; message: string }
    }
  | {
      blockId: string
      ok: false
      error: BlockErrorCode
      message: string
      window?: BlockWindow
      compareWindow?: BlockCompareWindow | null
    }

/** How long a comparison read is kept: its window is wholly in the past. */
const PAST_WINDOW_TTL_SEC = 6 * 3600

/** A source's rows as cached (sourceCacheKey). `forced`: written by a refresh. */
interface CachedSource {
  read: SourceRows
  computedAt: string
  forced?: boolean
}

/** A block's failed outcome as cached (failedBlockCacheKey). */
interface CachedFailure {
  error: BlockErrorCode
  message: string
}

type SourceReadResult =
  | { ok: true; read: SourceRows; cached: boolean; computedAt: string }
  | { ok: false; error: BlockErrorCode; message: string }

type Refusal = { ok: false; error: BlockErrorCode; message: string }

export interface BlockDataOptions {
  refresh?: boolean
  signal?: AbortSignal
  now?: Date
  /** The range the viewer shows; absent: the dashboard's default. Ignored by a fixed block. */
  range?: TimeRange
  /** The comparison the viewer shows; absent: the dashboard's default. */
  compare?: CompareMode
  /** The filter values the viewer shows, by filter id; an absent filter takes its default. */
  filters?: Record<string, string[]>
}

/** The most a source's cached rows may weigh (JSON): a larger read is used, not cached. */
const MAX_CACHED_SOURCE_BYTES = 4_000_000
/** How long a filter option source is cached. */
const OPTION_SOURCE_TTL_SEC = 300

interface LoadedDashboard {
  row: DashboardRow
  spec: DashboardSpec
}

async function loadDashboard(viewer: DashboardViewer, id: string): Promise<LoadedDashboard> {
  const row = await loadRow(viewer, id)
  return { row, spec: row.spec as unknown as DashboardSpec }
}

function findBlock(spec: DashboardSpec, blockId: string): DashboardBlock {
  const block = spec.blocks?.find((b) => b.id === blockId)
  if (!block) throw new DashboardError("NOT_FOUND", `no block '${blockId}' on this dashboard`)
  return block
}

function filterValuesFor(spec: DashboardSpec, asked: BlockDataOptions["filters"]): FilterValues {
  try {
    return normalizeFilterValues(spec, asked)
  } catch (err) {
    if (err instanceof FilterValueError) throw new DashboardError("INVALID_REQUEST", err.message)
    throw err
  }
}

/** `source` with its filter tokens resolved (dates come later). */
function withFilterValues(
  source: BlockSource,
  values: FilterValues,
  spec: Pick<DashboardSpec, "filters">,
): BlockSource {
  const value = resolveFilterTokens(sourceValue(source), values, spec)
  return source.kind === "tool" ? { ...source, params: value } : { ...source, query: value }
}

/**
 * The fields a source's consumers read, by their top-level key (the rest of a row is not kept
 * in the cache): every map field of the blocks that read it, link and drill fields, the filters
 * that list its values, plus id/name/title for a drill-down's default columns.
 */
function projectionFields(spec: DashboardSpec, sourceKey: SourceKey): Set<string> | null {
  const fields = new Set<string>(["id", "name", "title"])
  const add = (f: string | undefined) => {
    if (f) fields.add(f.split(".")[0]!)
  }
  // A layered block's layers read as blocks of their own (`blk:<block>~<layer>`, or a dataset).
  const all = runnableBlocks(spec.blocks)
  const blocks = sourceKey.startsWith("blk:")
    ? all.filter((b) => `blk:${b.id}` === sourceKey)
    : sourceKey.startsWith("ds:")
      ? all.filter((b) => b.dataset && `ds:${b.dataset}` === sourceKey)
      : []
  for (const b of blocks) {
    const m = b.map
    for (const f of [m.x, m.y, m.series, m.value, m.label, m.groupBy?.field, m.sparkline?.field])
      add(f)
    if (m.sort) add(m.sort.field)
    for (const c of [...(m.columns ?? []), ...(m.drillColumns ?? [])]) add(c.field)
    for (const w of m.where ?? []) add(w.field)
    for (const x of [...(m.measures ?? []), ...(m.stages ?? [])]) add(x.field)
    for (const f of linkFields(m.link)) add(f)
    for (const v of Object.values(m.values ?? {})) {
      if (v.dataset) continue
      add(v.field)
      for (const w of v.where ?? []) add(w.field)
    }
  }
  // Calculated values and measures of any block that read this dataset by name.
  if (sourceKey.startsWith("ds:")) {
    for (const b of all) {
      const m = b.map
      for (const v of Object.values(m.values ?? {})) {
        if (`ds:${v.dataset}` !== sourceKey) continue
        add(v.field)
        for (const w of v.where ?? []) add(w.field)
      }
      for (const x of m.measures ?? []) {
        if (`ds:${x.dataset}` !== sourceKey) continue
        add(x.field)
        add(x.categoryField ?? m.groupBy?.field ?? m.x)
      }
    }
  }
  for (const f of spec.filters ?? []) {
    const o = f.options
    if (!o || Array.isArray(o)) continue
    if ("fromDataset" in o && `ds:${o.fromDataset}` === sourceKey) add(o.field)
    if ("fromSource" in o && `opt:${f.id}` === sourceKey) add(o.field)
  }
  return fields
}

function project(read: SourceRows, fields: Set<string> | null): SourceRows {
  if (!fields || !read.rows) return read
  return {
    ...read,
    rows: read.rows.map((r) => {
      const o: Record<string, unknown> = {}
      for (const k of fields) if (k in r) o[k] = r[k]
      return o
    }),
  }
}

/** How long a source is cached: the shortest interval of the blocks that read it. */
function sourceTtlSec(spec: DashboardSpec, sourceKey: SourceKey): number {
  if (sourceKey.startsWith("opt:")) return OPTION_SOURCE_TTL_SEC
  const ttls = runnableBlocks(spec.blocks)
    .filter((b) =>
      sourceKey.startsWith("blk:") ? `blk:${b.id}` === sourceKey : `ds:${b.dataset}` === sourceKey,
    )
    .map((b) => blockTtlSec(b))
  return ttls.length ? Math.min(...ttls) : MAX_SOURCE_TTL_SEC
}

function runTargetOf(sourceKey: SourceKey): RunTarget {
  const id = sourceKey.slice(sourceKey.indexOf(":") + 1)
  if (sourceKey.startsWith("ds:")) return { datasetId: id }
  if (sourceKey.startsWith("opt:")) return { filterId: id }
  // A layer runs for its block (`<block>~<layer>`).
  return { blockId: id.split(LAYER_SEP)[0]! }
}

/**
 * One source's rows for `viewer`: from the cache, else read once (concurrent callers wait on the
 * same read) and cached. A refresh reads again, unless another refresh read it in the last
 * REFRESH_WINDOW_SEC (two blocks of one dataset refreshed together run it once).
 */
async function readSourceCached(
  viewer: DashboardViewer,
  dashboard: LoadedDashboard,
  sourceKey: SourceKey,
  source: BlockSource,
  range: DayWindow | null,
  opts: { refresh?: boolean; signal?: AbortSignal; range?: TimeRange; budgeted?: boolean },
  ttlOverride?: number,
): Promise<SourceReadResult> {
  const fields = projectionFields(dashboard.spec, sourceKey)
  const key = sourceCacheKey(viewer, {
    dashboardId: dashboard.row.id,
    sourceKey,
    resolvedSource: source,
    fields,
    range,
  })
  const failedKey = failedBlockCacheKey(key)
  const hit = await readCachedBlock<CachedSource>(key)
  if (hit) {
    const recentRefresh =
      hit.forced && Date.now() - Date.parse(hit.computedAt) < REFRESH_WINDOW_SEC * 1000
    if (!opts.refresh || recentRefresh) {
      return { ok: true, read: hit.read, cached: true, computedAt: hit.computedAt }
    }
  }
  if (!opts.refresh) {
    const failed = await readCachedBlock<CachedFailure>(failedKey)
    if (failed) return { ok: false, error: failed.error, message: failed.message }
  }
  // A custom range, or a filter value a param reads, is a new run for every new value, and a
  // read the cache could not keep (too large, or Redis down) runs again on every request: a
  // budget per source and per viewer, so walking the calendar, a filter's values or the pages
  // of a large read cannot run sources without end. Presets, the default and the default filter
  // values of a read the cache keeps never count.
  if (
    (opts.range?.preset === "custom" || opts.budgeted || (await isUncacheable(key))) &&
    !(await takeCustomWindowRun(viewer, dashboard.row.id, sourceKey))
  ) {
    return {
      ok: false,
      error: "rate_limited",
      message:
        "too many reads the cache cannot answer (custom ranges, filter values, or results too large to keep) in the last minute: try again in a minute",
    }
  }
  const ttl = ttlOverride ?? sourceTtlSec(dashboard.spec, sourceKey)
  // The shared run's own signal stops it only once every viewer waiting on it has gone.
  return singleFlight(
    `${key}${opts.refresh ? ":refresh" : ""}`,
    async (shared) => {
      const outcome = await withViewerSlot(viewer, () =>
        runSource(
          source,
          {
            viewer,
            dashboardId: dashboard.row.id,
            range,
            signal: shared,
          },
          runTargetOf(sourceKey),
        ),
      )
      if (!outcome.ok) {
        // A read every viewer abandoned says nothing about the source: never cached.
        if (!shared.aborted) {
          await writeCachedBlock(
            failedKey,
            { error: outcome.error, message: outcome.message } satisfies CachedFailure,
            Math.min(FAILED_BLOCK_TTL_SEC, ttl),
          )
        }
        return { ok: false, error: outcome.error, message: outcome.message }
      }
      const read = project(outcome.read, fields)
      const computedAt = new Date().toISOString()
      const entry: CachedSource = { read, computedAt, ...(opts.refresh ? { forced: true } : {}) }
      const json = JSON.stringify(entry)
      const kept =
        json.length <= MAX_CACHED_SOURCE_BYTES && (await writeCachedBlock(key, entry, ttl))
      if (!kept) await markUncacheable(key, ttl)
      return { ok: true, read, cached: false, computedAt }
    },
    opts.signal,
  )
}

/** A source with this request's filters and dates in, and the windows it reads. */
interface PlannedSource {
  sourceKey: SourceKey
  saved: BlockSource
  /** Filter tokens resolved, dates not yet. */
  filtered: BlockSource
  /** Fully resolved: what runs and what keys the cache. */
  resolved: BlockSource
  /** A param reads a filter value other than its default: a new run counts toward the budget. */
  budgeted: boolean
  range: DayWindow | null
  window: BlockWindow
  compareRange: BlockCompareWindow | null
  /** The org's zone: date buckets are its calendar days. */
  timeZone: string
}

/**
 * Resolves one source for a request: filter tokens, then dates (org timezone), the dashboard
 * range when it follows it. `mode` "dashboard" reads `opts.range` (else the default) and its
 * comparison. Throws DateTokenError on a token that cannot resolve.
 */
async function planSource(
  viewer: DashboardViewer,
  spec: DashboardSpec,
  sourceKey: SourceKey,
  saved: BlockSource,
  mode: BlockRangeMode,
  values: FilterValues,
  opts: BlockDataOptions,
  now: Date,
): Promise<PlannedSource> {
  const timeZone = await dashboardTimezone(viewer.orgId)
  const filtered = withFilterValues(saved, values, spec)
  let window: BlockWindow
  let range: DayWindow | null = null
  let compareRange: BlockCompareWindow | null = null
  if (mode === "dashboard") {
    const defaults = dashboardDefaultRange(spec)
    const tr = opts.range ?? defaults.timeRange
    const cmpMode = opts.compare ?? defaults.compare
    range = resolveTimeRange(tr, { timeZone, now })
    window = { mode: "dashboard", preset: tr.preset, ...range }
    const cmp = compareWindow(tr.preset, range, cmpMode)
    if (cmp && cmpMode !== "none") compareRange = { mode: cmpMode, ...cmp }
  } else {
    window = {
      mode: "fixed",
      dates: dateTokensIn(sourceValue(saved)).map((token) => ({
        token,
        date: resolveDateTokens(token, { timeZone, now }),
      })),
    }
  }
  const resolved = await resolveSourceDates(filtered, viewer.orgId, now, range)
  const defaults = defaultFilterValues(spec)
  const budgeted = filterTokensIn(sourceValue(saved)).some(
    (id) => JSON.stringify(values[id] ?? []) !== JSON.stringify(defaults[id] ?? []),
  )
  return { sourceKey, saved, filtered, resolved, budgeted, range, window, compareRange, timeZone }
}

/**
 * The rows of the other shared datasets a block's calculated values or measures read, for the
 * current window or the comparison one, each read as the viewer through the same cache as any
 * dataset (one run shared with the blocks that read it). A refusal of one refuses the block.
 */
async function readCalcDatasets(
  viewer: DashboardViewer,
  dashboard: LoadedDashboard,
  block: DashboardBlock,
  values: FilterValues,
  opts: BlockDataOptions,
  now: Date,
  which: "current" | "previous",
): Promise<{ ok: true; rows: Record<string, Record<string, unknown>[] | null> } | Refusal> {
  const rows: Record<string, Record<string, unknown>[] | null> = {}
  for (const id of calcDatasets(block)) {
    const saved = dashboard.spec.datasets?.[id]
    if (!saved) return { ok: false, error: "invalid_map", message: `no dataset '${id}'` }
    const mode = hasRangeTokens(sourceValue(saved)) ? "dashboard" : "fixed"
    let plan: PlannedSource
    try {
      plan = await planSource(viewer, dashboard.spec, `ds:${id}`, saved, mode, values, opts, now)
    } catch (err) {
      if (!(err instanceof DateTokenError)) throw err
      return { ok: false, error: "invalid_map", message: err.message }
    }
    const refused = await sourceRefusal(viewer, plan.resolved)
    if (refused) return refused
    let source = plan.resolved
    let range = plan.range
    if (which === "previous" && plan.compareRange) {
      source = await resolveSourceDates(plan.filtered, viewer.orgId, now, plan.compareRange)
      range = plan.compareRange
    }
    const read = await readSourceCached(
      viewer,
      dashboard,
      `ds:${id}`,
      source,
      range,
      { ...opts, ...(which === "previous" ? { refresh: false } : {}), budgeted: plan.budgeted },
      which === "previous" ? PAST_WINDOW_TTL_SEC : undefined,
    )
    if (!read.ok) return read
    rows[id] = read.read.rows
  }
  return { ok: true, rows }
}

/** Eligibility, every time: a tool turned gated or an app turned off after the save refuses. */
async function sourceRefusal(
  viewer: DashboardViewer,
  source: BlockSource,
): Promise<Refusal | null> {
  const check =
    source.kind === "tool"
      ? await checkToolSource(viewer.orgId, source.tool, viewer)
      : await checkStoreSource(viewer.orgId, source.app, source.collection, viewer)
  return check.ok ? null : { ok: false, error: check.code, message: check.message }
}

/** The block's source and how it is keyed: its own, or its dataset's (shared). */
function blockSourcePlan(
  spec: DashboardSpec,
  block: DashboardBlock,
): { sourceKey: SourceKey; saved: BlockSource } | null {
  const saved = blockSourceOf(block, spec.datasets)
  if (!saved) return null
  return { sourceKey: block.dataset ? `ds:${block.dataset}` : `blk:${block.id}`, saved }
}

/**
 * One block's data for `viewer`. Its source (its own or a shared dataset) is read from the
 * cache (per viewer, per permissions, per dashboard version, per resolved params and range),
 * else run as the viewer, once for every block that shares it; the block's map (where
 * included) is applied on every request. `refresh` reads the source again, at most once per
 * block per viewer per 30 s (`rate_limited` otherwise).
 *
 * A block that follows the dashboard range reads `opts.range` (else the dashboard's default)
 * and, unless the comparison is "none", its source once more over the comparison window (its
 * own cache entry): the data carries `previous`. A fixed block reads its own dates and is never
 * compared. A text block reads nothing.
 */
export async function getBlockData(
  viewer: DashboardViewer,
  dashboardId: string,
  blockId: string,
  opts: BlockDataOptions = {},
): Promise<BlockDataResponse> {
  const dashboard = await loadDashboard(viewer, dashboardId)
  const { spec } = dashboard
  const block = findBlock(spec, blockId)
  const values = filterValuesFor(spec, opts.filters)
  const now = opts.now ?? new Date()

  if (block.type === "text") {
    const out = mapBlock(block, { rows: [], object: null, totalRows: 0 }, {})
    if (!out.ok) return { ...out, blockId }
    return {
      blockId,
      ok: true,
      data: out.data,
      cached: false,
      computedAt: now.toISOString(),
      window: { mode: "fixed", dates: [] },
      compareWindow: null,
    }
  }
  if (block.layers) return layeredBlockData(viewer, dashboard, block, values, opts, now)
  return runBlockData(viewer, dashboard, block, values, opts, now, true)
}

/**
 * A layered (blended) block: each layer runs as a block of its own (its source, cache, budget,
 * eligibility, filters and comparison), one refresh limit for the whole block, then the layers
 * are joined on their date buckets (transform.ts mergeLayers). A failed layer shows on its own;
 * every layer failed refuses the block with the first one's reason.
 */
async function layeredBlockData(
  viewer: DashboardViewer,
  dashboard: LoadedDashboard,
  block: DashboardBlock,
  values: FilterValues,
  opts: BlockDataOptions,
  now: Date,
): Promise<BlockDataResponse> {
  const blockId = block.id
  if (opts.refresh && !(await takeRefresh(viewer, dashboard.row.id, blockId))) {
    return {
      blockId,
      ok: false,
      error: "rate_limited",
      message: "this block was refreshed less than 30 seconds ago",
    }
  }
  const layers = block.layers ?? []
  const outs = await Promise.all(
    layerBlocks(block).map((lb) => runBlockData(viewer, dashboard, lb, values, opts, now, false)),
  )
  const okOuts = outs.filter((o): o is Extract<BlockDataResponse, { ok: true }> => o.ok)
  if (okOuts.length === 0) {
    const first = outs[0] as Extract<BlockDataResponse, { ok: false }>
    const layer = layers[0]
    return {
      ...first,
      blockId,
      message: `layer '${layer?.id ?? ""}': ${first.message}`,
    }
  }
  const data = mergeLayers(
    layers.map((layer, i) => {
      const o = outs[i]!
      return o.ok
        ? { layer, data: o.data, ...(o.previousError ? { previousError: o.previousError } : {}) }
        : { layer, error: { error: o.error, message: o.message } }
    }),
    block.map,
  )
  const lead = okOuts.find((o) => o.window.mode === "dashboard") ?? okOuts[0]!
  return {
    blockId,
    ok: true,
    data,
    cached: okOuts.every((o) => o.cached),
    computedAt: okOuts.map((o) => o.computedAt).sort()[0]!,
    window: lead.window,
    compareWindow: lead.compareWindow,
  }
}

/**
 * One block's (or one layer's) data: its source read through the cache, mapped, compared.
 * `checkRefresh`: this run holds the block's refresh limit (a layer's block took it already).
 */
async function runBlockData(
  viewer: DashboardViewer,
  dashboard: LoadedDashboard,
  block: DashboardBlock,
  values: FilterValues,
  opts: BlockDataOptions,
  now: Date,
  checkRefresh: boolean,
): Promise<BlockDataResponse> {
  const { spec } = dashboard
  const blockId = block.id
  const dashboardId = dashboard.row.id
  const sp = blockSourcePlan(spec, block)
  if (!sp) {
    return { blockId, ok: false, error: "invalid_map", message: `no dataset '${block.dataset}'` }
  }
  let plan: PlannedSource
  try {
    plan = await planSource(
      viewer,
      spec,
      sp.sourceKey,
      sp.saved,
      blockRangeMode(block, spec.datasets),
      values,
      opts,
      now,
    )
  } catch (err) {
    if (!(err instanceof DateTokenError)) throw err
    return { blockId, ok: false, error: "invalid_map", message: err.message }
  }
  const { window, compareRange, range } = plan
  const refused = await sourceRefusal(viewer, plan.resolved)
  if (refused) return { ...refused, blockId, window, compareWindow: compareRange }

  if (checkRefresh && opts.refresh && !(await takeRefresh(viewer, dashboardId, blockId))) {
    return {
      blockId,
      ok: false,
      error: "rate_limited",
      message: "this block was refreshed less than 30 seconds ago",
      window,
      compareWindow: compareRange,
    }
  }

  const where = resolveWhere(block.map.where, values)
  const linkApp = sourceApp(plan.resolved)
  const mapOpts: Parameters<typeof mapBlock>[2] = {
    window: range,
    where,
    timeZone: plan.timeZone,
    today: dayIn(plan.timeZone, now),
    ...(linkApp ? { linkApp } : {}),
  }
  const current = await readSourceCached(viewer, dashboard, plan.sourceKey, plan.resolved, range, {
    ...opts,
    budgeted: plan.budgeted,
  })
  if (!current.ok) return { ...current, blockId, window, compareWindow: compareRange }
  const extra = calcDatasets(block).length
    ? await readCalcDatasets(viewer, dashboard, block, values, opts, now, "current")
    : null
  if (extra && !extra.ok) return { ...extra, blockId, window, compareWindow: compareRange }
  if (extra) Object.assign(mapOpts, { datasetRows: extra.rows })
  const mapped = mapBlock(block, current.read, mapOpts)
  if (!mapped.ok) return { ...mapped, blockId, window, compareWindow: compareRange }
  let data = mapped.data
  let previousError: { error: BlockErrorCode; message: string } | undefined
  if (compareRange && range) {
    // The comparison: the same source over the comparison window, one more read (cached apart).
    let previousSource: BlockSource | null = null
    try {
      previousSource = await resolveSourceDates(plan.filtered, viewer.orgId, now, compareRange)
    } catch (err) {
      if (!(err instanceof DateTokenError)) throw err
      previousError = { error: "invalid_map", message: err.message }
    }
    if (previousSource) {
      // A past window rarely changes: kept for hours, and Refresh re-reads only the current one.
      const previous = await readSourceCached(
        viewer,
        dashboard,
        plan.sourceKey,
        previousSource,
        compareRange,
        { ...opts, refresh: false, budgeted: plan.budgeted },
        PAST_WINDOW_TTL_SEC,
      )
      const prevExtra =
        previous.ok && extra
          ? await readCalcDatasets(viewer, dashboard, block, values, opts, now, "previous")
          : null
      const prevMapped = !previous.ok
        ? previous
        : prevExtra && !prevExtra.ok
          ? prevExtra
          : mapBlock(block, previous.read, {
              ...mapOpts,
              window: compareRange,
              ...(prevExtra?.ok ? { datasetRows: prevExtra.rows } : {}),
            })
      if (prevMapped.ok) {
        data = attachPrevious(data, prevMapped.data, {
          ...(block.map.groupBy?.bucket ? { bucket: block.map.groupBy.bucket } : {}),
          window: range,
          compareWindow: compareRange,
        })
      } else {
        previousError = { error: prevMapped.error, message: prevMapped.message }
      }
    }
  }
  return {
    blockId,
    ok: true,
    data,
    cached: current.cached,
    computedAt: current.computedAt,
    window,
    compareWindow: compareRange,
    ...(previousError ? { previousError } : {}),
  }
}

// ── drill-down: the rows behind a figure ────────────────────────────────────

export const DRILL_DEFAULT_LIMIT = 50
export const DRILL_MAX_LIMIT = 200
/** A CSV export of the rows takes every row read (`exportAll`). */
export const DRILL_EXPORT_LIMIT = MAX_SOURCE_ROWS

export interface BlockRowsOptions extends Omit<BlockDataOptions, "refresh" | "compare"> {
  /** A chart's category label (a bar, a slice, a point, a funnel stage). */
  category?: string
  /** A split series' name. */
  series?: string
  /** A table row's index in the block's data rows. */
  row?: number
  /** A layered block: the layer whose rows to read (required there). */
  layer?: string
  offset?: number
  limit?: number
  /** A CSV export: the limit may reach every row read (DRILL_EXPORT_LIMIT). */
  exportAll?: boolean
}

type DrillColumn = { field: string; label: string; format?: BlockMap["format"] }
type BlockMap = DashboardBlock["map"]

export type BlockRowsResponse =
  | {
      blockId: string
      ok: true
      columns: DrillColumn[]
      rows: Record<string, string | number | boolean | null>[]
      links: (RecordLink | null)[] | null
      total: number
      offset: number
      limit: number
      nextOffset: number | null
      truncated: boolean
      cached: boolean
      computedAt: string
      window: BlockWindow
    }
  | { blockId: string; ok: false; error: BlockErrorCode; message: string; window?: BlockWindow }

/** What a drill-down shows per row: drillColumns, a table's columns, else the fields it uses. */
function drillColumnsOf(
  block: DashboardBlock,
  sample: Record<string, unknown> | undefined,
): DrillColumn[] {
  const m = block.map
  if (m.drillColumns) return m.drillColumns
  if (m.columns) return m.columns
  const fields: string[] = []
  const add = (f: string | undefined) => {
    if (f && !fields.includes(f)) fields.push(f)
  }
  for (const f of ["name", "title", "id"]) if (sample && f in sample) add(f)
  if (block.type !== "metric" && !m.stages) add(categoryField(block.type, m))
  add(m.series)
  for (const f of [m.value, m.y, m.sparkline?.field]) add(f)
  for (const x of [...(m.measures ?? []), ...(m.stages ?? [])]) add(x.field)
  if (fields.length === 0 && sample) for (const k of Object.keys(sample).slice(0, 8)) add(k)
  return fields.slice(0, 20).map((field) => ({ field, label: field }))
}

/**
 * The rows behind one figure of a block: a chart's category (and series), a table's row, or
 * every row a metric or a funnel of stages aggregates; read-only, from the same cached source
 * read as the block's data (no run when it is cached), under the same access as the block.
 */
export async function getBlockRows(
  viewer: DashboardViewer,
  dashboardId: string,
  blockId: string,
  opts: BlockRowsOptions = {},
): Promise<BlockRowsResponse> {
  const dashboard = await loadDashboard(viewer, dashboardId)
  const { spec } = dashboard
  let block = findBlock(spec, blockId)
  if (block.type === "text") {
    throw new DashboardError("INVALID_REQUEST", "a text block has no rows")
  }
  if (block.layers) {
    // A layered block's rows are one layer's: that layer read as a block of its own.
    const i = block.layers.findIndex((l) => l.id === opts.layer)
    if (i < 0) {
      throw new DashboardError(
        "INVALID_REQUEST",
        `a layered block's rows are one layer's: give layer (${block.layers.map((l) => l.id).join(", ")})`,
      )
    }
    block = layerBlocks(block)[i]!
  } else if (opts.layer !== undefined) {
    throw new DashboardError("INVALID_REQUEST", "this block has no layers")
  }
  const values = filterValuesFor(spec, opts.filters)
  const now = opts.now ?? new Date()
  const sp = blockSourcePlan(spec, block)
  if (!sp) {
    return { blockId, ok: false, error: "invalid_map", message: `no dataset '${block.dataset}'` }
  }
  let plan: PlannedSource
  try {
    plan = await planSource(
      viewer,
      spec,
      sp.sourceKey,
      sp.saved,
      blockRangeMode(block, spec.datasets),
      values,
      opts,
      now,
    )
  } catch (err) {
    if (!(err instanceof DateTokenError)) throw err
    return { blockId, ok: false, error: "invalid_map", message: err.message }
  }
  const { window, range } = plan
  const refused = await sourceRefusal(viewer, plan.resolved)
  if (refused) return { ...refused, blockId, window }
  const read = await readSourceCached(viewer, dashboard, plan.sourceKey, plan.resolved, range, {
    budgeted: plan.budgeted,
    ...(opts.range ? { range: opts.range } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!read.ok) return { ...read, blockId, window }

  let rows: Record<string, unknown>[]
  let truncated: boolean
  try {
    const got = blockRows(read.read.rows ?? read.read.object, {
      totalRows: read.read.totalRows,
      where: resolveWhere(block.map.where, values),
    })
    if (!got.rows) {
      return {
        blockId,
        ok: false,
        error: "invalid_map",
        message: "the source returned one object: there are no rows to show",
        window,
      }
    }
    rows = got.rows
    truncated = got.meta.truncated
  } catch (err) {
    if (err instanceof TransformError) {
      return { blockId, ok: false, error: "invalid_map", message: err.message, window }
    }
    throw err
  }

  const m = block.map
  if (block.type === "table") {
    const ordered = sortedTableRows(rows, m).slice(0, m.limit ?? 100)
    if (opts.row !== undefined) {
      const one = ordered[opts.row]
      if (!one) throw new DashboardError("INVALID_REQUEST", `no row ${opts.row} in this block`)
      rows = [one]
    } else rows = ordered
  } else if (opts.row !== undefined) {
    throw new DashboardError("INVALID_REQUEST", "row is for a table block; a chart takes category")
  } else if (opts.category !== undefined && block.type !== "metric" && !m.stages) {
    const field = categoryField(block.type, m)
    const bucket = m.groupBy?.bucket
    const want = opts.category === "" ? NONE_LABEL : opts.category
    rows = rows.filter((r) => categoryOf(r, field, bucket, plan.timeZone) === want)
  }
  if (opts.series !== undefined && m.series && !m.measures) {
    const field = m.series
    rows = rows.filter((r) => seriesNameOf(r, field) === opts.series)
  }

  const columns = drillColumnsOf(block, read.read.rows?.[0])
  const offset = Math.max(0, opts.offset ?? 0)
  const limit = Math.min(
    Math.max(1, opts.limit ?? DRILL_DEFAULT_LIMIT),
    opts.exportAll ? DRILL_EXPORT_LIMIT : DRILL_MAX_LIMIT,
  )
  const page = rows.slice(offset, offset + limit)
  const linkApp = sourceApp(plan.resolved)
  return {
    blockId,
    ok: true,
    columns,
    rows: page.map((r) => projectRow(r, columns)),
    links: m.link ? page.map((r) => recordLink(r, m.link, linkApp)) : null,
    total: rows.length,
    offset,
    limit,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
    truncated,
    cached: read.cached,
    computedAt: read.computedAt,
    window,
  }
}

// ── a filter's options ─────────────────────────────────────────────────────

export const MAX_OPTION_VALUES = 200

export type FilterOptionsResponse =
  | { filterId: string; ok: true; options: string[]; truncated: boolean }
  | { filterId: string; ok: false; error: BlockErrorCode; message: string }

/**
 * The values a filter offers: its static list, or the distinct non-empty values of a field over
 * a dataset's (or its own source's) rows, read as the viewer, the filter's own value left out
 * (so its options never narrow to the value already picked). Sorted, at most MAX_OPTION_VALUES.
 */
export async function getFilterOptions(
  viewer: DashboardViewer,
  dashboardId: string,
  filterId: string,
  opts: Omit<BlockDataOptions, "refresh" | "compare"> & { q?: string } = {},
): Promise<FilterOptionsResponse> {
  const dashboard = await loadDashboard(viewer, dashboardId)
  const { spec } = dashboard
  const def = spec.filters?.find((f) => f.id === filterId)
  if (!def) throw new DashboardError("NOT_FOUND", `no filter '${filterId}' on this dashboard`)
  if (def.type === "text" || !def.options) {
    throw new DashboardError("INVALID_REQUEST", "a text filter has no options")
  }
  const q = opts.q?.trim().toLowerCase()
  const finish = (all: string[]): FilterOptionsResponse => {
    const matching = q ? all.filter((v) => v.toLowerCase().includes(q)) : all
    return {
      filterId,
      ok: true,
      options: matching.slice(0, MAX_OPTION_VALUES),
      truncated: matching.length > MAX_OPTION_VALUES,
    }
  }
  if (Array.isArray(def.options)) return finish(def.options)

  const values = { ...filterValuesFor(spec, opts.filters), [filterId]: [] }
  const o = def.options
  let sourceKey: SourceKey
  let saved: BlockSource | undefined
  if ("fromDataset" in o) {
    sourceKey = `ds:${o.fromDataset}`
    saved = spec.datasets?.[o.fromDataset]
  } else {
    sourceKey = `opt:${filterId}`
    saved = o.fromSource
  }
  if (!saved) {
    return { filterId, ok: false, error: "invalid_map", message: "the filter's dataset is gone" }
  }
  let plan: PlannedSource
  try {
    const mode = hasRangeTokens(sourceValue(saved)) ? "dashboard" : "fixed"
    plan = await planSource(
      viewer,
      spec,
      sourceKey,
      saved,
      mode,
      values,
      opts,
      opts.now ?? new Date(),
    )
  } catch (err) {
    if (!(err instanceof DateTokenError)) throw err
    return { filterId, ok: false, error: "invalid_map", message: err.message }
  }
  const refused = await sourceRefusal(viewer, plan.resolved)
  if (refused) return { ...refused, filterId }
  const read = await readSourceCached(viewer, dashboard, sourceKey, plan.resolved, plan.range, {
    budgeted: plan.budgeted,
    ...(opts.range ? { range: opts.range } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!read.ok) return { ...read, filterId }
  const seen = new Set<string>()
  for (const r of read.read.rows ?? []) {
    const v = readPath(r, o.field)
    for (const x of Array.isArray(v) ? v : [v]) {
      if (x === null || x === undefined || x === "" || typeof x === "object") continue
      const sx = String(x)
      if (sx.length <= 200) seen.add(sx)
    }
  }
  return finish([...seen].sort((a, b) => a.localeCompare(b)))
}
