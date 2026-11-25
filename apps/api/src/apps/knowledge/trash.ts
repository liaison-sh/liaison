// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Trash: what a person may restore, and the delete for good.
 *
 * A page goes to Trash when a person (or an agent acting for one) archives it:
 * `archived_at`, `trashed_at` and `trashed_by` are set in one write
 * (service.ts `archiveKnowledgeDocument`). Thirty days later the daily job
 * deletes it, with everything that names it. An admin who may edit the page can
 * delete it for good sooner.
 *
 * - One rule decides what may be deleted ({@link PURGEABLE}, K-R1): archived,
 *   trashed at or after the archive, and not synced. A page archived before
 *   Trash existed has no clock, so it is listed ("kept") and never deleted by the
 *   job; an admin restores it and moves it to Trash before deleting it for good.
 *   Any restore or re-sync, from this release, the previous one or the
 *   reconciler, makes the row unpurgeable: the trigger `documents_trash_guard`
 *   clears the clock, and without it the clock is older than the new archive.
 * - The rule is checked again on the row locked `FOR UPDATE` inside the deleting
 *   transaction, so a restore that commits first wins: nothing is deleted.
 * - Residue (K-R12): every table the purge empties is counted by the page's id
 *   at the end of the transaction; anything left rolls it back (the page stays in
 *   Trash) and raises an alert. What a transaction cannot hold, the search index
 *   entry and the stored objects, is checked ten minutes after the commit by the
 *   `trash-residue` job, which queues the removal again and alerts on the third
 *   miss. Audit and timeline rows stay: they record acts, not content.
 * - The job is the only path that does not start from a person's row view
 *   (K-R19). The delete for good loads the page under the caller's RLS, needs the
 *   edit right (else the same not-found as an unknown id), then the admin scope.
 *
 * Once pages carry an "author reads" flag (agreements), Trash and the purge must
 * refuse a row with it false; nothing here reads it yet.
 */
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { kernelRel, knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  assertCanWriteDocumentRow,
  type KnowledgeActor,
  KnowledgeError,
  loadDocumentShareRole,
  loadKnowledgeDocument,
} from "~/apps/knowledge/service"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { trackError } from "~/lib/error-tracker"
import { jobsLogger as log } from "~/lib/logger"
import { sweepSkippingMoving, writeUnlessMoving } from "~/modules/org/transfer-state/skip-moving"
import { hasScope } from "~/modules/permissions/permissions"

/** Days a page stays in Trash before the daily job deletes it (D4). */
export const TRASH_DAYS = 30
/** Days a stored version of a page is kept (spec S8). */
export const VERSION_KEEP_DAYS = 365
/** Pages one org's purge takes per round. */
export const PURGE_BATCH = 100
/** Minutes after a purge before its index entry and objects are checked. */
export const RESIDUE_CHECK_DELAY_MS = 10 * 60 * 1000
/** Checks of one purge's index entry and objects before the alert. */
export const RESIDUE_MAX_CHECKS = 3

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The one rule for a page that may be deleted for good, over the alias `d` of
 * `app_knowledge.documents` (K-R1). Every deleting path uses it, and the purge
 * checks it again on the locked row.
 */
export const PURGEABLE: SQL = drizzleSql`(d.archived_at IS NOT NULL
  AND d.trashed_at IS NOT NULL
  AND d.trashed_at >= d.archived_at
  AND d.synced_source_id IS NULL)`

/** A page that went to Trash before `cutoff` (the job's age rule). */
function trashedBefore(cutoff: Date): SQL {
  return drizzleSql`d.trashed_at <= ${cutoff.toISOString()}::timestamptz`
}

export interface TrashEntry {
  id: string
  title: string
  archivedAt: string
  /** When it went to Trash; null for a page archived before Trash (kept). */
  trashedAt: string | null
  trashedBy: string | null
  /** The name of who moved it to Trash, for the Trash list ("Amina Cherif"). */
  trashedByName: string | null
  /** Whole days before the job deletes it; null when it is kept (never deleted automatically). */
  daysLeft: number | null
}

interface TrashDbRow {
  id: string
  title: string
  archived_at: Date | string
  trashed_at: Date | string | null
  trashed_by: string | null
  trashed_by_name: string | null
  clocked: boolean
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}

function entryFromDb(r: TrashDbRow, now: Date): TrashEntry {
  const trashedAt = r.clocked && r.trashed_at ? iso(r.trashed_at) : null
  const daysLeft =
    trashedAt === null
      ? null
      : Math.max(0, Math.ceil(TRASH_DAYS - (now.getTime() - Date.parse(trashedAt)) / DAY_MS))
  return {
    id: r.id,
    title: r.title,
    archivedAt: iso(r.archived_at),
    trashedAt,
    trashedBy: trashedAt ? r.trashed_by : null,
    trashedByName: trashedAt ? r.trashed_by_name : null,
    daysLeft,
  }
}

function canSeeTrash(actor: KnowledgeActor): boolean {
  return (
    hasScope("knowledge:documents:archive", actor.scopes) ||
    hasScope("knowledge:documents:admin", actor.scopes)
  )
}

/**
 * The pages in Trash the actor may restore: archived, not synced, and editable by
 * them under their own row view (`app_knowledge.can_edit_document`). Newest first.
 * Without the archive scope archived rows are not visible at all, so the list is
 * empty.
 */
export async function listTrash(
  tx: RlsClient,
  actor: KnowledgeActor,
  opts: { id?: string; now?: Date } = {},
): Promise<TrashEntry[]> {
  if (!canSeeTrash(actor)) return []
  const now = opts.now ?? new Date()
  const rows = extractRows<TrashDbRow>(
    await tx.execute(drizzleSql`
      SELECT d.id::text AS id, d.title, d.archived_at, d.trashed_at, d.trashed_by::text AS trashed_by,
             u.name AS trashed_by_name, ${PURGEABLE} AS clocked
        FROM ${knowledgeRel("documents")} d
        LEFT JOIN ${kernelRel("users")} u ON u.id = d.trashed_by
       WHERE d.org_id = ${actor.orgId}::uuid
         AND d.archived_at IS NOT NULL
         AND d.synced_source_id IS NULL
         ${opts.id ? drizzleSql`AND d.id = ${opts.id}::uuid` : drizzleSql``}
         AND ${knowledgeRel("can_edit_document")}(d.id)
       ORDER BY COALESCE(d.trashed_at, d.archived_at) DESC, d.id
       LIMIT 1000`),
  )
  return rows.map((r) => entryFromDb(r, now))
}

/** Refused delete for good on a page the caller may edit: said as such (403), it names nothing new. */
export class DeleteForGoodScopeError extends KnowledgeError {
  constructor() {
    super("FORBIDDEN", "Only an administrator can delete a page for good")
  }
}

/**
 * The checks of "Delete for good", under the caller's own row view (K-R19, A23):
 * a page the caller cannot read or edit is the same not-found as an unknown id;
 * then the admin scope; then the page must be in Trash with a clock (a page
 * archived before Trash is restored and moved to Trash first).
 */
export async function assertCanDeleteForGood(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<void> {
  const reader = { ...actor, includeArchived: true }
  const row = await loadKnowledgeDocument(tx, id, reader)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
  assertCanWriteDocumentRow(row, reader, await loadDocumentShareRole(tx, row.id, actor))
  if (!hasScope("knowledge:documents:admin", actor.scopes)) throw new DeleteForGoodScopeError()
  if (row.syncedSourceId) {
    throw new KnowledgeError("VALIDATION", "This page is synced: manage it in its source")
  }
  const [inTrash] = extractRows<{ ok: boolean }>(
    await tx.execute(drizzleSql`
      SELECT ${PURGEABLE} AS ok FROM ${knowledgeRel("documents")} d
       WHERE d.id = ${id}::uuid AND d.org_id = ${actor.orgId}::uuid`),
  )
  if (!inTrash?.ok) {
    throw new KnowledgeError(
      "VALIDATION",
      row.archivedAt
        ? "This page was archived before Trash existed: restore it and move it to Trash first"
        : "Move this page to Trash before deleting it for good",
    )
  }
}

// ---------------------------------------------------------------------------
// The purge
// ---------------------------------------------------------------------------

export interface PurgedFile {
  id: string
  storageKey: string
  thumbnailKey: string | null
}

export interface PurgeResult {
  orgId: string
  documentId: string
  files: PurgedFile[]
}

/** Rows left behind by a purge: the transaction rolled back, the page is still in Trash. */
export class PurgeResidueError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly residue: Record<string, number>,
  ) {
    super(
      `Knowledge purge left rows behind (${Object.entries(residue)
        .map(([t, n]) => `${t}: ${n}`)
        .join(", ")}); page kept in Trash`,
    )
    this.name = "PurgeResidueError"
  }
}

/** Every row that names the page, counted by its id. A purge leaves all of them at 0. */
async function countResidue(
  tx: PrivilegedDb,
  orgId: string,
  id: string,
): Promise<Record<string, number>> {
  const [row] = extractRows<Record<string, number>>(
    await tx.execute(drizzleSql`
      SELECT
        (SELECT count(*)::int FROM ${knowledgeRel("documents")}
          WHERE id = ${id}::uuid) AS documents,
        (SELECT count(*)::int FROM ${knowledgeRel("document_versions")}
          WHERE document_id = ${id}::uuid) AS document_versions,
        (SELECT count(*)::int FROM ${knowledgeRel("document_links")}
          WHERE org_id = ${orgId}::uuid
            AND (source_document_id = ${id}::uuid OR target_document_id = ${id}::uuid)) AS document_links,
        (SELECT count(*)::int FROM ${knowledgeRel("collection_memberships")}
          WHERE org_id = ${orgId}::uuid AND target_type = 'document'
            AND target_id = ${id}::uuid) AS collection_memberships,
        (SELECT count(*)::int FROM ${knowledgeRel("taggings")}
          WHERE org_id = ${orgId}::uuid AND target_type = 'document'
            AND target_id = ${id}::uuid) AS taggings,
        (SELECT count(*)::int FROM ${knowledgeRel("collections")}
          WHERE org_id = ${orgId}::uuid AND index_document_id = ${id}::uuid) AS folder_pages,
        (SELECT count(*)::int FROM ${kernelRel("resource_grants")}
          WHERE org_id = ${orgId}::uuid AND resource_type = 'knowledge.document'
            AND resource_id = ${id}::uuid) AS resource_grants,
        (SELECT count(*)::int FROM ${kernelRel("thread_references")}
          WHERE org_id = ${orgId}::uuid AND app = 'knowledge' AND entity_type = 'document'
            AND entity_id = ${id}) AS thread_references,
        (SELECT count(*)::int FROM ${kernelRel("attention_events")}
          WHERE org_id = ${orgId}::uuid AND app = 'knowledge' AND entity_type = 'document'
            AND entity_id = ${id}) AS attention_events,
        (SELECT count(*)::int FROM ${kernelRel("files")}
          WHERE org_id = ${orgId}::uuid AND app = 'knowledge' AND entity_type = 'document'
            AND entity_id = ${id}) AS files,
        (SELECT count(*)::int FROM ${kernelRel("file_upload_sessions")}
          WHERE org_id = ${orgId}::uuid AND target_app = 'knowledge'
            AND target_entity_type = 'document' AND target_entity_id = ${id}) AS upload_sessions`),
  )
  const left: Record<string, number> = {}
  for (const [table, n] of Object.entries(row ?? {})) if (Number(n) > 0) left[table] = Number(n)
  return left
}

/**
 * Delete one page for good, in the caller's privileged transaction, if it is
 * still purgeable on its locked row (and, for the job, in Trash since `before`).
 * Returns null when it is not: restored, re-synced, archived again by SQL that
 * does not know Trash, or gone. Throws {@link PurgeResidueError} when a row
 * naming the page is left, which rolls the transaction back.
 */
export async function purgeDocument(
  tx: PrivilegedDb,
  orgId: string,
  id: string,
  opts: { trashedBefore?: Date; actorId?: string | null } = {},
): Promise<PurgeResult | null> {
  const locked = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT d.id::text AS id FROM ${knowledgeRel("documents")} d
       WHERE d.id = ${id}::uuid AND d.org_id = ${orgId}::uuid
         AND ${PURGEABLE}
         ${opts.trashedBefore ? drizzleSql`AND ${trashedBefore(opts.trashedBefore)}` : drizzleSql``}
       FOR UPDATE`),
  )
  if (locked.length === 0) return null

  // Files go the way every file deletion goes: the row now, the object once this
  // transaction commits (the kernel `file:delete` event; files/delete-object-job.ts).
  const files = extractRows<PurgedFile & { app: string; entityType: string; entityId: string }>(
    await tx.execute(drizzleSql`
      DELETE FROM ${kernelRel("files")}
       WHERE org_id = ${orgId}::uuid AND app = 'knowledge' AND entity_type = 'document'
         AND entity_id = ${id}
      RETURNING id::text AS id, app, entity_type AS "entityType", entity_id AS "entityId",
                storage_key AS "storageKey", thumbnail_key AS "thumbnailKey"`),
  )
  for (const f of files) {
    await tx.queueEvent({
      app: "kernel",
      entity: "file",
      action: "delete",
      entityId: f.id,
      orgId,
      actorId: opts.actorId ?? null,
      actorType: opts.actorId ? "user" : "system",
      data: { ...f },
    })
  }
  await tx.execute(drizzleSql`
    DELETE FROM ${kernelRel("file_upload_sessions")}
     WHERE org_id = ${orgId}::uuid AND target_app = 'knowledge'
       AND target_entity_type = 'document' AND target_entity_id = ${id}`)
  await tx.execute(drizzleSql`
    DELETE FROM ${knowledgeRel("taggings")}
     WHERE org_id = ${orgId}::uuid AND target_type = 'document' AND target_id = ${id}::uuid`)
  await tx.execute(drizzleSql`
    DELETE FROM ${knowledgeRel("collection_memberships")}
     WHERE org_id = ${orgId}::uuid AND target_type = 'document' AND target_id = ${id}::uuid`)
  await tx.execute(drizzleSql`
    DELETE FROM ${knowledgeRel("document_links")}
     WHERE org_id = ${orgId}::uuid
       AND (source_document_id = ${id}::uuid OR target_document_id = ${id}::uuid)`)
  await tx.execute(drizzleSql`
    DELETE FROM ${kernelRel("resource_grants")}
     WHERE org_id = ${orgId}::uuid AND resource_type = 'knowledge.document'
       AND resource_id = ${id}::uuid`)
  await tx.execute(drizzleSql`
    DELETE FROM ${kernelRel("thread_references")}
     WHERE org_id = ${orgId}::uuid AND app = 'knowledge' AND entity_type = 'document'
       AND entity_id = ${id}`)
  await tx.execute(drizzleSql`
    DELETE FROM ${kernelRel("attention_events")}
     WHERE org_id = ${orgId}::uuid AND app = 'knowledge' AND entity_type = 'document'
       AND entity_id = ${id}`)
  await tx.execute(drizzleSql`
    UPDATE ${knowledgeRel("collections")} SET index_document_id = NULL
     WHERE org_id = ${orgId}::uuid AND index_document_id = ${id}::uuid`)
  await tx.execute(drizzleSql`
    DELETE FROM ${knowledgeRel("document_versions")} WHERE document_id = ${id}::uuid`)
  await tx.execute(drizzleSql`
    DELETE FROM ${knowledgeRel("documents")} WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid`)
  // The search index drops it on this event (search/indexer.ts), after the commit.
  await tx.queueEvent({
    app: "knowledge",
    entity: "document",
    action: "delete",
    entityId: id,
    orgId,
    actorId: opts.actorId ?? null,
    actorType: opts.actorId ? "user" : "system",
    data: { id, purged: true },
  })

  const residue = await countResidue(tx, orgId, id)
  if (Object.keys(residue).length > 0) throw new PurgeResidueError(id, residue)
  return {
    orgId,
    documentId: id,
    files: files.map((f) => ({ id: f.id, storageKey: f.storageKey, thumbnailKey: f.thumbnailKey })),
  }
}

/**
 * Delete for good, once {@link assertCanDeleteForGood} passed under the person's
 * own row view: the locked delete in its own transaction pinned to their org, then
 * the residue check. False when the page left Trash meanwhile (nothing deleted).
 */
export async function deleteForGood(orgId: string, id: string, actorId: string): Promise<boolean> {
  const result = await withPrivilegedDb(orgId, "knowledge-delete-for-good", (tx) =>
    purgeDocument(tx, orgId, id, { actorId }),
  )
  if (!result) return false
  await scheduleResidueCheck(result)
  return true
}

/** A purge that failed or left something behind: logged, and counted for the monitor's alert. */
export function alertTrash(err: unknown, context: Record<string, unknown>, message: string): void {
  log.error({ err, ...context }, message)
  trackError(err instanceof Error ? err : new Error(`${message}: ${String(err)}`))
}

// ---------------------------------------------------------------------------
// After the commit: the index entry and the stored objects
// ---------------------------------------------------------------------------

export interface TrashResidueJobPayload {
  orgId: string
  documentId: string
  files: PurgedFile[]
  /** 1 for the first check, ten minutes after the purge. */
  attempt: number
}

export interface TrashResidueDeps {
  /** Whether the search index still holds the page. */
  searchHas?: (orgId: string, documentId: string) => Promise<boolean>
  /** Whether a stored object still exists. */
  objectExists?: (key: string) => Promise<boolean>
  /** Queue the page's removal from the index again. */
  removeFromIndex?: (orgId: string, documentId: string) => Promise<void>
  /** Queue the objects' removal again. */
  removeObjects?: (orgId: string, files: PurgedFile[]) => Promise<void>
  /** Schedule a check (the next one, or the first after a purge). */
  schedule?: (payload: TrashResidueJobPayload) => Promise<void>
}

function isNotFound(err: unknown): boolean {
  const e = err as {
    code?: string
    cause?: { code?: string }
    name?: string
    $metadata?: { httpStatusCode?: number }
    httpStatus?: number
  }
  return (
    e?.code === "document_not_found" ||
    e?.cause?.code === "document_not_found" ||
    e?.name === "NotFound" ||
    e?.name === "NoSuchKey" ||
    e?.$metadata?.httpStatusCode === 404 ||
    e?.httpStatus === 404
  )
}

async function defaultSearchHas(orgId: string, documentId: string): Promise<boolean> {
  const [{ effectiveIndexName, getMeili }, { documentId: searchDocumentId }] = await Promise.all([
    import("~/infra/search/client"),
    import("~/modules/search/document-id"),
  ])
  try {
    await getMeili()
      .index(effectiveIndexName())
      .getDocument(searchDocumentId(orgId, "knowledge", "document", documentId))
    return true
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

async function defaultObjectExists(key: string): Promise<boolean> {
  const { headObject } = await import("~/infra/storage/object-storage")
  try {
    await headObject(key)
    return true
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

async function defaultRemoveFromIndex(orgId: string, documentId: string): Promise<void> {
  const { removeFromSearch } = await import("~/apps/knowledge/account-sources-purge")
  await removeFromSearch(orgId, { documentIds: [documentId], sourceLinkIds: [] })
}

async function defaultRemoveObjects(orgId: string, files: PurgedFile[]): Promise<void> {
  await withPrivilegedDb(orgId, "knowledge-trash-residue-objects", async (tx) => {
    for (const f of files) {
      await tx.queueEvent({
        app: "kernel",
        entity: "file",
        action: "delete",
        entityId: f.id,
        orgId,
        actorId: null,
        actorType: "system",
        data: { id: f.id, storageKey: f.storageKey, thumbnailKey: f.thumbnailKey },
      })
    }
  })
}

async function defaultSchedule(payload: TrashResidueJobPayload): Promise<void> {
  const { enqueueAppJob } = await import("~/infra/jobs/jobs")
  await enqueueAppJob("knowledge", "trash-residue", payload, {
    delay: RESIDUE_CHECK_DELAY_MS,
    jobId: `trash-residue:${payload.documentId}:${payload.attempt}`,
  })
}

/** After a purge committed: its first residue check, ten minutes on. Never throws. */
export async function scheduleResidueCheck(
  result: PurgeResult,
  deps: Pick<TrashResidueDeps, "schedule"> = {},
): Promise<void> {
  try {
    await (deps.schedule ?? defaultSchedule)({ ...result, attempt: 1 })
  } catch (err) {
    alertTrash(
      err,
      { orgId: result.orgId, documentId: result.documentId },
      "knowledge: residue check not scheduled",
    )
  }
}

/**
 * One residue check (K-R12): the page's index entry and stored objects must be
 * gone. What is left is queued for removal again and checked once more; the third
 * miss raises the alert. Nothing left: silent. Returns what was still there.
 */
export async function checkTrashResidue(
  payload: TrashResidueJobPayload,
  deps: TrashResidueDeps = {},
): Promise<{ index: boolean; objects: string[] }> {
  const searchHas = deps.searchHas ?? defaultSearchHas
  const objectExists = deps.objectExists ?? defaultObjectExists
  const index = await searchHas(payload.orgId, payload.documentId)
  const objects: string[] = []
  const filesLeft: PurgedFile[] = []
  for (const f of payload.files) {
    const keys = [f.storageKey, ...(f.thumbnailKey ? [f.thumbnailKey] : [])]
    let left = false
    for (const key of keys) {
      if (await objectExists(key)) {
        objects.push(key)
        left = true
      }
    }
    if (left) filesLeft.push(f)
  }
  if (!index && objects.length === 0) return { index, objects }

  if (index)
    await (deps.removeFromIndex ?? defaultRemoveFromIndex)(payload.orgId, payload.documentId)
  if (filesLeft.length > 0)
    await (deps.removeObjects ?? defaultRemoveObjects)(payload.orgId, filesLeft)
  const context = {
    orgId: payload.orgId,
    documentId: payload.documentId,
    attempt: payload.attempt,
    index,
    objects: objects.length,
  }
  if (payload.attempt >= RESIDUE_MAX_CHECKS) {
    alertTrash(
      new Error("Knowledge purge residue: search entry or stored objects still present"),
      context,
      "knowledge: purged page still in the search index or storage",
    )
  } else {
    log.warn(context, "knowledge: purged page residue re-queued")
    await (deps.schedule ?? defaultSchedule)({
      ...payload,
      files: filesLeft,
      attempt: payload.attempt + 1,
    })
  }
  return { index, objects }
}

// ---------------------------------------------------------------------------
// The daily job
// ---------------------------------------------------------------------------

export interface TrashPurgeOptions {
  now?: Date
  /** Test hook: runs after an org's candidates were selected, before any is locked. */
  afterSelect?: (orgId: string, ids: string[]) => void | Promise<void>
  /** Residue check scheduling (tests pass a capture). */
  schedule?: TrashResidueDeps["schedule"]
}

export interface TrashPurgeReport {
  purged: string[]
  failed: string[]
  versionsPruned: number
}

/**
 * Delete every page in Trash for {@link TRASH_DAYS} days, org by org, a batch of
 * {@link PURGE_BATCH} at a time, each page in its own transaction; leave orgs
 * being moved alone. Then drop stored versions older than {@link VERSION_KEEP_DAYS}.
 */
export async function runTrashPurge(opts: TrashPurgeOptions = {}): Promise<TrashPurgeReport> {
  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getTime() - TRASH_DAYS * DAY_MS)
  const report: TrashPurgeReport = { purged: [], failed: [], versionsPruned: 0 }
  const orgs = extractRows<{ org_id: string }>(
    await sweepSkippingMoving((notMoving) =>
      withSystemDb("knowledge-trash-purge-orgs", (db) =>
        db.execute(drizzleSql`
          SELECT DISTINCT d.org_id::text AS org_id FROM ${knowledgeRel("documents")} d
           WHERE d.trashed_at IS NOT NULL AND ${PURGEABLE} AND ${trashedBefore(cutoff)}
             AND ${notMoving(drizzleSql.raw("d.org_id"))}`),
      ),
    ),
  )
  for (const { org_id: orgId } of orgs) {
    try {
      await writeUnlessMoving(orgId, () => purgeOrg(orgId, cutoff, opts, report))
    } catch (err) {
      alertTrash(err, { orgId }, "knowledge: Trash purge failed for an organisation")
    }
  }
  try {
    report.versionsPruned = await pruneOldVersions(now)
  } catch (err) {
    alertTrash(err, {}, "knowledge: old page versions not pruned")
  }
  return report
}

async function purgeOrg(
  orgId: string,
  cutoff: Date,
  opts: TrashPurgeOptions,
  report: TrashPurgeReport,
): Promise<void> {
  const tried = new Set<string>()
  for (;;) {
    const ids = extractRows<{ id: string }>(
      await withPrivilegedDb(orgId, "knowledge-trash-purge-select", (tx) =>
        tx.execute(drizzleSql`
          SELECT d.id::text AS id FROM ${knowledgeRel("documents")} d
           WHERE d.org_id = ${orgId}::uuid AND d.trashed_at IS NOT NULL
             AND ${PURGEABLE} AND ${trashedBefore(cutoff)}
             ${
               tried.size > 0
                 ? drizzleSql`AND d.id NOT IN (${drizzleSql.join(
                     [...tried].map((t) => drizzleSql`${t}::uuid`),
                     drizzleSql`, `,
                   )})`
                 : drizzleSql``
             }
           ORDER BY d.trashed_at, d.id
           LIMIT ${PURGE_BATCH}`),
      ),
    ).map((r) => r.id)
    if (ids.length === 0) return
    await opts.afterSelect?.(orgId, ids)
    for (const id of ids) {
      tried.add(id)
      try {
        const result = await withPrivilegedDb(orgId, "knowledge-trash-purge", (tx) =>
          purgeDocument(tx, orgId, id, { trashedBefore: cutoff }),
        )
        if (!result) continue
        report.purged.push(id)
        await scheduleResidueCheck(result, { schedule: opts.schedule })
      } catch (err) {
        report.failed.push(id)
        alertTrash(err, { orgId, documentId: id }, "knowledge: page not purged, kept in Trash")
      }
    }
    if (ids.length < PURGE_BATCH) return
  }
}

/** Versions older than a year go (spec S8: kept 1 year). Returns how many. */
async function pruneOldVersions(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - VERSION_KEEP_DAYS * DAY_MS).toISOString()
  let pruned = 0
  for (;;) {
    const n = extractRows<{ id: string }>(
      await sweepSkippingMoving((notMoving) =>
        withSystemDb("knowledge-versions-prune", (db) =>
          db.execute(drizzleSql`
            DELETE FROM ${knowledgeRel("document_versions")}
             WHERE id IN (
               SELECT v.id FROM ${knowledgeRel("document_versions")} v
                WHERE v.updated_at < ${cutoff}::timestamptz
                  AND ${notMoving(drizzleSql.raw("v.org_id"))}
                LIMIT 5000)
            RETURNING id::text AS id`),
        ),
      ),
    ).length
    pruned += n
    if (n < 5000) return pruned
  }
}
