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
import { type DashboardRow, dashboards } from "~/db/schema/kernel"
import {
  blockCacheKey,
  readCachedBlock,
  takeRefresh,
  withViewerSlot,
  writeCachedBlock,
} from "~/modules/dashboards/cache"
import { type BlockErrorCode, computeBlock } from "~/modules/dashboards/execute"
import { checkStoreSource, checkToolSource } from "~/modules/dashboards/sources"
import {
  blockTtlSec,
  type DashboardSpec,
  dashboardSpecSchema,
  specIssues,
} from "~/modules/dashboards/spec"
import type { BlockData } from "~/modules/dashboards/transform"
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
    t.select().from(dashboards).orderBy(desc(dashboards.updatedAt)).limit(200),
  )
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    visibility: r.visibility,
    ownerUserId: r.ownerUserId,
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

export async function getDashboard(
  viewer: DashboardViewer,
  id: string,
  tx?: RlsClient,
): Promise<DashboardRecord> {
  return toRecord(viewer, await loadRow(viewer, id, tx))
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
  const [row] = await inTx(viewer, tx, (t) =>
    t
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
      .returning(),
  )
  return toRecord(viewer, row!)
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
  const [row] = await inTx(viewer, tx, (t) =>
    t
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
      .returning(),
  )
  if (!row)
    throw new DashboardError(
      "VERSION_CONFLICT",
      "the dashboard changed while saving: read it again",
    )
  return toRecord(viewer, row)
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
  await inTx(viewer, tx, (t) => t.delete(dashboards).where(eq(dashboards.id, id)))
}

export type BlockDataResponse =
  | { blockId: string; ok: true; data: BlockData; cached: boolean; computedAt: string }
  | { blockId: string; ok: false; error: BlockErrorCode; message: string }

interface CachedBlock {
  data: BlockData
  computedAt: string
}

/**
 * One block's data for `viewer`: from the cache (per viewer, per permissions,
 * per dashboard version), else run as the viewer. `refresh` bypasses the cache,
 * at most once per block per viewer per 30 s (`rate_limited` otherwise).
 */
export async function getBlockData(
  viewer: DashboardViewer,
  dashboardId: string,
  blockId: string,
  opts: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<BlockDataResponse> {
  const dashboard = await loadRow(viewer, dashboardId)
  const spec = dashboard.spec as unknown as DashboardSpec
  const block = spec.blocks?.find((b) => b.id === blockId)
  if (!block) throw new DashboardError("NOT_FOUND", `no block '${blockId}' on this dashboard`)

  // Eligibility first, every time: a tool turned gated or an app turned off after the
  // save refuses even while an older answer is still cached.
  const check =
    block.source.kind === "tool"
      ? await checkToolSource(viewer.orgId, block.source.tool, viewer)
      : await checkStoreSource(viewer.orgId, block.source.app, block.source.collection, viewer)
  if (!check.ok) return { blockId, ok: false, error: check.code, message: check.message }

  if (opts.refresh && !(await takeRefresh(viewer, dashboardId, blockId))) {
    return {
      blockId,
      ok: false,
      error: "rate_limited",
      message: "this block was refreshed less than 30 seconds ago",
    }
  }
  const key = blockCacheKey(viewer, { dashboardId, version: dashboard.version, blockId })
  if (!opts.refresh) {
    const hit = await readCachedBlock<CachedBlock>(key)
    if (hit) return { blockId, ok: true, data: hit.data, cached: true, computedAt: hit.computedAt }
  }
  const outcome = await withViewerSlot(viewer, () =>
    computeBlock(block, { viewer, dashboardId, ...(opts.signal ? { signal: opts.signal } : {}) }),
  )
  if (!outcome.ok) return { blockId, ok: false, error: outcome.error, message: outcome.message }
  const computedAt = new Date().toISOString()
  await writeCachedBlock(
    key,
    { data: outcome.data, computedAt } satisfies CachedBlock,
    blockTtlSec(block),
  )
  return { blockId, ok: true, data: outcome.data, cached: false, computedAt }
}
