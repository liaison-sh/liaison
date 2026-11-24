// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  assertCanReadDocumentRow,
  assertCanWriteDocumentRow,
  inNoVisibleFolder,
  type KnowledgeActor,
  KnowledgeError,
  loadDocumentShareRole,
  loadKnowledgeDocument,
  onlyMine,
} from "~/apps/knowledge/service"
import { extractRows, type RlsClient } from "~/db"
import { isUuid } from "~/lib/uuid"
import { hasScope } from "~/modules/permissions/permissions"

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * The person may not manage folders at all. Its own class so a folder route can
 * answer 403 with the reason: it says nothing about any one folder or page.
 */
export class FolderScopeError extends KnowledgeError {
  constructor() {
    super("FORBIDDEN", "Forbidden: you cannot manage Knowledge folders")
  }
}

export function requireCollectionsScope(actor: KnowledgeActor): void {
  if (
    !hasScope("knowledge:collections:manage", actor.scopes) &&
    !hasScope("knowledge:documents:admin", actor.scopes)
  ) {
    throw new FolderScopeError()
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Who a folder change concerns, carried instead of what it says: no name leaves
 * the row. `orgWide` is a shared folder, `userIds` the owner of a personal one,
 * `wasOrgWide` a folder (or page place) others saw until this change. Sockets
 * deliver by it (websocket.ts), the audit log drops it.
 */
export function folderAudience(folder: Pick<KnowledgeCollectionRow, "ownerUserId">): {
  orgWide: boolean
  userIds: string[]
} {
  return folder.ownerUserId === null
    ? { orgWide: true, userIds: [] }
    : { orgWide: false, userIds: [folder.ownerUserId] }
}

async function queueFolderEvent(
  tx: RlsClient,
  action: "create" | "update" | "archive",
  row: Pick<KnowledgeCollectionRow, "id" | "ownerUserId">,
  before: Pick<KnowledgeCollectionRow, "ownerUserId">,
  actor: KnowledgeActor,
): Promise<void> {
  await tx.queueEvent({
    app: "knowledge",
    entity: "collection",
    action,
    entityId: row.id,
    data: {
      id: row.id,
      ...folderAudience(row),
      wasOrgWide: before.ownerUserId === null,
    },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface CollectionDbRow {
  id: string
  org_id: string
  name: string
  description: string | null
  parent_collection_id: string | null
  owner_user_id: string | null
  maintainer_user_ids: string[] | null
  archived_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

export interface KnowledgeCollectionRow {
  id: string
  orgId: string
  name: string
  description: string | null
  parentCollectionId: string | null
  ownerUserId: string | null
  maintainerUserIds: string[]
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}

function toIsoNonNull(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function rowFromDb(r: CollectionDbRow): KnowledgeCollectionRow {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    description: r.description,
    parentCollectionId: r.parent_collection_id,
    ownerUserId: r.owner_user_id,
    maintainerUserIds: r.maintainer_user_ids ?? [],
    archivedAt: toIso(r.archived_at),
    createdAt: toIsoNonNull(r.created_at),
    updatedAt: toIsoNonNull(r.updated_at),
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface KnowledgeCollectionInput {
  name: string
  description?: string | null
  parentCollectionId?: string | null
  ownerUserId?: string | null
  maintainerUserIds?: string[]
}

export interface CollectionMembershipInput {
  collectionId: string
  targetType: "document" | "source_link"
  targetId: string
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

export async function loadCollection(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<KnowledgeCollectionRow | null> {
  // Not a uuid (an agent passing "none" or a collection NAME) cannot match a
  // row: answer "not found" instead of letting the ::uuid cast raise 22P02,
  // which aborts the transaction and surfaces as a DB error.
  if (!isUuid(id)) return null
  const rows = extractRows<CollectionDbRow>(
    await tx.execute(drizzleSql`
      SELECT * FROM ${knowledgeRel("collections")}
      WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
        AND ${ownOrShared(actor)}
      LIMIT 1
    `),
  )
  return rows[0] ? rowFromDb(rows[0]) : null
}

/**
 * Row security already hides another person's personal folder; restated here so
 * a privileged caller (an import) reads the same folders its person does.
 */
function ownOrShared(actor: KnowledgeActor) {
  return drizzleSql`(owner_user_id IS NULL OR owner_user_id::text = ${actor.userId})`
}

/** A live folder the person sees, or NOT_FOUND. */
async function loadLiveCollection(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<KnowledgeCollectionRow> {
  const row = await loadCollection(tx, id, actor)
  if (!row || row.archivedAt) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
  return row
}

/** The description the sync gives a folder it made (syncedCollectionMarker, sync-reconciler.ts). */
const SYNCED_MARKER = "^synced:[0-9a-fA-F-]{36}:"

/** Whether the folder is the root of a synced source, or anywhere under one. */
export async function isSynced(tx: RlsClient, folderId: string): Promise<boolean> {
  const rows = extractRows(
    await tx.execute(drizzleSql`
      WITH RECURSIVE up AS (
        SELECT c.id, c.parent_collection_id, c.description
          FROM ${knowledgeRel("collections")} c WHERE c.id = ${folderId}::uuid
        UNION
        SELECT c.id, c.parent_collection_id, c.description
          FROM ${knowledgeRel("collections")} c JOIN up ON c.id = up.parent_collection_id
      )
      SELECT 1 FROM up
      WHERE up.description ~ ${SYNCED_MARKER}
         OR EXISTS (
           SELECT 1 FROM ${knowledgeRel("synced_sources")} s
           WHERE s.root_collection_id = up.id AND s.archived_at IS NULL
         )
      LIMIT 1
    `),
  )
  return rows.length > 0
}

/**
 * Only the sync writes in a synced tree: a person renaming, moving, hiding or
 * emptying part of it would be undone by the next run, or would take the
 * organization's content away from everybody.
 */
export async function assertNotSynced(tx: RlsClient, folderId: string): Promise<void> {
  if (await isSynced(tx, folderId)) {
    throw new KnowledgeError(
      "VALIDATION",
      "This folder is synced from another app. Change it there, or stop the sync first.",
    )
  }
}

/** Refuse to change who sees a tree that holds a synced folder. */
async function assertHoldsNoSynced(tx: RlsClient, folderId: string): Promise<void> {
  const rows = extractRows(
    await tx.execute(drizzleSql`
      WITH RECURSIVE tree AS (
        SELECT c.id, c.description
          FROM ${knowledgeRel("collections")} c WHERE c.id = ${folderId}::uuid
        UNION
        SELECT c.id, c.description
          FROM ${knowledgeRel("collections")} c JOIN tree ON c.parent_collection_id = tree.id
      )
      SELECT 1 FROM tree
      WHERE tree.description ~ ${SYNCED_MARKER}
         OR EXISTS (
           SELECT 1 FROM ${knowledgeRel("synced_sources")} s
           WHERE s.root_collection_id = tree.id AND s.archived_at IS NULL
         )
      LIMIT 1
    `),
  )
  if (rows.length > 0) {
    throw new KnowledgeError(
      "VALIDATION",
      "This folder holds a folder synced from another app, so it stays where people see it now.",
    )
  }
}

/** Nobody writes the sync's own marker by hand: the next run would take the folder over. */
function assertNotMarker(description: string | null | undefined): void {
  if (description && new RegExp(SYNCED_MARKER).test(description)) {
    throw new KnowledgeError("VALIDATION", "This description is reserved for synced folders.")
  }
}

/** A folder is personal to the caller or shared, never someone else's. */
function assertOwnOrShared(ownerUserId: string | null, actor: KnowledgeActor): void {
  if (ownerUserId !== null && ownerUserId !== actor.userId) {
    throw new KnowledgeError("VALIDATION", "A personal folder can only be your own.")
  }
}

export async function listKnowledgeCollections(
  tx: RlsClient,
  actor: KnowledgeActor,
): Promise<KnowledgeCollectionRow[]> {
  const rows = extractRows<CollectionDbRow>(
    await tx.execute(drizzleSql`
      SELECT * FROM ${knowledgeRel("collections")}
      WHERE org_id = ${actor.orgId}::uuid
        AND archived_at IS NULL
        AND ${ownOrShared(actor)}
      ORDER BY name ASC
    `),
  )
  return rows.map(rowFromDb)
}

export interface CollectionTreeNode {
  id: string
  /**
   * A folder, or one of the two virtual nodes. A client names a virtual node
   * itself, in its reader's language; their English `name` is for clients that
   * do not know `kind`.
   */
  kind: "folder" | "personal_notes" | "unfiled"
  name: string
  parentId: string | null
  /** UUID of the user who owns this collection (personal). Null when the
   * collection is org-shared (no individual owner). Used by the client to
   * partition the sidebar into Personal vs Shared sections. */
  ownerUserId: string | null
  /** When this collection is the root of a synced source, the source id is
   * surfaced here so the sidebar can render a cloud badge (T-9). NULL for
   * normal collections. */
  syncedSourceId?: string | null
  virtual?: boolean
  children: CollectionTreeNode[]
  documents: Array<{ id: string; title: string; syncedSourceId?: string | null }>
}

export async function listKnowledgeCollectionTree(
  tx: RlsClient,
  actor: KnowledgeActor,
): Promise<CollectionTreeNode[]> {
  const flat = await listKnowledgeCollections(tx, actor)
  const ids = flat.map((c) => c.id)

  // T-9: detect which collections are synced-source roots so the sidebar can
  // render a cloud badge. A single JOIN at the tree-load layer is cheaper
  // than per-node lookups in the renderer.
  const syncedRootRows =
    ids.length === 0
      ? []
      : extractRows<{ root_collection_id: string; synced_source_id: string }>(
          await tx.execute(drizzleSql`
            SELECT root_collection_id, id AS synced_source_id
            FROM ${knowledgeRel("synced_sources")}
            WHERE archived_at IS NULL
              AND root_collection_id IN (${drizzleSql.join(
                ids.map((i) => drizzleSql`${i}::uuid`),
                drizzleSql`,`,
              )})
          `),
        )
  const syncedSourceByCollectionId = new Map(
    syncedRootRows.map((r) => [r.root_collection_id, r.synced_source_id]),
  )

  const members =
    ids.length === 0
      ? []
      : extractRows<{
          collection_id: string
          target_id: string
          title: string
          synced_source_id: string | null
        }>(
          await tx.execute(drizzleSql`
            SELECT m.collection_id, m.target_id, d.title, d.synced_source_id
            FROM ${knowledgeRel("collection_memberships")} m
            JOIN ${knowledgeRel("documents")} d
              ON d.id = m.target_id AND d.org_id = m.org_id
            WHERE m.collection_id IN (${drizzleSql.join(
              ids.map((i) => drizzleSql`${i}::uuid`),
              drizzleSql`,`,
            )})
              AND m.target_type = 'document'
              AND d.archived_at IS NULL
            ORDER BY lower(d.title), d.title, d.id
          `),
        )

  // Two virtual buckets, both of pages in no live folder this reader sees:
  //   - personal notes: personal documents (which belong to no folder by
  //     validation) and the reader's own pages nobody else can read.
  //   - unfiled: every other one, a page shared by someone who keeps it in a
  //     personal folder included.
  const personalNotes = extractRows<{ id: string; title: string }>(
    await tx.execute(drizzleSql`
      SELECT d.id, d.title
      FROM ${knowledgeRel("documents")} d
      WHERE d.org_id = ${actor.orgId}::uuid
        AND d.archived_at IS NULL
        AND (
          d.document_scope = 'personal'
          OR (${inNoVisibleFolder()} AND ${onlyMine(actor)})
        )
      ORDER BY d.updated_at DESC
    `),
  )
  const unfiled = extractRows<{ id: string; title: string }>(
    await tx.execute(drizzleSql`
      SELECT d.id, d.title
      FROM ${knowledgeRel("documents")} d
      WHERE d.org_id = ${actor.orgId}::uuid
        AND d.archived_at IS NULL
        AND d.document_scope = 'organization'
        AND ${inNoVisibleFolder()}
        AND NOT ${onlyMine(actor)}
      ORDER BY d.updated_at DESC
    `),
  )

  const byId = new Map<string, CollectionTreeNode>()
  for (const c of flat) {
    byId.set(c.id, {
      id: c.id,
      kind: "folder",
      name: c.name,
      parentId: c.parentCollectionId,
      ownerUserId: c.ownerUserId,
      syncedSourceId: syncedSourceByCollectionId.get(c.id) ?? null,
      children: [],
      documents: [],
    })
  }
  for (const m of members) {
    byId.get(m.collection_id)?.documents.push({
      id: m.target_id,
      title: m.title,
      syncedSourceId: m.synced_source_id ?? null,
    })
  }

  const roots: CollectionTreeNode[] = []
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  // Personal notes virtual node — owned by the caller so the sidebar
  // partition routes it into the Personal section.
  if (personalNotes.length > 0) {
    roots.push({
      id: "__personal_notes__",
      kind: "personal_notes",
      name: "Personal notes",
      parentId: null,
      ownerUserId: actor.userId,
      virtual: true,
      children: [],
      documents: personalNotes,
    })
  }
  if (unfiled.length > 0) {
    roots.push({
      id: "__unfiled__",
      kind: "unfiled",
      name: "Unfiled",
      parentId: null,
      ownerUserId: null,
      virtual: true,
      children: [],
      documents: unfiled,
    })
  }

  return roots
}

export async function createKnowledgeCollection(
  tx: RlsClient,
  input: KnowledgeCollectionInput,
  actor: KnowledgeActor,
): Promise<KnowledgeCollectionRow> {
  requireCollectionsScope(actor)
  const name = input.name?.trim()
  if (!name) throw new KnowledgeError("VALIDATION", "Collection name is required")

  assertNotMarker(input.description)
  const id = randomUUID()
  const maintainerUserIds = Array.from(new Set(input.maintainerUserIds ?? []))
  let ownerUserId: string | null
  if (input.parentCollectionId) {
    // A subfolder is seen by whoever sees its parent.
    const parent = await loadLiveCollection(tx, input.parentCollectionId, actor)
    await assertNotSynced(tx, parent.id)
    ownerUserId = parent.ownerUserId
  } else {
    // Omitted is the caller's own; an explicit null is shared (nullish
    // coalescing would collapse both into the caller).
    ownerUserId = input.ownerUserId === undefined ? actor.userId : input.ownerUserId
    assertOwnOrShared(ownerUserId, actor)
  }

  await tx.execute(drizzleSql`
    INSERT INTO ${knowledgeRel("collections")}
      (id, org_id, name, description, parent_collection_id, owner_user_id, maintainer_user_ids)
    VALUES (
      ${id}::uuid,
      ${actor.orgId}::uuid,
      ${name},
      ${input.description ?? null},
      ${input.parentCollectionId ?? null}::uuid,
      ${ownerUserId}::uuid,
      ${JSON.stringify(maintainerUserIds)}::jsonb
    )
  `)

  await queueFolderEvent(tx, "create", { id, ownerUserId }, { ownerUserId }, actor)

  const row = await loadCollection(tx, id, actor)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Collection not found after insert")
  return row
}

export async function updateKnowledgeCollection(
  tx: RlsClient,
  id: string,
  patch: Partial<KnowledgeCollectionInput>,
  actor: KnowledgeActor,
): Promise<KnowledgeCollectionRow> {
  requireCollectionsScope(actor)
  const existing = await loadCollection(tx, id, actor)
  if (!existing) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")

  await assertNotSynced(tx, id)
  assertNotMarker(patch.description)

  const parentId =
    patch.parentCollectionId !== undefined ? patch.parentCollectionId : existing.parentCollectionId
  let ownerUserId = patch.ownerUserId !== undefined ? patch.ownerUserId : existing.ownerUserId
  if (patch.parentCollectionId !== undefined || patch.ownerUserId !== undefined) {
    if (parentId === id) {
      throw new KnowledgeError("VALIDATION", "Collection hierarchy cycle is not allowed")
    }
    const parent = parentId ? await loadLiveCollection(tx, parentId, actor) : null
    if (parent) {
      await assertNotSynced(tx, parent.id)
      if (patch.ownerUserId !== undefined && patch.ownerUserId !== parent.ownerUserId) {
        throw new KnowledgeError(
          "VALIDATION",
          "A folder is seen by whoever sees the folder it is in. Move it out first.",
        )
      }
      ownerUserId = parent.ownerUserId
    }
    assertOwnOrShared(ownerUserId, actor)
  }
  const crossing = ownerUserId !== existing.ownerUserId
  if (crossing) {
    await assertHoldsNoSynced(tx, id)
    if (ownerUserId !== null) await assertTreeIsOnlyMine(tx, id)
  }

  const sets: ReturnType<typeof drizzleSql>[] = []
  if (patch.name !== undefined) {
    const name = patch.name?.trim()
    if (!name) throw new KnowledgeError("VALIDATION", "Collection name is required")
    sets.push(drizzleSql`name = ${name}`)
  }
  if (patch.description !== undefined) sets.push(drizzleSql`description = ${patch.description}`)
  if (patch.parentCollectionId !== undefined) {
    sets.push(drizzleSql`parent_collection_id = ${patch.parentCollectionId}::uuid`)
  }
  if (crossing) sets.push(drizzleSql`owner_user_id = ${ownerUserId}::uuid`)
  if (patch.maintainerUserIds !== undefined) {
    const ids = Array.from(new Set(patch.maintainerUserIds))
    sets.push(drizzleSql`maintainer_user_ids = ${JSON.stringify(ids)}::jsonb`)
  }
  sets.push(drizzleSql`updated_at = now()`)

  // Cycle prevention is enforced by the BEFORE trigger
  // collections_prevent_invalid_parent — bubble its raised exception as VALIDATION.
  try {
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("collections")}
      SET ${drizzleSql.join(sets, drizzleSql`, `)}
      WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
    `)
  } catch (err) {
    // The driver's error is the cause of the query error that wraps it.
    const message = [err, err instanceof Error ? err.cause : null]
      .map((e) => (e instanceof Error ? e.message : ""))
      .join("\n")
    if (/cycle|parent collection|cannot parent itself/i.test(message)) {
      throw new KnowledgeError("VALIDATION", "Collection hierarchy cycle is not allowed")
    }
    throw err
  }

  // The whole tree crosses with its top, archived folders included.
  if (crossing) {
    await tx.execute(drizzleSql`
      WITH RECURSIVE tree AS (
        SELECT c.id FROM ${knowledgeRel("collections")} c WHERE c.id = ${id}::uuid
        UNION
        SELECT c.id FROM ${knowledgeRel("collections")} c
          JOIN tree ON c.parent_collection_id = tree.id
      )
      UPDATE ${knowledgeRel("collections")}
      SET owner_user_id = ${ownerUserId}::uuid, updated_at = now()
      WHERE id IN (SELECT id FROM tree) AND id <> ${id}::uuid
        AND org_id = ${actor.orgId}::uuid
        AND owner_user_id IS DISTINCT FROM ${ownerUserId}::uuid
    `)
  }

  await queueFolderEvent(tx, "update", { id, ownerUserId }, existing, actor)

  const row = await loadCollection(tx, id, actor)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Collection not found after update")
  return row
}

/**
 * Moving a shared tree to Personal hides it from everybody else, admins
 * included, so it must hold nothing of anybody else.
 */
async function assertTreeIsOnlyMine(tx: RlsClient, folderId: string): Promise<void> {
  const rows = extractRows<{ only_mine: boolean }>(
    await tx.execute(drizzleSql`
      SELECT ${knowledgeRel("folder_tree_is_only_mine")}(${folderId}::uuid) AS only_mine
    `),
  )
  if (rows[0]?.only_mine !== true) {
    throw new KnowledgeError(
      "VALIDATION",
      "This folder holds something that belongs to another person, so it stays shared.",
    )
  }
}

/**
 * Delete a folder: what it holds moves to its parent (pages the caller cannot
 * read included, at the top they become unfiled), then it leaves the tree. One
 * transaction, so no page is ever reachable by search only.
 */
export async function archiveKnowledgeCollection(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<KnowledgeCollectionRow> {
  requireCollectionsScope(actor)
  const existing = await loadCollection(tx, id, actor)
  if (!existing) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")

  await assertNotSynced(tx, id)

  await tx.execute(drizzleSql`SELECT ${knowledgeRel("empty_folder_into_parent")}(${id}::uuid)`)
  await tx.execute(drizzleSql`
    UPDATE ${knowledgeRel("collections")}
    SET archived_at = now(), updated_at = now()
    WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
  `)

  await queueFolderEvent(tx, "archive", existing, existing, actor)

  const row = await loadCollection(tx, id, actor)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Collection not found after archive")
  return row
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

async function assertTargetReadable(
  tx: RlsClient,
  input: CollectionMembershipInput,
  actor: KnowledgeActor,
): Promise<void> {
  if (input.targetType === "document") {
    const row = await loadKnowledgeDocument(tx, input.targetId, actor)
    if (!row) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
    const shareRole = await loadDocumentShareRole(tx, row.id, actor)
    assertCanReadDocumentRow(row, actor, shareRole)
  } else {
    const exists = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${knowledgeRel("source_links")}
        WHERE id = ${input.targetId}::uuid AND org_id = ${actor.orgId}::uuid
        LIMIT 1
      `),
    )
    if (exists.length === 0) {
      throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
    }
  }
}

/**
 * Taking something out of a folder takes it away from where others look for it,
 * so it needs the edit right (out of its last folder included). Filing asks only
 * to read: it adds a place, removes none and gives nobody access.
 */
async function assertTargetEditable(
  tx: RlsClient,
  input: CollectionMembershipInput,
  actor: KnowledgeActor,
): Promise<void> {
  if (input.targetType === "source_link") {
    if (!hasScope("knowledge:documents:update", actor.scopes)) {
      throw new KnowledgeError("FORBIDDEN", "Forbidden to write Knowledge source link")
    }
    return
  }
  const row = await loadKnowledgeDocument(tx, input.targetId, actor)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
  assertCanWriteDocumentRow(row, actor, await loadDocumentShareRole(tx, row.id, actor))
}

/** A live folder the person sees and may file into or out of. */
export async function assertCanFileIn(
  tx: RlsClient,
  collectionId: string,
  actor: KnowledgeActor,
): Promise<KnowledgeCollectionRow> {
  const row = await loadLiveCollection(tx, collectionId, actor)
  await assertNotSynced(tx, row.id)
  return row
}

export async function addCollectionMembership(
  tx: RlsClient,
  input: CollectionMembershipInput,
  actor: KnowledgeActor,
): Promise<{ id: string }> {
  requireCollectionsScope(actor)
  const folder = await assertCanFileIn(tx, input.collectionId, actor)
  await assertTargetReadable(tx, input, actor)

  const id = randomUUID()
  await tx.execute(drizzleSql`
    INSERT INTO ${knowledgeRel("collection_memberships")}
      (id, org_id, collection_id, target_type, target_id, created_by)
    VALUES (
      ${id}::uuid,
      ${actor.orgId}::uuid,
      ${input.collectionId}::uuid,
      ${input.targetType},
      ${input.targetId}::uuid,
      ${actor.userId}::uuid
    )
    ON CONFLICT (org_id, collection_id, target_type, target_id) DO NOTHING
  `)

  // Resolve effective row (insert may have been a no-op due to ON CONFLICT)
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${knowledgeRel("collection_memberships")}
      WHERE org_id = ${actor.orgId}::uuid
        AND collection_id = ${input.collectionId}::uuid
        AND target_type = ${input.targetType}
        AND target_id = ${input.targetId}::uuid
      LIMIT 1
    `),
  )
  const effectiveId = rows[0]?.id ?? id

  await tx.queueEvent({
    app: "knowledge",
    entity: "collection_membership",
    action: "create",
    entityId: effectiveId,
    data: {
      collectionId: folder.id,
      targetType: input.targetType,
      targetId: input.targetId,
      ...folderAudience(folder),
    },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })

  return { id: effectiveId }
}

export async function removeCollectionMembership(
  tx: RlsClient,
  input: CollectionMembershipInput,
  actor: KnowledgeActor,
): Promise<void> {
  requireCollectionsScope(actor)
  const folder = await assertCanFileIn(tx, input.collectionId, actor)
  await assertTargetEditable(tx, input, actor)
  await tx.execute(drizzleSql`
    DELETE FROM ${knowledgeRel("collection_memberships")}
    WHERE org_id = ${actor.orgId}::uuid
      AND collection_id = ${input.collectionId}::uuid
      AND target_type = ${input.targetType}
      AND target_id = ${input.targetId}::uuid
  `)
  await tx.queueEvent({
    app: "knowledge",
    entity: "collection_membership",
    action: "delete",
    entityId: input.targetId,
    data: {
      collectionId: folder.id,
      targetType: input.targetType,
      targetId: input.targetId,
      ...folderAudience(folder),
    },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })
}
