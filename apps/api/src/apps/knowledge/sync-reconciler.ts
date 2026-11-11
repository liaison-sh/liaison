// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * sync-reconciler.ts — walk a synced source's folder tree and materialize it.
 *
 * Phase A (no DB tx): walk `adapter.listFolder` recursively + fetch the body
 *   of every text-MIME file via `adapter.fetchRemoteContent`. Pure I/O.
 * Phase B (single privileged tx): upsert collections / source_identities /
 *   documents / source_links, archive items that disappeared from the remote,
 *   and stamp the source's last_sync_at/last_sync_status. Always runs as
 *   liaison_admin (BYPASSRLS) — the reconciler is system-trusted by
 *   construction.
 */
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { KnowledgeError } from "~/apps/knowledge/service"
import {
  importsAsDocument,
  type KnowledgeFolderItem,
  type KnowledgeSourceAdapter,
} from "~/apps/knowledge/source-protocol"
import { systemSyncActor } from "~/apps/knowledge/sync-actor"
import type { SyncedSourceRow } from "~/apps/knowledge/synced-sources"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { jobsLogger as log } from "~/lib/logger"
import { recomputeSearchAcl } from "~/modules/sharing/service"

export interface ReconcileStats {
  documentsUpserted: number
  sourceLinksUpserted: number
  collectionsUpserted: number
  documentsArchived: number
  sourceLinksArchived: number
  collectionsArchived: number
  fetchErrors: Array<{ externalId: string; error: string }>
  paginationCapped: string[]
  /**
   * Files of a personal source with no text form (a PDF, an image): nothing in
   * Knowledge holds them, so the source says which, in `last_error`, instead of
   * a bare "ok" with fewer documents than files.
   */
  skipped: Array<{ name: string; mimeType: string | null }>
  status: "ok" | "error"
}

const MAX_PAGES_PER_FOLDER = 50

// I5: Drive returns filenames up to 32 KB and we forward them into title +
// external_path. Cap to a sane bound and strip control characters so they
// can't blow up storage or smuggle ANSI/escape sequences into UI or logs.
export const TITLE_MAX = 512
const PATH_MAX = 1024

export function sanitizeExternalString(value: string, max: number): string {
  // Strip ASCII control chars (U+0000–U+001F + U+007F) — no legitimate place
  // in a filename, and they could corrupt UI rendering or log lines.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate strip of untrusted Drive metadata
  return value.replace(/[\x00-\x1F\x7F]/g, "").slice(0, max)
}

interface WalkedItem extends KnowledgeFolderItem {
  /** Depth from the root folder (root depth = 0). */
  depth: number
}

async function walkFolder(
  adapter: KnowledgeSourceAdapter,
  folderRef: string,
  actor: ReturnType<typeof systemSyncActor>,
  paginationCapped: string[],
): Promise<WalkedItem[]> {
  const results: WalkedItem[] = []
  const queue: Array<{ ref: string; depth: number }> = [{ ref: folderRef, depth: 0 }]
  const seen = new Set<string>([folderRef])
  // Deduplicates items by (externalId, parentExternalId) to prevent Drive
  // shortcuts and multi-parented items from being pushed more than once.
  const itemSeen = new Set<string>()
  while (queue.length > 0) {
    const next = queue.shift()!
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await adapter.listFolder!({ folderRef: next.ref, cursor }, actor)
      for (const item of page.items) {
        const itemKey = `${item.externalId}:${item.parentExternalId}`
        if (itemSeen.has(itemKey)) continue
        itemSeen.add(itemKey)
        results.push({ ...item, depth: next.depth + 1 })
        if (item.kind === "folder" && !seen.has(item.externalId)) {
          seen.add(item.externalId)
          queue.push({ ref: item.externalId, depth: next.depth + 1 })
        }
      }
      if (page.incompleteSearch) {
        // Drive signals the search index wasn't fully scanned — further
        // pagination is moot. Record the folder once and stop.
        paginationCapped.push(next.ref)
        log.warn(
          { folderRef: next.ref },
          "knowledge sync: remote search index incomplete for folder; some items may be missing",
        )
        break
      }
      cursor = page.nextCursor
      pages += 1
    } while (cursor && pages < MAX_PAGES_PER_FOLDER)
    if (cursor && pages >= MAX_PAGES_PER_FOLDER) {
      // Loud surfacing per the "infra fail loud" memory: this is a silent
      // truncation that ops needs to see and fix (raise the cap or paginate
      // via a child folder split). We don't throw — partial progress is still
      // useful — but we record it so the sync status carries the warning.
      paginationCapped.push(next.ref)
      log.warn(
        { folderRef: next.ref, cap: MAX_PAGES_PER_FOLDER },
        "knowledge sync: pagination cap reached for folder; some items may be missing",
      )
    }
  }
  return results
}

export async function upsertSourceIdentity(
  tx: PrivilegedDb,
  orgId: string,
  source: string,
  file: KnowledgeFolderItem,
): Promise<string> {
  // Single-roundtrip upsert (M-minor): ON CONFLICT … DO UPDATE … RETURNING id.
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      INSERT INTO ${knowledgeRel("source_identities")}
        (id, org_id, source, external_id, mime_type, modified_at, url)
      VALUES (
        ${randomUUID()}::uuid,
        ${orgId}::uuid,
        ${source},
        ${file.externalId},
        ${file.mimeType ?? null},
        ${file.modifiedAt ?? null},
        ${file.url ?? null}
      )
      ON CONFLICT (org_id, source, external_id) DO UPDATE SET
        mime_type = COALESCE(EXCLUDED.mime_type, ${knowledgeRel("source_identities")}.mime_type),
        modified_at = COALESCE(EXCLUDED.modified_at, ${knowledgeRel("source_identities")}.modified_at),
        url = COALESCE(EXCLUDED.url, ${knowledgeRel("source_identities")}.url),
        updated_at = now()
      RETURNING id
    `),
  )
  return rows[0]!.id
}

interface UpsertCollectionInput {
  sourceId: string
  orgId: string
  externalId: string
  name: string
  parentCollectionId: string
  ownerUserId: string | null
}

/**
 * Synced subfolders carry a description marker `synced:<sourceId>:<externalId>`
 * so the reconciler can find its own row across runs even if the upstream
 * folder was renamed. This avoids the "rename-then-resync" bug where matching
 * on `name` would create a duplicate and orphan the original.
 */
function syncedCollectionMarker(sourceId: string, externalId: string): string {
  return `synced:${sourceId}:${externalId}`
}

async function upsertSyncedCollection(
  tx: PrivilegedDb,
  collectionsByExternalId: Map<string, string>,
  input: UpsertCollectionInput,
): Promise<string> {
  const existing = collectionsByExternalId.get(input.externalId)
  if (existing) return existing
  const marker = syncedCollectionMarker(input.sourceId, input.externalId)
  // Look up by the marker (NOT by name — names can change upstream).
  const lookup = extractRows<{ id: string; name: string; archived_at: Date | null }>(
    await tx.execute(drizzleSql`
      SELECT id, name, archived_at FROM ${knowledgeRel("collections")}
      WHERE org_id = ${input.orgId}::uuid
        AND description = ${marker}
      LIMIT 1
    `),
  )
  if (lookup[0]) {
    // Update name + un-archive (resurrect) + reparent if any of those changed.
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("collections")}
      SET name = ${input.name},
          parent_collection_id = ${input.parentCollectionId}::uuid,
          archived_at = NULL,
          updated_at = now()
      WHERE id = ${lookup[0].id}::uuid
    `)
    return lookup[0].id
  }
  const id = randomUUID()
  await tx.execute(drizzleSql`
    INSERT INTO ${knowledgeRel("collections")}
      (id, org_id, name, description, parent_collection_id, owner_user_id, maintainer_user_ids)
    VALUES (
      ${id}::uuid,
      ${input.orgId}::uuid,
      ${input.name},
      ${marker},
      ${input.parentCollectionId}::uuid,
      ${input.ownerUserId}::uuid,
      '[]'::jsonb
    )
  `)
  return id
}

interface UpsertSyncedDocumentInput {
  source: SyncedSourceRow
  identityId: string
  title: string
  body: string
  externalPath: string
  externalRev: string | null
  lastSyncedAt: Date
}

/**
 * Upsert returns { id, bodyChanged }. Looks up active OR archived rows so
 * resurrection preserves the original id (H-4). Also updates title +
 * external_path on rename (matching is by identity, not by name).
 * `bodyChanged` also reports a reclassification, so the caller's update event
 * refreshes the search index's ACL fields.
 */
export async function upsertSyncedDocument(
  tx: PrivilegedDb,
  input: UpsertSyncedDocumentInput,
): Promise<{ id: string; bodyChanged: boolean }> {
  const { source, identityId } = input
  const safeTitle = sanitizeExternalString(input.title, TITLE_MAX)
  const safePath = sanitizeExternalString(input.externalPath, PATH_MAX)
  // Look up existing row (active OR archived).
  const existing = extractRows<{
    id: string
    body: string
    archived_at: string | null
    sensitivity: string | null
    org_access: string
  }>(
    await tx.execute(drizzleSql`
      SELECT id, body, archived_at, sensitivity, org_access FROM ${knowledgeRel("documents")}
      WHERE synced_source_id = ${source.id}::uuid
        AND source_identity_id = ${identityId}::uuid
      LIMIT 1
    `),
  )
  const lastSyncedAtIso = input.lastSyncedAt.toISOString()
  if (existing[0]) {
    const wasArchived = existing[0].archived_at != null
    const bodyChanged = existing[0].body !== input.body
    // A synced document's sharing stays editable (setDocumentSharing), so a
    // re-sync leaves org_access alone. Only a source reclassified since the
    // document was written carries its new sensitivity over, closing org-wide
    // access when it became confidential or restricted, as reclassifying a
    // document does (updateKnowledgeDocument). Lowering it opens nothing.
    const sourceSensitivity = source.ownerUserId ? null : (source.defaultSensitivity ?? "internal")
    const reclassified = !source.ownerUserId && existing[0].sensitivity !== sourceSensitivity
    const closeAccess =
      reclassified &&
      (sourceSensitivity === "confidential" || sourceSensitivity === "restricted") &&
      existing[0].org_access !== "none"
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("documents")}
      SET title = ${safeTitle},
          body = ${input.body},
          external_path = ${safePath},
          external_rev = ${input.externalRev},
          last_synced_at = ${lastSyncedAtIso}::timestamptz,
          archived_at = NULL,
          ${reclassified ? drizzleSql`sensitivity = ${sourceSensitivity},` : drizzleSql``}
          ${closeAccess ? drizzleSql`org_access = 'none',` : drizzleSql``}
          updated_at = now()
      WHERE id = ${existing[0].id}::uuid
    `)
    return { id: existing[0].id, bodyChanged: bodyChanged || wasArchived || reclassified }
  }
  const id = randomUUID()
  const documentScope = source.ownerUserId ? "personal" : "organization"
  // Org-scoped sources have no ownerUserId; the doc still needs a review owner
  // or it floods the Home attention feed with owner_missing items forever.
  const ownerUserId = source.ownerUserId ?? source.createdBy
  const sensitivity = source.ownerUserId ? null : (source.defaultSensitivity ?? "internal")
  const teamJson = "[]"
  const participantIdsJson = source.ownerUserId ? "{}" : null
  // Sensitivity drives the org-wide default, exactly as for a document created
  // in Liaison (createKnowledgeDocument): a file from a confidential or
  // restricted folder is readable only by those it is shared with, never by
  // the whole org because it arrived through a sync.
  const orgAccess =
    sensitivity === "confidential" || sensitivity === "restricted" ? "none" : "editor"
  await tx.execute(drizzleSql`
    INSERT INTO ${knowledgeRel("documents")} (
      id, org_id, title, body, document_scope, owner_user_id,
      participant_ids, team, sensitivity, org_access, created_by,
      synced_source_id, source_identity_id, external_path, external_rev,
      last_synced_at, required_scopes
    )
    VALUES (
      ${id}::uuid,
      ${source.orgId}::uuid,
      ${safeTitle},
      ${input.body},
      ${documentScope},
      ${ownerUserId}::uuid,
      ${participantIdsJson}::jsonb,
      ${teamJson}::jsonb,
      ${sensitivity},
      ${orgAccess},
      ${source.createdBy}::uuid,
      ${source.id}::uuid,
      ${identityId}::uuid,
      ${safePath},
      ${input.externalRev},
      ${lastSyncedAtIso}::timestamptz,
      -- D5: the reconciler runs OUTSIDE any turn, on content that came from an
      -- external source rather than from anything a turn read, so it asserts
      -- the empty set explicitly (the column has no default since 0065). The
      -- UPDATE branch above deliberately leaves required_scopes alone: an
      -- external refresh must never narrow a tag the document already carries.
      '{}'::text[]
    )
  `)
  // The search ACL projection (owner and creator) for the new row, as every
  // other document write point keeps it.
  await recomputeSearchAcl(tx, "knowledge.document", id)
  return { id, bodyChanged: true }
}

async function ensureCollectionMembership(
  tx: PrivilegedDb,
  orgId: string,
  collectionId: string,
  targetType: "document" | "source_link",
  targetId: string,
  createdBy: string,
): Promise<void> {
  // ID is generated client-side because the membership table is keyed by
  // (org_id, collection_id, target_type, target_id) — DO NOTHING on conflict.
  await tx.execute(drizzleSql`
    INSERT INTO ${knowledgeRel("collection_memberships")}
      (id, org_id, collection_id, target_type, target_id, created_by)
    VALUES (
      ${randomUUID()}::uuid,
      ${orgId}::uuid,
      ${collectionId}::uuid,
      ${targetType},
      ${targetId}::uuid,
      ${createdBy}::uuid
    )
    ON CONFLICT (org_id, collection_id, target_type, target_id) DO NOTHING
  `)
}

/**
 * Move a target between collections within a source — used when a Drive file
 * is moved between folders. Removes any membership rows for this target
 * within this source that don't match the new parent, then inserts the new
 * one (idempotent via the ON CONFLICT in ensureCollectionMembership).
 */
export async function reparentMembership(
  tx: PrivilegedDb,
  orgId: string,
  sourceId: string,
  targetType: "document" | "source_link",
  targetId: string,
  newCollectionId: string,
  createdBy: string,
): Promise<void> {
  // Remove memberships in OTHER synced collections of THIS source. We scope
  // the delete to collections owned by this source (via the description
  // marker prefix) so we never touch user-created memberships of the same
  // target outside the source's tree.
  await tx.execute(drizzleSql`
    DELETE FROM ${knowledgeRel("collection_memberships")} AS cm
    USING ${knowledgeRel("collections")} AS c
    WHERE cm.collection_id = c.id
      AND cm.org_id = ${orgId}::uuid
      AND cm.target_type = ${targetType}
      AND cm.target_id = ${targetId}::uuid
      AND c.id <> ${newCollectionId}::uuid
      AND (c.description LIKE ${`synced:${sourceId}:%`} OR c.id IN (
        SELECT root_collection_id FROM ${knowledgeRel("synced_sources")}
        WHERE id = ${sourceId}::uuid
      ))
  `)
  await ensureCollectionMembership(tx, orgId, newCollectionId, targetType, targetId, createdBy)
}

// Sentinel UUID — appended to every keep list so the same `NOT IN (...)` SQL
// works whether the upstream listing was non-empty or completely vanished
// (an empty `IN ()` is a Postgres syntax error). The sentinel can never match
// a real `gen_random_uuid()` row, so `NOT IN (sentinel)` archives everything.
const KEEP_SENTINEL = "00000000-0000-0000-0000-000000000000"

function keepListSql(ids: string[]) {
  return drizzleSql.join(
    [...ids, KEEP_SENTINEL].map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`,`,
  )
}

async function archiveDocumentsNotIn(
  tx: PrivilegedDb,
  sourceId: string,
  keepIdentityIds: string[],
): Promise<string[]> {
  const r = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("documents")}
      SET archived_at = now(), updated_at = now()
      WHERE synced_source_id = ${sourceId}::uuid
        AND archived_at IS NULL
        AND source_identity_id NOT IN (${keepListSql(keepIdentityIds)})
      RETURNING id
    `),
  )
  return r.map((row) => row.id)
}

/**
 * I2: archive source_links materialized from this source whose upstream
 * identity is no longer present.
 */
async function archiveSourceLinksNotIn(
  tx: PrivilegedDb,
  sourceId: string,
  appName: string,
  orgId: string,
  keepIdentityIds: string[],
): Promise<string[]> {
  // Scope archival to THIS synced source's own links via synced_source_id.
  // Links from other synced sources that share the same `source` app name, and
  // manual links (synced_source_id IS NULL, e.g. linkRemoteDocument), are never
  // touched — so reconciling one source can't archive another's links. The
  // `synced_source_id = sourceId` predicate also implicitly excludes NULL rows
  // and proves the source still exists, so the old EXISTS/identity-subquery
  // scoping is no longer needed. `source = appName` is kept as defense-in-depth.
  const r = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("source_links")} AS sl
      SET archived_at = now(), updated_at = now()
      WHERE sl.org_id = ${orgId}::uuid
        AND sl.synced_source_id = ${sourceId}::uuid
        AND sl.source = ${appName}
        AND sl.archived_at IS NULL
        AND sl.source_identity_id NOT IN (${keepListSql(keepIdentityIds)})
      RETURNING sl.id
    `),
  )
  return r.map((row) => row.id)
}

/**
 * I2: archive subcollections this source created whose upstream folder is no
 * longer present. Identified by the `synced:<sourceId>:%` description marker;
 * the root collection is NEVER archived here (it's the source's mount point).
 */
async function archiveCollectionsNotIn(
  tx: PrivilegedDb,
  sourceId: string,
  orgId: string,
  rootCollectionId: string,
  keepCollectionIds: string[],
): Promise<number> {
  const markerPrefix = `synced:${sourceId}:%`
  const r = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("collections")}
      SET archived_at = now(), updated_at = now()
      WHERE org_id = ${orgId}::uuid
        AND id <> ${rootCollectionId}::uuid
        AND description LIKE ${markerPrefix}
        AND archived_at IS NULL
        AND id NOT IN (${keepListSql(keepCollectionIds)})
      RETURNING id
    `),
  )
  return r.length
}

/**
 * What an ok sync says about the files it could not import (no text form), or
 * null when it imported every file: kept on `last_error` while the status
 * stays ok, so the source, its card and the agent name them.
 */
export function skippedNote(skipped: ReconcileStats["skipped"]): string | null {
  if (skipped.length === 0) return null
  const named = skipped
    .slice(0, 5)
    .map((f) => `${f.name} (${f.mimeType ?? "unknown type"})`)
    .join("; ")
  const more = skipped.length > 5 ? ` and ${skipped.length - 5} more` : ""
  return `Not imported, no text form: ${named}${more}`.slice(0, 500)
}

/**
 * Reconcile a single synced source. Caller is responsible for ensuring this
 * runs serially per source (the BullMQ jobId dedup in Task 6 does this).
 */
export async function reconcileSyncedSource(
  source: SyncedSourceRow,
  adapter: KnowledgeSourceAdapter,
): Promise<ReconcileStats> {
  if (!adapter.listFolder) {
    throw new KnowledgeError("VALIDATION", `${adapter.source} adapter lacks listFolder`)
  }

  // Stamp 'running' before Phase A so the next scheduler tick won't re-pick
  // this source.
  await withPrivilegedDb(source.orgId, "knowledge-sync-start", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("synced_sources")}
      SET last_sync_status = 'running', updated_at = now()
      WHERE id = ${source.id}::uuid
    `)
  })

  const stats: ReconcileStats = {
    documentsUpserted: 0,
    sourceLinksUpserted: 0,
    collectionsUpserted: 0,
    documentsArchived: 0,
    sourceLinksArchived: 0,
    collectionsArchived: 0,
    fetchErrors: [],
    paginationCapped: [],
    skipped: [],
    status: "ok",
  }

  try {
    const actor = systemSyncActor(source)
    // ── Phase A: walk + fetch (no DB tx open) ─────────────────────────────
    const tree = await walkFolder(adapter, source.folderRef, actor, stats.paginationCapped)
    const fetchedByExternalId = new Map<string, string>()
    for (const file of tree) {
      if (file.kind !== "file" || !importsAsDocument(adapter, file.mimeType)) continue
      if (!adapter.fetchRemoteContent) continue
      try {
        const r = await adapter.fetchRemoteContent(
          { sourceEntityId: file.externalId },
          actor,
          "sync",
        )
        if ((r.status === "ok" || r.status === "available") && r.text != null) {
          fetchedByExternalId.set(file.externalId, r.text)
        } else {
          stats.fetchErrors.push({
            externalId: file.externalId,
            error: r.status ?? "no-text",
          })
        }
      } catch (err) {
        stats.fetchErrors.push({
          externalId: file.externalId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // ── Phase B: single txn for all writes + events ───────────────────────
    await withPrivilegedDb(source.orgId, "knowledge-sync-reconcile", async (tx) => {
      const collectionByExternalId = new Map<string, string>()
      collectionByExternalId.set(source.folderRef, source.rootCollectionId)

      // pass 1: collections in BFS order (parents before children).
      const folders = tree.filter((i) => i.kind === "folder").sort((a, b) => a.depth - b.depth)
      for (const folder of folders) {
        const parentColId =
          collectionByExternalId.get(folder.parentExternalId) ?? source.rootCollectionId
        const colId = await upsertSyncedCollection(tx, collectionByExternalId, {
          sourceId: source.id,
          orgId: source.orgId,
          externalId: folder.externalId,
          name: sanitizeExternalString(folder.name, TITLE_MAX),
          parentCollectionId: parentColId,
          ownerUserId: source.ownerUserId,
        })
        collectionByExternalId.set(folder.externalId, colId)
        stats.collectionsUpserted += 1
      }

      // pass 2: files.
      const lastSyncedAt = new Date()
      const seenIdentityIds: string[] = []
      const files = tree.filter((i) => i.kind === "file")
      for (const file of files) {
        const identityId = await upsertSourceIdentity(tx, source.orgId, source.appName, file)
        seenIdentityIds.push(identityId)
        const parentColId =
          collectionByExternalId.get(file.parentExternalId) ?? source.rootCollectionId

        if (importsAsDocument(adapter, file.mimeType)) {
          const body = fetchedByExternalId.get(file.externalId)
          if (body == null) continue // fetch failed in Phase A; tracked in fetchErrors
          const { id: docId, bodyChanged } = await upsertSyncedDocument(tx, {
            source,
            identityId,
            title: file.name,
            body,
            externalPath: file.name,
            externalRev: file.etag ?? file.modifiedAt ?? null,
            lastSyncedAt,
          })
          await reparentMembership(
            tx,
            source.orgId,
            source.id,
            "document",
            docId,
            parentColId,
            source.createdBy,
          )
          stats.documentsUpserted += 1
          // A file that became a document (a Google Doc or Sheet that an
          // older release kept as a link) keeps no link beside it.
          await tx.execute(drizzleSql`
            UPDATE ${knowledgeRel("source_links")}
            SET archived_at = now(), updated_at = now()
            WHERE org_id = ${source.orgId}::uuid
              AND synced_source_id = ${source.id}::uuid
              AND source_identity_id = ${identityId}::uuid
              AND archived_at IS NULL
          `)
          if (bodyChanged) {
            await tx.queueEvent({
              app: "knowledge",
              entity: "document",
              action: "update",
              entityId: docId,
              data: {
                syncedSourceId: source.id,
                externalRev: file.etag ?? file.modifiedAt ?? null,
                lastSyncAt: lastSyncedAt.toISOString(),
              },
              actorId: source.createdBy,
              actorType: "system",
              orgId: source.orgId,
            })
          }
        } else if (!source.ownerUserId) {
          // Org sources only: materialize non-text files as source_links.
          await tx.execute(drizzleSql`
            INSERT INTO ${knowledgeRel("source_links")}
              (id, org_id, synced_source_id, source_identity_id, source, external_id, title, url, mime_type)
            VALUES (
              ${randomUUID()}::uuid,
              ${source.orgId}::uuid,
              ${source.id}::uuid,
              ${identityId}::uuid,
              ${source.appName},
              ${file.externalId},
              ${sanitizeExternalString(file.name, TITLE_MAX)},
              ${file.url ?? null},
              ${file.mimeType ?? null}
            )
            ON CONFLICT (org_id, source_identity_id) WHERE archived_at IS NULL
            DO UPDATE SET
              synced_source_id = EXCLUDED.synced_source_id,
              title = EXCLUDED.title,
              url = EXCLUDED.url,
              archived_at = NULL,
              updated_at = now()
          `)
          const linkRows = extractRows<{ id: string }>(
            await tx.execute(drizzleSql`
              SELECT id FROM ${knowledgeRel("source_links")}
              WHERE org_id = ${source.orgId}::uuid
                AND source_identity_id = ${identityId}::uuid
                AND archived_at IS NULL
              LIMIT 1
            `),
          )
          if (linkRows[0]) {
            await reparentMembership(
              tx,
              source.orgId,
              source.id,
              "source_link",
              linkRows[0].id,
              parentColId,
              source.createdBy,
            )
          }
          stats.sourceLinksUpserted += 1
        } else {
          stats.skipped.push({
            name: sanitizeExternalString(file.name, TITLE_MAX),
            mimeType: file.mimeType ?? null,
          })
        }
      }

      // pass 3: archive disappeared items (I2).
      const archivedDocIds = await archiveDocumentsNotIn(tx, source.id, seenIdentityIds)
      const archivedLinkIds = await archiveSourceLinksNotIn(
        tx,
        source.id,
        source.appName,
        source.orgId,
        seenIdentityIds,
      )
      stats.documentsArchived = archivedDocIds.length
      stats.sourceLinksArchived = archivedLinkIds.length
      // Emit the same `archive` event a user archive does, so the search
      // indexer drops these rows. A bare UPDATE left them searchable until
      // the next full reindex (and returned not_found when opened).
      for (const [entity, ids] of [
        ["document", archivedDocIds],
        ["source_link", archivedLinkIds],
      ] as const) {
        for (const id of ids) {
          await tx.queueEvent({
            app: "knowledge",
            entity,
            action: "archive",
            entityId: id,
            data: { id, syncedSourceId: source.id },
            actorId: source.createdBy,
            actorType: "system",
            orgId: source.orgId,
          })
        }
      }
      stats.collectionsArchived = await archiveCollectionsNotIn(
        tx,
        source.id,
        source.orgId,
        source.rootCollectionId,
        [...collectionByExternalId.values()],
      )

      stats.status =
        stats.fetchErrors.length === 0 && stats.paginationCapped.length === 0 ? "ok" : "error"
      const lastError =
        stats.status === "ok"
          ? skippedNote(stats.skipped)
          : [
              stats.fetchErrors.length > 0
                ? `${stats.fetchErrors.length} file(s) failed: ${stats.fetchErrors
                    .slice(0, 3)
                    .map((e) => `${e.externalId}:${e.error}`)
                    .join("; ")}`
                : null,
              stats.paginationCapped.length > 0
                ? `${stats.paginationCapped.length} folder(s) hit pagination cap (${MAX_PAGES_PER_FOLDER} pages)`
                : null,
            ]
              .filter(Boolean)
              .join(" | ")
              .slice(0, 500)
      await tx.execute(drizzleSql`
        UPDATE ${knowledgeRel("synced_sources")}
        SET last_sync_at = now(),
            last_sync_status = ${stats.status},
            last_error = ${lastError},
            updated_at = now()
        WHERE id = ${source.id}::uuid
      `)
    })
  } catch (err) {
    // Phase A or B blew up — stamp error + re-throw. The next tick retries
    // AFTER the source's own interval.
    //
    // `last_sync_at = now()` is the load-bearing part: the due query selects
    // `status IN ('idle','ok','error') AND last_sync_at + interval < now()`, so
    // leaving the timestamp untouched on failure left the row permanently due
    // and re-enqueued it on EVERY scheduler tick (~1/min). With a permanent
    // failure (a revoked GitLab token, prod 2026-07-31) that became a hot retry
    // loop: three sources hammering the API and ~12 error logs/min, tripping the
    // watchdog's >10/min error-rate-spike continuously for days. An ATTEMPT now
    // advances the clock whether or not it succeeded. Cost: a transient failure
    // waits one interval instead of one minute — the right trade for a KB sync,
    // and the only thing that bounds a permanent one.
    const lastError = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)
    await withPrivilegedDb(source.orgId, "knowledge-sync-err", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE ${knowledgeRel("synced_sources")}
        SET last_sync_at = now(),
            last_sync_status = 'error',
            last_error = ${lastError},
            updated_at = now()
        WHERE id = ${source.id}::uuid
      `)
    })
    throw err
  }

  return stats
}
