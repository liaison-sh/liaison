// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Knowledge tags service — `(tx, input, actor)` shape with own SQL.
 *
 * - Upserts by `(org_id, normalized_name)` via ON CONFLICT.
 * - Always emits `tx.queueEvent` for downstream audit / outbox.
 * - orgId is always derived from `actor.orgId`; any caller-supplied orgId is
 *   ignored (IS-6).
 */
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { type KnowledgeActor, KnowledgeError } from "~/apps/knowledge/service"
import { extractRows, type RlsClient } from "~/db"
import { hasScope } from "~/modules/permissions/permissions"

function requireTagsScope(actor: KnowledgeActor): void {
  if (
    !hasScope("knowledge:tags:manage", actor.scopes) &&
    !hasScope("knowledge:documents:admin", actor.scopes)
  ) {
    throw new KnowledgeError("FORBIDDEN", "Forbidden to manage Knowledge tags")
  }
}

export function normalizeKnowledgeTagName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ")
}

export interface KnowledgeTagInput {
  name: string
  description?: string | null
}

export interface KnowledgeTagRow {
  id: string
  orgId: string
  name: string
  normalizedName: string
  description: string | null
  createdAt: string
  updatedAt: string
}

interface TagDbRow {
  id: string
  org_id: string
  name: string
  normalized_name: string
  description: string | null
  created_at: Date | string
  updated_at: Date | string
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function rowFromDb(r: TagDbRow): KnowledgeTagRow {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    normalizedName: r.normalized_name,
    description: r.description,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  }
}

export async function upsertKnowledgeTag(
  tx: RlsClient,
  input: KnowledgeTagInput,
  actor: KnowledgeActor,
): Promise<KnowledgeTagRow> {
  requireTagsScope(actor)
  const name = input.name?.trim()
  if (!name) throw new KnowledgeError("VALIDATION", "Tag name is required")
  const normalized = normalizeKnowledgeTagName(name)
  const id = randomUUID()
  const rows = extractRows<TagDbRow>(
    await tx.execute(drizzleSql`
      INSERT INTO ${knowledgeRel("tags")} (id, org_id, name, normalized_name, description)
      VALUES (${id}::uuid, ${actor.orgId}::uuid, ${name}, ${normalized}, ${input.description ?? null})
      ON CONFLICT (org_id, normalized_name) DO UPDATE
        SET updated_at = now(),
            description = COALESCE(EXCLUDED.description, ${knowledgeRel("tags")}.description)
      RETURNING *
    `),
  )
  const row = rows[0]
  if (!row) throw new KnowledgeError("NOT_FOUND", "Tag not found after upsert")
  await tx.queueEvent({
    app: "knowledge",
    entity: "tag",
    action: "upsert",
    entityId: row.id,
    data: { id: row.id, name: row.name, normalizedName: row.normalized_name },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })
  return rowFromDb(row)
}

export async function listKnowledgeTags(
  tx: RlsClient,
  actor: KnowledgeActor,
): Promise<KnowledgeTagRow[]> {
  const rows = extractRows<TagDbRow>(
    await tx.execute(drizzleSql`
      SELECT * FROM ${knowledgeRel("tags")}
      WHERE org_id = ${actor.orgId}::uuid
      ORDER BY normalized_name ASC
    `),
  )
  return rows.map(rowFromDb)
}
