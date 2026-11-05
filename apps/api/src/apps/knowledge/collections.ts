// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  assertCanReadDocumentRow,
  type KnowledgeActor,
  KnowledgeError,
  loadDocumentShareRole,
  loadKnowledgeDocument,
} from "~/apps/knowledge/service"
import { extractRows, type RlsClient } from "~/db"
import { isUuid } from "~/lib/uuid"
import { hasScope } from "~/modules/permissions/permissions"

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

function requireCollectionsScope(actor: KnowledgeActor): void {
  if (
    !hasScope("knowledge:collections:manage", actor.scopes) &&
    !hasScope("knowledge:documents:admin", actor.scopes)
  ) {
    throw new KnowledgeError("FORBIDDEN", "Forbidden to manage Knowledge collection")
  }
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
      LIMIT 1
    `),
  )
  return rows[0] ? rowFromDb(rows[0]) : null
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
      ORDER BY name ASC
    `),
  )
  return rows.map(rowFromDb)
}

export interface CollectionTreeNode {
  id: string
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
          `),
        )

  // Two virtual buckets:
  //   - personal-notes: documents with documentScope='personal' (these
  //     CANNOT belong to a collection by validation, so they live in a
  //     dedicated bucket under the Personal sidebar section).
  //   - unfiled: org-scope documents not in any collection (the Shared
  //     sidebar section surfaces these).
  const personalNotes = extractRows<{ id: string; title: string }>(
    await tx.execute(drizzleSql`
      SELECT d.id, d.title
      FROM ${knowledgeRel("documents")} d
      WHERE d.archived_at IS NULL
        AND d.document_scope = 'personal'
      ORDER BY d.updated_at DESC
    `),
  )
  const unfiled = extractRows<{ id: string; title: string }>(
    await tx.execute(drizzleSql`
      SELECT d.id, d.title
      FROM ${knowledgeRel("documents")} d
      WHERE d.archived_at IS NULL
        AND d.document_scope = 'organization'
        AND NOT EXISTS (
          SELECT 1 FROM ${knowledgeRel("collection_memberships")} m
          WHERE m.org_id = d.org_id
            AND m.target_type = 'document'
            AND m.target_id = d.id
        )
      ORDER BY d.updated_at DESC
    `),
  )

  const byId = new Map<string, CollectionTreeNode>()
  for (const c of flat) {
    byId.set(c.id, {
      id: c.id,
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

  const id = randomUUID()
  const maintainerUserIds = Array.from(new Set(input.maintainerUserIds ?? []))
  // Distinguish "field omitted" (default to caller — personal) from
  // "explicitly null" (org-shared collection). Nullish coalescing would
  // collapse both into "caller's id" and prevent org-shared creation.
  const ownerUserId = "ownerUserId" in input ? input.ownerUserId : actor.userId

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

  await tx.queueEvent({
    app: "knowledge",
    entity: "collection",
    action: "create",
    entityId: id,
    data: { id, name },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })

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
  if (patch.ownerUserId !== undefined) {
    sets.push(drizzleSql`owner_user_id = ${patch.ownerUserId}::uuid`)
  }
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
    const message = err instanceof Error ? err.message : String(err)
    if (/cycle|parent collection|cannot parent itself/i.test(message)) {
      throw new KnowledgeError("VALIDATION", "Collection hierarchy cycle is not allowed")
    }
    throw err
  }

  await tx.queueEvent({
    app: "knowledge",
    entity: "collection",
    action: "update",
    entityId: id,
    data: { id },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })

  const row = await loadCollection(tx, id, actor)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Collection not found after update")
  return row
}

export async function archiveKnowledgeCollection(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<KnowledgeCollectionRow> {
  requireCollectionsScope(actor)
  const existing = await loadCollection(tx, id, actor)
  if (!existing) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")

  await tx.execute(drizzleSql`
    UPDATE ${knowledgeRel("collections")}
    SET archived_at = now(), updated_at = now()
    WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
  `)

  await tx.queueEvent({
    app: "knowledge",
    entity: "collection",
    action: "archive",
    entityId: id,
    data: { id },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })

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

async function assertCollectionExists(
  tx: RlsClient,
  collectionId: string,
  actor: KnowledgeActor,
): Promise<void> {
  const row = await loadCollection(tx, collectionId, actor)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
}

export async function addCollectionMembership(
  tx: RlsClient,
  input: CollectionMembershipInput,
  actor: KnowledgeActor,
): Promise<{ id: string }> {
  requireCollectionsScope(actor)
  await assertCollectionExists(tx, input.collectionId, actor)
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
    data: { ...input },
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
    data: { ...input },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })
}
