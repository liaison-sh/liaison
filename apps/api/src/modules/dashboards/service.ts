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

import { and, desc, eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { type DashboardRow, dashboards, dashboardViewerStates, users } from "~/db/schema/kernel"
import {
  blockCacheKey,
  FAILED_BLOCK_TTL_SEC,
  failedBlockCacheKey,
  readCachedBlock,
  takeRefresh,
  withViewerSlot,
  writeCachedBlock,
} from "~/modules/dashboards/cache"
import { applyOperations, type EditOperation, EditOperationError } from "~/modules/dashboards/edit"
import {
  type BlockErrorCode,
  computeBlock,
  dashboardTimezone,
  resolveBlockDates,
} from "~/modules/dashboards/execute"
import {
  type CompareMode,
  compareWindow,
  DateTokenError,
  type DayWindow,
  dateTokensIn,
  resolveDateTokens,
  resolveTimeRange,
  type TimePreset,
  type TimeRange,
} from "~/modules/dashboards/relative-dates"
import { checkStoreSource, checkToolSource } from "~/modules/dashboards/sources"
import {
  type BlockRangeMode,
  blockRangeMode,
  blockTtlSec,
  type DashboardSpec,
  dashboardDefaultRange,
  dashboardSpecSchema,
  specIssues,
  timeRangeSchema,
} from "~/modules/dashboards/spec"
import { attachPrevious, type BlockData } from "~/modules/dashboards/transform"
import { hasScope } from "~/modules/permissions/permissions"

export type DashboardVisibility = "personal" | "org"

export type DashboardErrorCode = "NOT_FOUND" | "SCOPE_DENIED" | "INVALID_SPEC" | "VERSION_CONFLICT"

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
  for (const [i, block] of parsed.data.blocks.entries()) {
    const check =
      block.source.kind === "tool"
        ? await checkToolSource(author.orgId, block.source.tool, author)
        : await checkStoreSource(author.orgId, block.source.app, block.source.collection, author)
    if (!check.ok) problems.push(`blocks.${i} (${block.id}): ${check.code}: ${check.message}`)
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
}

/** A remembered range read back: a row another release wrote in a shape this one refuses is ignored. */
function parseViewerState(
  row: { timeRange: unknown; compare: string } | undefined,
): { timeRange: TimeRange; compare: CompareMode } | null {
  if (!row) return null
  const tr = timeRangeSchema.safeParse(row.timeRange)
  const compare = ["lastYear", "previousPeriod", "none"].includes(row.compare)
    ? (row.compare as CompareMode)
    : null
  return tr.success && compare ? { timeRange: tr.data, compare } : null
}

export async function getDashboard(
  viewer: DashboardViewer,
  id: string,
  tx?: RlsClient,
  now: Date = new Date(),
): Promise<DashboardView> {
  const { row, state } = await inTx(viewer, tx, async (t) => {
    const [found] = await t.select().from(dashboards).where(eq(dashboards.id, id)).limit(1)
    if (!found) throw new DashboardError("NOT_FOUND", "no such dashboard")
    const [saved] = await t
      .select({
        timeRange: dashboardViewerStates.timeRange,
        compare: dashboardViewerStates.compare,
      })
      .from(dashboardViewerStates)
      .where(
        and(
          eq(dashboardViewerStates.dashboardId, id),
          eq(dashboardViewerStates.userId, viewer.userId),
        ),
      )
      .limit(1)
    return { row: found, state: parseViewerState(saved) }
  })
  const record = toRecord(viewer, row)
  const spec = record.spec
  const defaults = dashboardDefaultRange(spec ?? {})
  const chosen = state ?? defaults
  const timeZone = await dashboardTimezone(viewer.orgId)
  const window = resolveTimeRange(chosen.timeRange, { timeZone, now })
  const blockTimeRange: Record<string, BlockRangeMode> = {}
  for (const b of spec?.blocks ?? []) {
    // A saved block of a shape this release does not know reads as fixed.
    try {
      blockTimeRange[b.id] = blockRangeMode(b)
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
  }
}

// ── a person's remembered range ─────────────────────────────────────────────

export interface ViewerRange {
  timeRange: TimeRange
  compare: CompareMode
}

/** The range `viewer` last chose on this dashboard, or null. NOT_FOUND when they cannot see it. */
export async function getViewerRange(
  viewer: DashboardViewer,
  dashboardId: string,
): Promise<ViewerRange | null> {
  return withRlsContext(viewer, async (t) => {
    await loadRow(viewer, dashboardId, t)
    const [row] = await t
      .select({
        timeRange: dashboardViewerStates.timeRange,
        compare: dashboardViewerStates.compare,
      })
      .from(dashboardViewerStates)
      .where(
        and(
          eq(dashboardViewerStates.dashboardId, dashboardId),
          eq(dashboardViewerStates.userId, viewer.userId),
        ),
      )
      .limit(1)
    return parseViewerState(row)
  })
}

/** Remembers `range` as this person's choice on this dashboard (only they ever read it). */
export async function setViewerRange(
  viewer: DashboardViewer,
  dashboardId: string,
  range: ViewerRange,
): Promise<ViewerRange> {
  const parsed = timeRangeSchema.safeParse(range.timeRange)
  if (!parsed.success) {
    throw new DashboardError(
      "INVALID_SPEC",
      "the time range is not valid",
      specIssues(parsed.error),
    )
  }
  const timeRange = parsed.data
  await withRlsContext(viewer, async (t) => {
    await loadRow(viewer, dashboardId, t)
    await t
      .insert(dashboardViewerStates)
      .values({
        orgId: viewer.orgId,
        dashboardId,
        userId: viewer.userId,
        timeRange: timeRange as unknown as Record<string, unknown>,
        compare: range.compare,
      })
      .onConflictDoUpdate({
        target: [dashboardViewerStates.dashboardId, dashboardViewerStates.userId],
        set: {
          timeRange: timeRange as unknown as Record<string, unknown>,
          compare: range.compare,
          updatedAt: new Date(),
        },
      })
  })
  return { timeRange, compare: range.compare }
}

/** Forgets this person's choice: the dashboard opens on its default again. */
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
    if (updated) await queueDashboardEvent(t, viewer, "updated", updated, current.visibility)
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
  const current = await loadRow(viewer, id, tx)
  if (input.ifVersion !== current.version) {
    throw new DashboardError(
      "VERSION_CONFLICT",
      `the dashboard is at version ${current.version}, not ${input.ifVersion}: read it again`,
    )
  }
  let next: ReturnType<typeof applyOperations>
  try {
    next = applyOperations(
      {
        title: current.title,
        visibility: current.visibility,
        spec: current.spec as unknown as DashboardSpec,
      },
      input.operations,
    )
  } catch (err) {
    if (err instanceof EditOperationError) {
      throw new DashboardError("INVALID_SPEC", "an operation cannot apply", [err.message])
    }
    throw err
  }
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

interface CachedBlock {
  data: BlockData
  computedAt: string
}

/** A block's failed outcome as cached (failedBlockCacheKey). */
interface CachedFailure {
  error: BlockErrorCode
  message: string
}

type BlockRunResult =
  | { ok: true; data: BlockData; cached: boolean; computedAt: string }
  | { ok: false; error: BlockErrorCode; message: string }

export interface BlockDataOptions {
  refresh?: boolean
  signal?: AbortSignal
  now?: Date
  /** The range the viewer shows; absent: the dashboard's default. Ignored by a fixed block. */
  range?: TimeRange
  /** The comparison the viewer shows; absent: the dashboard's default. */
  compare?: CompareMode
}

/**
 * One block's data for `viewer`: from the cache (per viewer, per permissions,
 * per dashboard version, per resolved dates and range), else run as the viewer. `refresh`
 * bypasses the cache, at most once per block per viewer per 30 s (`rate_limited` otherwise).
 *
 * A block that follows the dashboard range reads `opts.range` (else the dashboard's
 * default) and, unless the comparison is "none", runs once more over the comparison window
 * (its own cache entry): the data carries `previous` beside the current values. A fixed
 * block reads its own dates and is never compared.
 */
export async function getBlockData(
  viewer: DashboardViewer,
  dashboardId: string,
  blockId: string,
  opts: BlockDataOptions = {},
): Promise<BlockDataResponse> {
  const dashboard = await loadRow(viewer, dashboardId)
  const spec = dashboard.spec as unknown as DashboardSpec
  const saved = spec.blocks?.find((b) => b.id === blockId)
  if (!saved) throw new DashboardError("NOT_FOUND", `no block '${blockId}' on this dashboard`)
  const now = opts.now ?? new Date()

  // Date tokens become this run's dates (org timezone) before anything else: the cache key and
  // the run below both see them. A range block's {{range.*}} become the chosen window.
  let block: typeof saved
  let window: BlockWindow
  let range: DayWindow | null = null
  let compareRange: BlockCompareWindow | null = null
  try {
    const timeZone = await dashboardTimezone(viewer.orgId)
    if (blockRangeMode(saved) === "dashboard") {
      const defaults = dashboardDefaultRange(spec)
      const tr = opts.range ?? defaults.timeRange
      const mode = opts.compare ?? defaults.compare
      range = resolveTimeRange(tr, { timeZone, now })
      window = { mode: "dashboard", preset: tr.preset, ...range }
      const cmp = compareWindow(tr.preset, range, mode)
      if (cmp && mode !== "none") compareRange = { mode, ...cmp }
    } else {
      const value = saved.source.kind === "tool" ? saved.source.params : saved.source.query
      window = {
        mode: "fixed",
        dates: dateTokensIn(value).map((token) => ({
          token,
          date: resolveDateTokens(token, { timeZone, now }),
        })),
      }
    }
    block = await resolveBlockDates(saved, viewer.orgId, now, range)
  } catch (err) {
    if (!(err instanceof DateTokenError)) throw err
    return { blockId, ok: false, error: "invalid_map", message: err.message }
  }

  // Eligibility first, every time: a tool turned gated or an app turned off after the
  // save refuses even while an older answer is still cached.
  const check =
    block.source.kind === "tool"
      ? await checkToolSource(viewer.orgId, block.source.tool, viewer)
      : await checkStoreSource(viewer.orgId, block.source.app, block.source.collection, viewer)
  if (!check.ok) {
    return {
      blockId,
      ok: false,
      error: check.code,
      message: check.message,
      window,
      compareWindow: compareRange,
    }
  }

  if (opts.refresh && !(await takeRefresh(viewer, dashboardId, blockId))) {
    return {
      blockId,
      ok: false,
      error: "rate_limited",
      message: "this block was refreshed less than 30 seconds ago",
      window,
      compareWindow: compareRange,
    }
  }

  const current = await runBlockCached(viewer, dashboard, block, range, opts)
  if (!current.ok) {
    return { ...current, blockId, window, compareWindow: compareRange }
  }
  let data = current.data
  let previousError: { error: BlockErrorCode; message: string } | undefined
  if (compareRange && range) {
    // The comparison: the saved block over the comparison window, one more run (cached apart).
    let previousBlock: typeof saved | null = null
    try {
      previousBlock = await resolveBlockDates(saved, viewer.orgId, now, compareRange)
    } catch (err) {
      if (!(err instanceof DateTokenError)) throw err
      previousError = { error: "invalid_map", message: err.message }
    }
    if (previousBlock) {
      const previous = await runBlockCached(viewer, dashboard, previousBlock, compareRange, opts)
      if (previous.ok) {
        data = attachPrevious(data, previous.data, {
          ...(saved.map.groupBy?.bucket ? { bucket: saved.map.groupBy.bucket } : {}),
          window: range,
          compareWindow: compareRange,
        })
      } else {
        previousError = { error: previous.error, message: previous.message }
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

/** One run of a block whose dates are resolved: from the cache, else computed and cached. */
async function runBlockCached(
  viewer: DashboardViewer,
  dashboard: DashboardRow,
  block: DashboardSpec["blocks"][number],
  range: DayWindow | null,
  opts: BlockDataOptions,
): Promise<BlockRunResult> {
  const key = blockCacheKey(viewer, {
    dashboardId: dashboard.id,
    version: dashboard.version,
    blockId: block.id,
    resolvedSource: block.source,
    range,
  })
  const failedKey = failedBlockCacheKey(key)
  if (!opts.refresh) {
    const hit = await readCachedBlock<CachedBlock>(key)
    if (hit) return { ok: true, data: hit.data, cached: true, computedAt: hit.computedAt }
    const failed = await readCachedBlock<CachedFailure>(failedKey)
    if (failed) return { ok: false, error: failed.error, message: failed.message }
  }
  const outcome = await withViewerSlot(viewer, () =>
    computeBlock(block, {
      viewer,
      dashboardId: dashboard.id,
      range,
      ...(opts.signal ? { signal: opts.signal } : {}),
    }),
  )
  if (!outcome.ok) {
    // A read the viewer abandoned says nothing about the source: never cached.
    if (!opts.signal?.aborted) {
      await writeCachedBlock(
        failedKey,
        { error: outcome.error, message: outcome.message } satisfies CachedFailure,
        Math.min(FAILED_BLOCK_TTL_SEC, blockTtlSec(block)),
      )
    }
    return { ok: false, error: outcome.error, message: outcome.message }
  }
  const computedAt = new Date().toISOString()
  await writeCachedBlock(
    key,
    { data: outcome.data, computedAt } satisfies CachedBlock,
    blockTtlSec(block),
  )
  return { ok: true, data: outcome.data, cached: false, computedAt }
}
