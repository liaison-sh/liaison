// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * kernel.org_exports rows: request, claim, heartbeat, complete, fail, list,
 * download, and the leader's maintenance (stale running rows fail, completed
 * rows expire after 7 days and lose their object).
 *
 * Every write goes through the privileged connection pinned to the row's org;
 * callers check the person's scope first (routes: `kernel:org:admin`; CLI:
 * the operator).
 *
 * A running row belongs to one run, named by `run_id`: each claim sets a new
 * token, and heartbeat, complete and fail match on it, so a run whose row was
 * taken over (a stalled job the queue handed out again) changes nothing.
 *
 * `error` holds a code an admin's screen can show (OrgExportErrorCode, plus
 * the reached and allowed sizes for EXPORT_TOO_LARGE), never an internal
 * message: that goes to the log and the `org.export.failed` audit row.
 */
import { and, desc, sql as drizzleSql, eq, inArray, lt } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type OrgExportRow, orgExports, users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { deleteObject } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import { writeAuditLog } from "~/modules/audit/service"
import {
  SKIPPED_MOVING,
  sweepSkippingMoving,
  writeUnlessMoving,
} from "~/modules/org/transfer-state/skip-moving"

const log = rootLogger.child({ module: "org-export-store" })

export const ORG_EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const ORG_EXPORT_STALE_MS = 15 * 60 * 1000
/**
 * A queued export no job picked up in this long was lost (an enqueue that
 * failed silently, a flushed queue): the fairness delay (A11) is at most 24 h.
 */
export const ORG_EXPORT_QUEUE_LOST_MS = 25 * 60 * 60 * 1000

export type OrgExportErrorCode =
  | "EXPORT_TOO_LARGE"
  | "STALLED"
  | "QUEUE_FAILED"
  | "QUEUE_LOST"
  | "INTERNAL"

export interface OrgExportFailure {
  code: OrgExportErrorCode
  /** Stored as the error after the code (EXPORT_TOO_LARGE's sizes): nothing internal. */
  shown?: string
  /** The internal message: log and audit only. */
  detail?: string
}

function storedError(f: OrgExportFailure): string {
  return (f.shown ? `${f.code}: ${f.shown}` : f.code).slice(0, 1000)
}
/** A running export whose heartbeat (every 30 s) is this old is taken over by a retry. */
const RECLAIM_AFTER_MS = 2 * 60 * 1000

/** A second request while one export of the org is queued or running. */
export class OrgExportRunningError extends Error {
  readonly code = "ORG_EXPORT_RUNNING"
  constructor(readonly runningId: string | null) {
    super("An export of this organization is already running")
    this.name = "OrgExportRunningError"
  }
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; i++) {
    const x = e as { code?: string; cause?: unknown }
    if (x.code === "23505") return true
    e = x.cause
  }
  return false
}

async function activeExportId(orgId: string): Promise<string | null> {
  const [row] = await withPrivilegedDb(orgId, "org-export-active", (tx) =>
    tx
      .select({ id: orgExports.id })
      .from(orgExports)
      .where(and(eq(orgExports.orgId, orgId), inArray(orgExports.status, ["queued", "running"])))
      .limit(1),
  )
  return row?.id ?? null
}

/** Insert a queued export (and its `org.export.requested` audit row). */
export async function createOrgExport(
  orgId: string,
  by: { userId: string | null; via: "settings" | "cli" },
): Promise<OrgExportRow> {
  try {
    return await withPrivilegedDb(orgId, "org-export-create", async (tx) => {
      const [row] = await tx
        .insert(orgExports)
        .values({ orgId, requestedBy: by.userId, requestedVia: by.via })
        .returning()
      if (!row) throw new Error("org export insert returned no row")
      await writeAuditLog(
        tx,
        {
          orgId,
          actorId: by.userId,
          actorType: by.userId ? "user" : "system",
          app: "kernel",
          entityType: "org_export",
          entityId: row.id,
          action: "org.export.requested",
          metadata: { via: by.via },
        },
        { required: true },
      )
      return row
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw new OrgExportRunningError(await activeExportId(orgId))
    throw err
  }
}

export async function getOrgExport(orgId: string, id: string): Promise<OrgExportRow | null> {
  const [row] = await withPrivilegedDb(orgId, "org-export-get", (tx) =>
    tx
      .select()
      .from(orgExports)
      .where(and(eq(orgExports.orgId, orgId), eq(orgExports.id, id)))
      .limit(1),
  )
  return row ?? null
}

export interface OrgExportListItem {
  id: string
  status: OrgExportRow["status"]
  requestedBy: string | null
  requestedByName: string | null
  requestedVia: "settings" | "cli"
  bytes: number | null
  error: string | null
  createdAt: string
  completedAt: string | null
  expiresAt: string | null
}

/** The org's exports, newest first (no object keys: they are not the admin's business). */
export async function listOrgExports(orgId: string, limit = 50): Promise<OrgExportListItem[]> {
  const rows = await withPrivilegedDb(orgId, "org-export-list", (tx) =>
    tx
      .select({
        id: orgExports.id,
        status: orgExports.status,
        requestedBy: orgExports.requestedBy,
        requestedByName: users.name,
        requestedVia: orgExports.requestedVia,
        bytes: orgExports.bytes,
        error: orgExports.error,
        createdAt: orgExports.createdAt,
        completedAt: orgExports.completedAt,
        expiresAt: orgExports.expiresAt,
      })
      .from(orgExports)
      .leftJoin(users, eq(users.id, orgExports.requestedBy))
      .where(eq(orgExports.orgId, orgId))
      .orderBy(desc(orgExports.createdAt))
      .limit(limit),
  )
  return rows.map((r) => ({
    ...r,
    requestedByName: r.requestedByName ?? null,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  }))
}

/**
 * Take a queued export for this run, with a new run token. A row already
 * `running` is taken again only once its heartbeat is older than
 * RECLAIM_AFTER_MS (a stalled job the queue handed back): the archive is
 * rebuilt from the start under the new token's own object key, and the old
 * run stops at its next heartbeat. Null when the row is final or another run
 * holds it.
 */
export async function claimOrgExport(
  orgId: string,
  id: string,
): Promise<(OrgExportRow & { runId: string }) | null> {
  const [row] = await withPrivilegedDb(orgId, "org-export-claim", (tx) =>
    tx
      .update(orgExports)
      .set({
        status: "running",
        runId: drizzleSql`gen_random_uuid()`,
        startedAt: drizzleSql`now()`,
        updatedAt: drizzleSql`now()`,
      })
      .where(
        and(
          eq(orgExports.orgId, orgId),
          eq(orgExports.id, id),
          drizzleSql`(${orgExports.status} = 'queued' OR (${orgExports.status} = 'running'
            AND ${orgExports.updatedAt} < now() - make_interval(secs => ${RECLAIM_AFTER_MS / 1000})))`,
        ),
      )
      .returning(),
  )
  if (!row?.runId) return null
  return { ...row, runId: row.runId }
}

/** The row is running and held by this run. */
function heldBy(orgId: string, id: string, runId: string) {
  return and(
    eq(orgExports.orgId, orgId),
    eq(orgExports.id, id),
    eq(orgExports.status, "running"),
    eq(orgExports.runId, runId),
  )
}

/** False when this run no longer holds the row (taken over, or failed as stalled). */
export async function heartbeatOrgExport(
  orgId: string,
  id: string,
  runId: string,
): Promise<boolean> {
  const rows = await withPrivilegedDb(orgId, "org-export-heartbeat", (tx) =>
    tx
      .update(orgExports)
      .set({ updatedAt: drizzleSql`now()` })
      .where(heldBy(orgId, id, runId))
      .returning({ id: orgExports.id }),
  )
  return rows.length > 0
}

/**
 * Mark the export completed, write `org.export.completed`, and tell the
 * admin who asked (attention: `org_export:complete`, kernel-translations.ts).
 */
export async function completeOrgExport(
  orgId: string,
  id: string,
  runId: string,
  result: { objectKey: string; bytes: number; manifest: Record<string, unknown> },
): Promise<OrgExportRow | null> {
  return withPrivilegedDb(orgId, "org-export-complete", async (tx) => {
    const [row] = await tx
      .update(orgExports)
      .set({
        status: "completed",
        objectKey: result.objectKey,
        bytes: result.bytes,
        manifest: result.manifest,
        error: null,
        completedAt: drizzleSql`now()`,
        updatedAt: drizzleSql`now()`,
        expiresAt: drizzleSql`now() + make_interval(secs => ${ORG_EXPORT_TTL_MS / 1000})`,
      })
      .where(heldBy(orgId, id, runId))
      .returning()
    if (!row) return null
    await writeAuditLog(tx, {
      orgId,
      actorId: row.requestedBy,
      actorType: row.requestedBy ? "user" : "system",
      app: "kernel",
      entityType: "org_export",
      entityId: id,
      action: "org.export.completed",
      metadata: { bytes: result.bytes },
    })
    if (row.requestedBy) {
      await tx.queueEvent({
        app: "kernel",
        entity: "org_export",
        action: "complete",
        entityId: id,
        data: {
          orgId,
          exportId: id,
          bytes: result.bytes,
          notifyUserId: row.requestedBy,
          summary: "Your organization export is ready to download. It expires in 7 days.",
          settingsRoute: "/settings/admin/org",
        },
        actorId: row.requestedBy,
        actorType: "system",
        orgId,
        timestamp: new Date().toISOString(),
      })
    }
    return row
  })
}

/**
 * Mark the export failed with a code an admin can read. With `runId`, only
 * while that run holds the running row; without, only a still-queued row (an
 * enqueue that failed). False when nothing matched.
 */
export async function failOrgExport(
  orgId: string,
  id: string,
  failure: OrgExportFailure,
  runId?: string,
): Promise<boolean> {
  return withPrivilegedDb(orgId, "org-export-fail", async (tx) => {
    const [row] = await tx
      .update(orgExports)
      .set({
        status: "failed",
        error: storedError(failure),
        objectKey: null,
        completedAt: drizzleSql`now()`,
        updatedAt: drizzleSql`now()`,
      })
      .where(
        runId
          ? heldBy(orgId, id, runId)
          : and(
              eq(orgExports.orgId, orgId),
              eq(orgExports.id, id),
              eq(orgExports.status, "queued"),
            ),
      )
      .returning({ id: orgExports.id, requestedBy: orgExports.requestedBy })
    if (!row) return false
    await writeAuditLog(tx, {
      orgId,
      actorId: row.requestedBy,
      actorType: row.requestedBy ? "user" : "system",
      app: "kernel",
      entityType: "org_export",
      entityId: id,
      action: "org.export.failed",
      metadata: {
        code: failure.code,
        ...(failure.detail ? { detail: failure.detail.slice(0, 500) } : {}),
      },
    })
    return true
  })
}

/** First download stamps `downloaded_at`; every download is audited. */
export async function recordOrgExportDownload(
  orgId: string,
  id: string,
  userId: string | null,
): Promise<void> {
  await withPrivilegedDb(orgId, "org-export-downloaded", async (tx) => {
    await tx
      .update(orgExports)
      .set({ downloadedAt: drizzleSql`COALESCE(${orgExports.downloadedAt}, now())` })
      .where(and(eq(orgExports.orgId, orgId), eq(orgExports.id, id)))
    await writeAuditLog(tx, {
      orgId,
      actorId: userId,
      actorType: userId ? "user" : "system",
      app: "kernel",
      entityType: "org_export",
      entityId: id,
      action: "org.export.downloaded",
    })
  })
}

/**
 * Leader maintenance, daily and on a short cadence:
 *  - running exports whose heartbeat stopped more than 15 min ago fail (their
 *    worker died; the partial upload was aborted or never completed),
 *  - queued exports no job picked up within ORG_EXPORT_QUEUE_LOST_MS fail (the
 *    job was lost; the org could otherwise never export again),
 *  - completed exports past `expires_at` lose their object and become `expired`.
 */
export async function sweepOrgExports(
  now: Date = new Date(),
): Promise<{ failed: number; expired: number }> {
  const K = drizzleSql.raw(schemaRef("kernel"))
  const staleBefore = new Date(now.getTime() - ORG_EXPORT_STALE_MS)
  const lostBefore = new Date(now.getTime() - ORG_EXPORT_QUEUE_LOST_MS)
  // An org being moved keeps its export rows as they are until the move ends.
  const stale = await sweepSkippingMoving((notMoving) =>
    withSystemDb("org-export-stale-list", async (tx) =>
      extractRows<{ id: string; org_id: string; status: "queued" | "running" }>(
        await tx.execute(drizzleSql`
        SELECT id::text AS id, org_id::text AS org_id, status FROM ${K}.org_exports
        WHERE ((status = 'running' AND updated_at < ${staleBefore.toISOString()}::timestamptz)
           OR (status = 'queued' AND created_at < ${lostBefore.toISOString()}::timestamptz))
          AND ${notMoving(drizzleSql.raw("org_id"))}
        LIMIT 500
      `),
      ),
    ),
  )
  let failed = 0
  for (const r of stale) {
    const moved = await writeUnlessMoving(r.org_id, () =>
      withPrivilegedDb(r.org_id, "org-export-stale-fail", (tx) =>
        tx
          .update(orgExports)
          .set({
            status: "failed",
            error: storedError({ code: r.status === "queued" ? "QUEUE_LOST" : "STALLED" }),
            completedAt: drizzleSql`now()`,
            updatedAt: drizzleSql`now()`,
          })
          .where(
            r.status === "queued"
              ? and(
                  eq(orgExports.orgId, r.org_id),
                  eq(orgExports.id, r.id),
                  eq(orgExports.status, "queued"),
                  lt(orgExports.createdAt, lostBefore),
                )
              : and(
                  eq(orgExports.orgId, r.org_id),
                  eq(orgExports.id, r.id),
                  eq(orgExports.status, "running"),
                  lt(orgExports.updatedAt, staleBefore),
                ),
          )
          .returning({ id: orgExports.id }),
      ),
    )
    if (moved !== SKIPPED_MOVING && moved.length > 0) failed++
  }

  const due = await sweepSkippingMoving((notMoving) =>
    withSystemDb("org-export-expiry-list", async (tx) =>
      extractRows<{ id: string; org_id: string; object_key: string | null }>(
        await tx.execute(drizzleSql`
        SELECT id::text AS id, org_id::text AS org_id, object_key FROM ${K}.org_exports
        WHERE status = 'completed' AND expires_at < ${now.toISOString()}::timestamptz
          AND ${notMoving(drizzleSql.raw("org_id"))}
        ORDER BY expires_at
        LIMIT 500
      `),
      ),
    ),
  )
  let expired = 0
  for (const r of due) {
    const done = await writeUnlessMoving(r.org_id, async () => {
      try {
        if (r.object_key) await deleteObject(r.object_key)
      } catch (err) {
        // Left `completed` so the next sweep tries again; the GC keeps the object
        // until then only while it is unexpired, so it goes either way.
        log.error({ err, orgId: r.org_id, exportId: r.id }, "org export object delete failed")
        return false
      }
      await withPrivilegedDb(r.org_id, "org-export-expire", (tx) =>
        tx
          .update(orgExports)
          .set({ status: "expired", objectKey: null, updatedAt: drizzleSql`now()` })
          .where(
            and(
              eq(orgExports.orgId, r.org_id),
              eq(orgExports.id, r.id),
              eq(orgExports.status, "completed"),
            ),
          ),
      )
      return true
    })
    if (done !== true) continue
    expired++
  }
  if (failed > 0 || expired > 0) log.info({ failed, expired }, "org export sweep")
  return { failed, expired }
}
