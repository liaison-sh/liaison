// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { addCollectionMembership } from "~/apps/knowledge/collections"
import type { KnowledgeSourceRegistry } from "~/apps/knowledge/federated-search"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { type KnowledgeActor, KnowledgeError } from "~/apps/knowledge/service"
import { extractRows, type RlsClient } from "~/db"
import { hasScope } from "~/modules/permissions/permissions"

// ---------------------------------------------------------------------------
// Inputs / row types
// ---------------------------------------------------------------------------

export interface LinkRemoteInput {
  source: string
  externalId: string
  collectionId?: string
  title: string
  url?: string
  summary?: string
}

interface SourceLinkDbRow {
  id: string
  org_id: string
  source: string
  external_id: string
  source_identity_id: string
  title: string
  url: string | null
  summary: string | null
  review_status: string
  verified_at: Date | string | null
  archived_at: Date | string | null
  updated_at: Date | string
  visibility_status: string
}

// ---------------------------------------------------------------------------
// Remote visibility probe (uses registry adapters)
// ---------------------------------------------------------------------------

async function probeRemoteVisible(
  registry: KnowledgeSourceRegistry,
  input: { source: string; externalId: string; title?: string },
  actor: KnowledgeActor,
): Promise<{ url?: string; title?: string; modifiedAt?: string } | null> {
  const adapter = registry.listEnabled(actor).find((a) => a.source === input.source)
  if (!adapter) return null

  try {
    if (adapter.getRemoteMetadata) {
      const meta = (await adapter.getRemoteMetadata({ sourceEntityId: input.externalId }, actor)) as
        | { url?: string; title?: string; modifiedAt?: string }
        | null
        | undefined
      if (meta === null || meta === undefined) return null
      return meta
    }
    // Fallback: confirm visibility via searchRemote hit-match
    const probe = await adapter.searchRemote(
      { query: input.title ?? input.externalId, limit: 5 },
      actor,
    )
    const hit = probe.hits.find((h) => h.sourceEntityId === input.externalId)
    return hit ? { url: hit.url, title: hit.title, modifiedAt: hit.modifiedAt } : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// linkRemoteDocument
// ---------------------------------------------------------------------------

/**
 * Link a remote document into Knowledge.
 * - Upserts one source identity per `(orgId, source, externalId)`.
 * - Upserts one active source link per org/identity (idempotent).
 * - Optionally adds a collection membership.
 * - Verifies adapter-level remote visibility before any write.
 */
export async function linkRemoteDocument(
  tx: RlsClient,
  input: LinkRemoteInput,
  registry: KnowledgeSourceRegistry,
  actor: KnowledgeActor,
): Promise<{ id: string }> {
  if (!hasScope("knowledge:links:create", actor.scopes)) {
    throw new KnowledgeError("FORBIDDEN", "Missing knowledge:links:create scope")
  }

  const remote = await probeRemoteVisible(
    registry,
    { source: input.source, externalId: input.externalId, title: input.title },
    actor,
  )
  if (!remote) {
    throw new KnowledgeError("FORBIDDEN", "Remote document is not currently visible")
  }

  // Adapter-returned `remote.url` is not Zod-validated; reject any non-http(s)
  // scheme before persistence so a malicious or buggy adapter cannot store a
  // `javascript:` URL that would later XSS the frontend "Open original" link.
  const safeRemoteUrl = remote.url && /^https?:\/\//i.test(remote.url) ? remote.url : null
  const persistedUrl = input.url ?? safeRemoteUrl

  await tx.execute(drizzleSql`
    INSERT INTO ${knowledgeRel("source_identities")} (id, org_id, source, external_id, url, modified_at)
    VALUES (
      ${randomUUID()}::uuid,
      ${actor.orgId}::uuid,
      ${input.source},
      ${input.externalId},
      ${safeRemoteUrl ?? input.url ?? null},
      ${remote.modifiedAt ?? null}
    )
    ON CONFLICT (org_id, source, external_id) DO UPDATE SET
      url = COALESCE(EXCLUDED.url, ${knowledgeRel("source_identities")}.url),
      modified_at = COALESCE(EXCLUDED.modified_at, ${knowledgeRel("source_identities")}.modified_at),
      updated_at = now()
  `)

  const identityRows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${knowledgeRel("source_identities")}
      WHERE org_id = ${actor.orgId}::uuid
        AND source = ${input.source}
        AND external_id = ${input.externalId}
      LIMIT 1
    `),
  )
  const identityId = identityRows[0]!.id

  await tx.execute(drizzleSql`
    INSERT INTO ${knowledgeRel("source_links")}
      (id, org_id, source_identity_id, source, external_id, title, summary, url, owner_user_id)
    VALUES (
      ${randomUUID()}::uuid,
      ${actor.orgId}::uuid,
      ${identityId}::uuid,
      ${input.source},
      ${input.externalId},
      ${input.title},
      ${input.summary ?? null},
      ${persistedUrl},
      ${actor.userId}::uuid
    )
    ON CONFLICT (org_id, source_identity_id) WHERE archived_at IS NULL
    DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary,
                  url = EXCLUDED.url, updated_at = now()
  `)

  const linkRows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${knowledgeRel("source_links")}
      WHERE org_id = ${actor.orgId}::uuid
        AND source_identity_id = ${identityId}::uuid
        AND archived_at IS NULL
      LIMIT 1
    `),
  )
  const linkId = linkRows[0]!.id

  if (input.collectionId) {
    await addCollectionMembership(
      tx,
      { collectionId: input.collectionId, targetType: "source_link", targetId: linkId },
      actor,
    )
  }

  await tx.queueEvent({
    app: "knowledge",
    entity: "source_link",
    action: "create",
    entityId: linkId,
    data: { source: input.source, externalId: input.externalId },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })

  return { id: linkId }
}

// ---------------------------------------------------------------------------
// verifySourceLink
// ---------------------------------------------------------------------------

export async function loadSourceLink(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<SourceLinkResult | null> {
  const row = await loadLink(tx, id, actor)
  return row ? toResult(row) : null
}

async function loadLink(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<SourceLinkDbRow | null> {
  const rows = extractRows<SourceLinkDbRow>(
    await tx.execute(drizzleSql`
      SELECT * FROM ${knowledgeRel("source_links")}
      WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
      LIMIT 1
    `),
  )
  return rows[0] ?? null
}

export interface SourceLinkResult {
  id: string
  source: string
  title: string
  url: string | null
  reviewStatus: string
  verifiedAt: string | null
  visibilityStatus: string
  archivedAt: string | null
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null
  return v instanceof Date ? v.toISOString() : v
}

function toResult(row: SourceLinkDbRow): SourceLinkResult {
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    url: row.url ?? null,
    reviewStatus: row.review_status,
    verifiedAt: toIso(row.verified_at),
    visibilityStatus: row.visibility_status,
    archivedAt: toIso(row.archived_at),
  }
}

/**
 * Verify a source link by confirming current remote visibility.
 * Requires only `knowledge:documents:update` (IS-10: drops `:source-links:write`).
 */
export async function verifySourceLink(
  tx: RlsClient,
  id: string,
  registry: KnowledgeSourceRegistry,
  actor: KnowledgeActor,
): Promise<SourceLinkResult> {
  if (!hasScope("knowledge:documents:update", actor.scopes)) {
    throw new KnowledgeError("FORBIDDEN", "Missing knowledge:documents:update scope")
  }
  const link = await loadLink(tx, id, actor)
  if (!link) throw new KnowledgeError("NOT_FOUND", "Source link not found")
  if (link.archived_at) {
    throw new KnowledgeError("FORBIDDEN", "Cannot verify an archived source link")
  }

  const visible = await probeRemoteVisible(
    registry,
    { source: link.source, externalId: link.external_id, title: link.title },
    actor,
  )

  if (!visible) {
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("source_links")}
      SET review_status = 'stale', visibility_status = 'unavailable', updated_at = now()
      WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
    `)
    await tx.queueEvent({
      app: "knowledge",
      entity: "source_link",
      action: "verify",
      entityId: id,
      data: { status: "stale" },
      actorId: actor.userId,
      actorType: "user",
      orgId: actor.orgId,
    })
    const after = await loadLink(tx, id, actor)
    if (!after) throw new KnowledgeError("NOT_FOUND", "Source link missing after update")
    return toResult(after)
  }

  await tx.execute(drizzleSql`
    UPDATE ${knowledgeRel("source_links")}
    SET review_status = 'verified',
        verified_at = now(),
        verified_by = ${actor.userId}::uuid,
        visibility_status = 'available',
        updated_at = now()
    WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
  `)
  await tx.queueEvent({
    app: "knowledge",
    entity: "source_link",
    action: "verify",
    entityId: id,
    data: { status: "verified" },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })
  const after = await loadLink(tx, id, actor)
  if (!after) throw new KnowledgeError("NOT_FOUND", "Source link missing after update")
  return toResult(after)
}

// ---------------------------------------------------------------------------
// refreshSourceLinkMetadata
// ---------------------------------------------------------------------------

export async function refreshSourceLinkMetadata(
  tx: RlsClient,
  id: string,
  registry: KnowledgeSourceRegistry,
  actor: KnowledgeActor,
): Promise<SourceLinkResult> {
  if (!hasScope("knowledge:documents:update", actor.scopes)) {
    throw new KnowledgeError("FORBIDDEN", "Missing knowledge:documents:update scope")
  }
  const link = await loadLink(tx, id, actor)
  if (!link) throw new KnowledgeError("NOT_FOUND", "Source link not found")
  if (link.archived_at) {
    throw new KnowledgeError("FORBIDDEN", "Cannot refresh an archived source link")
  }
  const remote = await probeRemoteVisible(
    registry,
    { source: link.source, externalId: link.external_id, title: link.title },
    actor,
  )
  if (!remote) {
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("source_links")}
      SET visibility_status = 'unavailable', review_status = 'stale', updated_at = now()
      WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
    `)
  } else {
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("source_links")}
      SET title = COALESCE(${remote.title ?? null}, title),
          url = COALESCE(${remote.url ?? null}, url),
          visibility_status = 'available',
          updated_at = now()
      WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
    `)
  }
  await tx.queueEvent({
    app: "knowledge",
    entity: "source_link",
    action: "refresh",
    entityId: id,
    data: { visible: remote !== null },
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })
  const after = await loadLink(tx, id, actor)
  if (!after) throw new KnowledgeError("NOT_FOUND", "Source link missing after refresh")
  return toResult(after)
}

// ---------------------------------------------------------------------------
// archiveSourceLink
// ---------------------------------------------------------------------------

export async function archiveSourceLink(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<SourceLinkResult> {
  if (!hasScope("knowledge:documents:update", actor.scopes)) {
    throw new KnowledgeError("FORBIDDEN", "Missing knowledge:documents:update scope")
  }
  const link = await loadLink(tx, id, actor)
  if (!link) throw new KnowledgeError("NOT_FOUND", "Source link not found")

  await tx.execute(drizzleSql`
    UPDATE ${knowledgeRel("source_links")}
    SET archived_at = now(), updated_at = now()
    WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid
  `)
  await tx.queueEvent({
    app: "knowledge",
    entity: "source_link",
    action: "archive",
    entityId: id,
    data: {},
    actorId: actor.userId,
    actorType: "user",
    orgId: actor.orgId,
  })
  const after = await loadLink(tx, id, actor)
  if (!after) throw new KnowledgeError("NOT_FOUND", "Source link missing after archive")
  return toResult(after)
}
