// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import {
  assertCanFileIn,
  assertCanUnfile,
  folderAudience,
  type KnowledgeCollectionRow,
  requireCollectionsScope,
} from "~/apps/knowledge/collections"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  assertCanWriteDocumentRow,
  type KnowledgeActor,
  KnowledgeError,
  loadDocumentShareRole,
  loadKnowledgeDocument,
} from "~/apps/knowledge/service"
import { extractRows, type RlsClient } from "~/db"

export interface MoveDocumentInput {
  documentId: string
  /** The folder the page leaves; null when it is in none of the mover's. */
  fromCollectionId: string | null
  /** The folder it enters; null to leave it in no folder. */
  toCollectionId: string | null
}

/**
 * Move a page from one folder to another, in one transaction: it is never in
 * neither, and a refusal leaves it where it was. The mover must be able to edit
 * the page; its sharing does not change with its folder.
 */
export async function moveDocument(
  tx: RlsClient,
  input: MoveDocumentInput,
  actor: KnowledgeActor,
): Promise<{ id: string }> {
  requireCollectionsScope(actor)
  const { documentId, fromCollectionId, toCollectionId } = input
  const row = await loadKnowledgeDocument(tx, documentId, actor)
  if (!row) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
  assertCanWriteDocumentRow(row, actor, await loadDocumentShareRole(tx, row.id, actor))
  const from = fromCollectionId
    ? await assertCanUnfile(
        tx,
        { collectionId: fromCollectionId, targetType: "document", targetId: row.id },
        actor,
      )
    : null
  const to = toCollectionId ? await assertCanFileIn(tx, toCollectionId, actor) : null
  if (from?.id === to?.id) return { id: row.id }

  if (from) {
    const left = extractRows(
      await tx.execute(drizzleSql`
        DELETE FROM ${knowledgeRel("collection_memberships")}
        WHERE org_id = ${actor.orgId}::uuid AND collection_id = ${from.id}::uuid
          AND target_type = 'document' AND target_id = ${row.id}::uuid
        RETURNING id
      `),
    )
    if (left.length === 0) {
      throw new KnowledgeError(
        "VALIDATION",
        "This page is no longer in that folder. Reload the list and try again.",
      )
    }
  }
  let entityId = row.id
  if (to) {
    entityId = randomUUID()
    const filed = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${knowledgeRel("collection_memberships")}
          (id, org_id, collection_id, target_type, target_id, created_by)
        VALUES (${entityId}::uuid, ${actor.orgId}::uuid, ${to.id}::uuid, 'document',
                ${row.id}::uuid, ${actor.userId}::uuid)
        ON CONFLICT (org_id, collection_id, target_type, target_id) DO NOTHING
        RETURNING id
      `),
    )
    if (filed.length === 0) entityId = row.id
  }

  await tx.queueEvent({
    app: "knowledge",
    entity: "collection_membership",
    action: to ? "create" : "delete",
    entityId,
    data: {
      collectionId: to?.id ?? from?.id ?? null,
      targetType: "document",
      targetId: row.id,
      ...(to || from ? folderAudience((to ?? from) as KnowledgeCollectionRow) : {}),
      // Readers of the folder it leaves drop it.
      ...(to && from ? { wasOrgWide: from.ownerUserId === null } : {}),
    },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })
  return { id: row.id }
}
