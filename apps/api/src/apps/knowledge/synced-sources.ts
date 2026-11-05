// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * synced-sources.ts — CRUD service for `app_knowledge.synced_sources`.
 *
 * A synced source mounts an external folder tree (Drive, GitHub, ...) into the
 * Knowledge workspace. Each source owns a root collection (auto-created on
 * INSERT) and a sync cadence. The reconciler in `sync-reconciler.ts` walks
 * the source's `adapter.listFolder()` tree on every tick (or on-demand from
 * the document-open hook) and upserts documents + source_links.
 */
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { type KnowledgeActor, KnowledgeError } from "~/apps/knowledge/service"
import type { KnowledgeSourceAdapter } from "~/apps/knowledge/source-protocol"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { boundedBy } from "~/lib/bounded"
import { hasScope } from "~/modules/permissions/permissions"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyncedSourceScope = "personal" | "organization"
export type SyncedSourceStatus = "idle" | "running" | "ok" | "error"

export interface SyncedSourceRow {
  id: string
  orgId: string
  appName: string
  folderRef: string
  displayName: string
  rootCollectionId: string
  ownerUserId: string | null
  /** The provider account (connection identifier) the folder syncs from, when recorded. */
  sourceAccount: string | null
  defaultSensitivity: string | null
  syncIntervalSeconds: number
  lastSyncAt: string | null
  lastSyncStatus: SyncedSourceStatus
  lastError: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface SyncedSourceDbRow {
  id: string
  org_id: string
  app_name: string
  folder_ref: string
  display_name: string
  root_collection_id: string
  owner_user_id: string | null
  source_account?: string | null
  default_sensitivity: string | null
  sync_interval_seconds: number
  last_sync_at: Date | string | null
  last_sync_status: SyncedSourceStatus
  last_error: string | null
  created_by: string
  created_at: Date | string
  updated_at: Date | string
  archived_at: Date | string | null
}

export interface CreateSyncedSourceInput {
  appName: string
  folderRef: string
  displayName: string
  syncIntervalSeconds: number
  scope: SyncedSourceScope
  defaultSensitivity?: string | null
}

export interface UpdateSyncedSourceInput {
  displayName?: string
  syncIntervalSeconds?: number
}

export interface CreateSyncedSourceOptions {
  /** Inject an adapter directly (tests, retry paths). */
  adapter?: KnowledgeSourceAdapter
  /**
   * Skip the listFolder precheck. **Test-only seam** — routes must always
   * pass a valid adapter and let `createSyncedSource` exercise the precheck
   * (see I1). Production code paths must never set this; if a callsite
   * thinks it needs to, fix the upstream registration instead.
   */
  skipPrecheck?: boolean
}

export const MIN_INTERVAL_SECONDS = 60

const toIso = (v: Date | string | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : v

const toIsoNonNull = (v: Date | string): string => (v instanceof Date ? v.toISOString() : v)

export function rowFromDb(r: SyncedSourceDbRow): SyncedSourceRow {
  return {
    id: r.id,
    orgId: r.org_id,
    appName: r.app_name,
    folderRef: r.folder_ref,
    displayName: r.display_name,
    rootCollectionId: r.root_collection_id,
    ownerUserId: r.owner_user_id,
    sourceAccount: r.source_account ?? null,
    defaultSensitivity: r.default_sensitivity,
    syncIntervalSeconds: r.sync_interval_seconds,
    lastSyncAt: toIso(r.last_sync_at),
    lastSyncStatus: r.last_sync_status,
    lastError: r.last_error,
    createdBy: r.created_by,
    createdAt: toIsoNonNull(r.created_at),
    updatedAt: toIsoNonNull(r.updated_at),
    archivedAt: toIso(r.archived_at),
  }
}

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

function requireSourcesManage(actor: KnowledgeActor): void {
  if (
    !hasScope("knowledge:sources:manage", actor.scopes) &&
    !hasScope("knowledge:documents:admin", actor.scopes)
  ) {
    throw new KnowledgeError("FORBIDDEN", "Missing knowledge:sources:manage")
  }
}

/**
 * Personal-source minimum scope. Mirrors the RLS WITH CHECK policy at
 * `0002_knowledge_synced_sources.sql:117-130` so that the privileged-DB write
 * path inside `createSyncedSource` still enforces an app-layer floor.
 *
 * Without this, an authenticated user holding zero `knowledge:*` scopes could
 * mount a personal synced source — `withPrivilegedDb` bypasses the RLS policy
 * entirely.
 */
function requireKnowledgeReader(actor: KnowledgeActor): void {
  if (
    !hasScope("knowledge:documents:read", actor.scopes) &&
    !hasScope("knowledge:documents:admin", actor.scopes)
  ) {
    throw new KnowledgeError("FORBIDDEN", "Missing knowledge:documents:read")
  }
}

/**
 * Authorization check for forcing an immediate sync on a row the caller
 * already loaded (and therefore can see). Personal sources may only be
 * force-synced by their owner; org-shared sources require `sources:manage`.
 *
 * Shared by route + worker paths (defense in depth) — the route uses this to
 * pre-flight before enqueue; the worker re-verifies after job dispatch.
 */
export function assertCanForceSyncedSource(source: SyncedSourceRow, actor: KnowledgeActor): void {
  if (source.ownerUserId == null) {
    // Org-shared: any reader can force-refresh — matches the GET-document
    // force-on-open behaviour where every reader can trigger a sync of an
    // org-shared synced doc they can see.
    return
  }
  if (source.ownerUserId !== actor.userId) {
    throw new KnowledgeError("FORBIDDEN", "Not the owner of this personal source")
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadSyncedSource(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<SyncedSourceRow | null> {
  const rows = extractRows<SyncedSourceDbRow>(
    await tx.execute(drizzleSql`
      SELECT * FROM ${knowledgeRel("synced_sources")}
      WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
      LIMIT 1
    `),
  )
  return rows[0] ? rowFromDb(rows[0]) : null
}

/**
 * List visible synced sources for the actor. Returns:
 *   - all org-shared sources (owner_user_id IS NULL)
 *   - the actor's personal sources (owner_user_id = actor.userId)
 *
 * Archived rows are excluded.
 */
export async function listSyncedSources(
  tx: RlsClient,
  actor: KnowledgeActor,
): Promise<SyncedSourceRow[]> {
  const rows = extractRows<SyncedSourceDbRow>(
    await tx.execute(drizzleSql`
      SELECT * FROM ${knowledgeRel("synced_sources")}
      WHERE org_id = ${actor.orgId}::uuid
        AND archived_at IS NULL
        AND (owner_user_id IS NULL OR owner_user_id = ${actor.userId}::uuid)
      ORDER BY display_name ASC
    `),
  )
  return rows.map(rowFromDb)
}

/**
 * Find a synced source (active OR archived) for a given app + folder ref. Used
 * by the agent `add_folder_source` tool so a repeated one-shot harvest of the
 * SAME folder reuses (and reactivates) the existing source row rather than
 * creating a parallel one — which keeps the reconciler's in-source document
 * dedupe effective (the doc lookup is scoped to `synced_source_id`, so a fresh
 * source id would re-materialize every file as a duplicate). Includes archived
 * rows because one-shot harvest archives the source after import.
 */
export async function findSyncedSourceByFolder(
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  appName: string,
  folderRef: string,
): Promise<SyncedSourceRow | null> {
  const rows = extractRows<SyncedSourceDbRow>(
    await tx.execute(drizzleSql`
      SELECT * FROM ${knowledgeRel("synced_sources")}
      WHERE org_id = ${orgId}::uuid
        AND app_name = ${appName}
        AND folder_ref = ${folderRef}
      ORDER BY created_at DESC
      LIMIT 1
    `),
  )
  return rows[0] ? rowFromDb(rows[0]) : null
}

/**
 * Clear the `archived_at` marker on a synced source (reactivate). Paired with
 * {@link findSyncedSourceByFolder} for the re-ingest path.
 *
 * Runs in its OWN committed privileged transaction (not the caller's request
 * tx) on purpose: the very next step in the re-ingest path is
 * `reconcileSyncedSource`, which opens a separate privileged tx to stamp
 * `last_sync_status='running'` on the SAME row. If this UPDATE were left
 * uncommitted in the caller's still-open RLS tx, the reconcile's privileged tx
 * would block on the row lock while the RLS tx waits for the reconcile to
 * finish — a deadlock. Committing here releases the lock before reconcile runs.
 */
export async function reactivateSyncedSource(orgId: string, id: string): Promise<void> {
  await withPrivilegedDb(orgId, "knowledge-reactivate-synced-source", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("synced_sources")}
      SET archived_at = NULL, last_sync_status = 'idle', updated_at = now()
      WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid
    `)
  })
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a synced source row + its root collection.
 *
 * The `tx` parameter is accepted for call-site symmetry with the other CRUD
 * functions in this module, but is intentionally **discarded** inside: the
 * function opens its own privileged transaction so it can bypass RLS WITH
 * CHECK for the collection insert (collections RLS would otherwise reject
 * the INSERT for callers without `knowledge:collections:manage`). App-layer
 * scope checks (`requireSourcesManage` / `requireKnowledgeReader`, C2) run
 * before that privileged tx opens, so the bypass cannot escalate scopes.
 *
 * Routes still wrap the call in `withRequestRls` so the surrounding
 * registry/adapter lookups share a request tx; the create itself does not
 * participate in that tx.
 */
/**
 * `_tx` is intentionally unused — the body opens its own `withPrivilegedDb`
 * for the permission-checked insert. The parameter remains in the public
 * signature so call sites must hold *some* request-scoped DB handle before
 * invoking the service (a discipline marker, not a runtime dependency).
 * Accepts either branded handle: routes pass the RLS-scoped tx; background
 * workers and integration-test setup paths pass the privileged tx.
 */
/**
 * The Drive account a new folder syncs from: the creator's newest active Drive
 * connection (the one the sync's token lookup resolves), recorded so that
 * disconnecting that account deletes this folder's content and no other's.
 * Other sources record nothing.
 */
function sourceAccountSql(appName: string, orgId: string, userId: string) {
  if (appName !== "google-drive") return drizzleSql`NULL`
  return drizzleSql`(
    SELECT identifier FROM ${drizzleSql.raw(schemaRef("kernel"))}.connected_accounts
    WHERE org_id = ${orgId}::uuid AND app_name = 'google-drive' AND status = 'active'
      AND ((owner_type = 'user' AND owner_id = ${userId}::uuid) OR owner_type = 'org')
    ORDER BY (owner_type = 'user') DESC, updated_at DESC, created_at DESC
    LIMIT 1
  )`
}

export async function createSyncedSource(
  _tx: RlsClient | PrivilegedDb,
  input: CreateSyncedSourceInput,
  actor: KnowledgeActor,
  opts: CreateSyncedSourceOptions = {},
): Promise<SyncedSourceRow> {
  // Validation
  if (input.syncIntervalSeconds < MIN_INTERVAL_SECONDS) {
    throw new KnowledgeError("VALIDATION", `sync interval must be >= ${MIN_INTERVAL_SECONDS}s`)
  }
  if (input.scope === "organization") {
    requireSourcesManage(actor)
    if (!input.defaultSensitivity) {
      throw new KnowledgeError(
        "VALIDATION",
        "defaultSensitivity is required for organization scope",
      )
    }
  } else {
    // C2: personal scope must still hold the base Knowledge reader scope; the
    // privileged-DB write below would otherwise bypass the RLS WITH CHECK that
    // enforces this invariant.
    requireKnowledgeReader(actor)
    if (input.defaultSensitivity != null) {
      throw new KnowledgeError("VALIDATION", "defaultSensitivity must be null for personal sources")
    }
  }

  // H5: folder-read precheck. We refuse to persist a source row pointing at a
  // folder the caller cannot read. Mirrors the source-links create path.
  // M-minor: wrap the network call in a 5-second timeout so a hung Drive
  // call doesn't block the HTTP request indefinitely.
  if (!opts.skipPrecheck) {
    const adapter = opts.adapter
    if (!adapter) {
      throw new KnowledgeError("VALIDATION", `no adapter registered for app ${input.appName}`)
    }
    if (!adapter.listFolder) {
      throw new KnowledgeError("VALIDATION", `${input.appName} is not a folder source`)
    }
    try {
      await boundedBy(
        adapter.listFolder({ folderRef: input.folderRef }, actor),
        5_000,
        () => new Error(`Folder-read precheck timed out after 5s for ${input.appName}`),
      )
    } catch (err) {
      throw new KnowledgeError(
        "FORBIDDEN",
        `Cannot read folder: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const ownerUserId = input.scope === "personal" ? actor.userId : null

  // Both writes (root collection + synced_sources row) happen inside one
  // privileged transaction. We've already enforced the actor-level
  // authorization above; bypassing RLS here lets a personal source create
  // its own personal-owned root collection without granting the actor
  // `knowledge:collections:manage` (collections RLS would otherwise reject
  // the INSERT for ordinary readers).
  return withPrivilegedDb(actor.orgId, "knowledge-create-synced-source", async (tx) => {
    return doCreateSyncedSource(tx, input, actor, ownerUserId)
  })
}

async function doCreateSyncedSource(
  tx: PrivilegedDb,
  input: CreateSyncedSourceInput,
  actor: KnowledgeActor,
  ownerUserId: string | null,
): Promise<SyncedSourceRow> {
  const collectionId = randomUUID()
  await tx.execute(drizzleSql`
    INSERT INTO ${knowledgeRel("collections")}
      (id, org_id, name, description, parent_collection_id, owner_user_id, maintainer_user_ids)
    VALUES (
      ${collectionId}::uuid,
      ${actor.orgId}::uuid,
      ${input.displayName},
      ${`Synced from ${input.appName}`},
      NULL,
      ${ownerUserId}::uuid,
      '[]'::jsonb
    )
  `)

  const id = randomUUID()
  const rows = extractRows<SyncedSourceDbRow>(
    await tx.execute(drizzleSql`
      INSERT INTO ${knowledgeRel("synced_sources")} (
        id, org_id, app_name, folder_ref, display_name, root_collection_id,
        owner_user_id, default_sensitivity, sync_interval_seconds, created_by, source_account
      )
      VALUES (
        ${id}::uuid,
        ${actor.orgId}::uuid,
        ${input.appName},
        ${input.folderRef},
        ${input.displayName},
        ${collectionId}::uuid,
        ${ownerUserId}::uuid,
        ${input.defaultSensitivity ?? null},
        ${input.syncIntervalSeconds},
        ${actor.userId}::uuid,
        ${sourceAccountSql(input.appName, actor.orgId, actor.userId)}
      )
      RETURNING *
    `),
  )

  await tx.queueEvent({
    app: "knowledge",
    entity: "synced_source",
    action: "create",
    entityId: id,
    data: {
      id,
      appName: input.appName,
      displayName: input.displayName,
      scope: input.scope,
    },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })

  if (!rows[0]) {
    throw new KnowledgeError("NOT_FOUND", "Synced source not found after insert")
  }
  return rowFromDb(rows[0])
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateSyncedSource(
  tx: RlsClient,
  id: string,
  patch: UpdateSyncedSourceInput,
  actor: KnowledgeActor,
): Promise<SyncedSourceRow> {
  const existing = await loadSyncedSource(tx, id, actor)
  if (!existing) throw new KnowledgeError("NOT_FOUND", "Synced source not found")
  if (existing.ownerUserId == null) {
    // Org-shared: needs manage scope to edit.
    requireSourcesManage(actor)
  } else if (existing.ownerUserId !== actor.userId) {
    throw new KnowledgeError("FORBIDDEN", "Not the owner of this personal source")
  }

  const sets: ReturnType<typeof drizzleSql>[] = []
  if (patch.displayName !== undefined) {
    const name = patch.displayName.trim()
    if (!name) throw new KnowledgeError("VALIDATION", "displayName cannot be empty")
    sets.push(drizzleSql`display_name = ${name}`)
  }
  if (patch.syncIntervalSeconds !== undefined) {
    if (patch.syncIntervalSeconds < MIN_INTERVAL_SECONDS) {
      throw new KnowledgeError("VALIDATION", `sync interval must be >= ${MIN_INTERVAL_SECONDS}s`)
    }
    sets.push(drizzleSql`sync_interval_seconds = ${patch.syncIntervalSeconds}`)
  }
  if (sets.length === 0) return existing

  sets.push(drizzleSql`updated_at = now()`)

  await tx.execute(drizzleSql`
    UPDATE ${knowledgeRel("synced_sources")}
    SET ${drizzleSql.join(sets, drizzleSql`, `)}
    WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
  `)

  await tx.queueEvent({
    app: "knowledge",
    entity: "synced_source",
    action: "update",
    entityId: id,
    data: { id },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })

  const row = await loadSyncedSource(tx, id, actor)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Synced source not found after update")
  return row
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

export async function archiveSyncedSource(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<void> {
  const existing = await loadSyncedSource(tx, id, actor)
  if (!existing) throw new KnowledgeError("NOT_FOUND", "Synced source not found")
  if (existing.ownerUserId == null) {
    requireSourcesManage(actor)
  } else if (existing.ownerUserId !== actor.userId) {
    throw new KnowledgeError("FORBIDDEN", "Not the owner of this personal source")
  }

  await tx.execute(drizzleSql`
    UPDATE ${knowledgeRel("synced_sources")}
    SET archived_at = now(), updated_at = now()
    WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
  `)

  await tx.queueEvent({
    app: "knowledge",
    entity: "synced_source",
    action: "archive",
    entityId: id,
    data: { id },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })
}

// M7 cleanup: the previous RLS-scoped `fetchDueSyncedSources` lived here and
// was unreachable (the scheduler runs under `withSystemDb`, not under request
// RLS). The privileged variant `fetchDueSyncedSourcesSystem` in
// `knowledge-jobs.ts` is the one actually used. Removing the RLS shadow
// avoids the trap of a future route caller importing it and silently missing
// rows due to RLS.
