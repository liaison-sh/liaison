// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, asc, desc, sql as drizzleSql, eq, ne } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { threadParticipants, threadReferences, threads } from "~/db/schema/kernel"
import { manifestRegistry } from "~/modules/apps/app-registries"
import { hasScope } from "~/modules/permissions/permissions"
import { resolveReferenceDisplay } from "./reference-display"

/**
 * Look up the read scope required to view a given (app, entityType) reference.
 * Kernel entity types are mapped directly; manifest-declared app entities use
 * their manifest entity's `readScope`. Returns null when the entity type is
 * unknown — callers should treat this as a deny.
 */
function resolveReadScopeForReference(
  orgId: string,
  app: string,
  entityType: string,
): string | null {
  if (app === "kernel") {
    switch (entityType) {
      case "thread":
        return "kernel:threads:read"
      case "user":
        return "kernel:users:read"
      case "contact":
        return "kernel:contacts:read"
      case "approval_request":
        return "kernel:approvals:read"
      default:
        return null
    }
  }
  for (const [[regOrgId, regApp], manifest] of manifestRegistry.entriesOf(orgId)) {
    if (regOrgId !== orgId) continue
    if (regApp !== app) continue
    const entities = (manifest.entities ?? {}) as Record<
      string,
      { readScope?: string; handlePrefix?: string }
    >
    const direct = entities[entityType]
    if (direct?.readScope) return direct.readScope
    // Tolerate handle-prefix lookups (singular form) when manifest key is plural.
    for (const decl of Object.values(entities)) {
      if (decl.handlePrefix === entityType && decl.readScope) return decl.readScope
    }
    return null
  }
  return null
}

interface AddReferenceParams {
  orgId: string
  userId: string
  threadId: string
  app: string
  entityType: string
  entityId: string
}

interface ListBacklinksParams {
  orgId: string
  userId: string
  app: string
  entityType: string
  entityId: string
}

export async function addReference(db: RlsClient, params: AddReferenceParams) {
  const { orgId, userId, threadId, app, entityType, entityId } = params

  // Verify user is participant
  const [participant] = await db
    .select()
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, userId),
        eq(threadParticipants.orgId, orgId),
      ),
    )
    .limit(1)
  if (!participant) return null

  const result = await db.execute(drizzleSql`
    INSERT INTO ${threadReferences}
      (thread_id, org_id, app, entity_type, entity_id, added_by, last_visited_at, created_at)
    VALUES
      (${threadId}, ${orgId}, ${app}, ${entityType}, ${entityId}, ${userId}, now(), now())
    ON CONFLICT (thread_id, app, entity_type, entity_id) DO UPDATE
      SET last_visited_at = now(),
          added_by = EXCLUDED.added_by
    RETURNING id, (xmax = 0) AS inserted
  `)
  const row = extractRows<{ id: string; inserted: boolean }>(result)[0]
  if (!row) return { added: false, reference: { id: "" } }
  const added = Boolean(row.inserted)
  if (added) {
    await db.queueEvent({
      app: "kernel",
      entity: "reference",
      action: "add",
      entityId: threadId,
      orgId,
      actorId: userId,
      data: { threadId, app, entityType, entityId },
    })
  }
  return { added, reference: { id: row.id } }
}

export interface ReferenceDisplay {
  id: string
  app: string
  entityType: string
  entityId: string
  tabType: string
  label: string
  icon: string
  lastVisitedAt: string
}

export async function listRecentReferences(
  db: RlsClient,
  params: { orgId: string; userId: string; threadId: string },
): Promise<ReferenceDisplay[]> {
  const { orgId, userId, threadId } = params

  const [participant] = await db
    .select()
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, userId),
        eq(threadParticipants.orgId, orgId),
      ),
    )
    .limit(1)
  if (!participant) return []

  const rows = await db
    .select()
    .from(threadReferences)
    .where(eq(threadReferences.threadId, threadId))
    .orderBy(desc(threadReferences.lastVisitedAt))
    .limit(5)

  return Promise.all(
    rows.map(async (r) => {
      const display = await resolveReferenceDisplay(db, {
        orgId,
        app: r.app,
        entityType: r.entityType,
        entityId: r.entityId,
      })
      return {
        id: r.id,
        app: r.app,
        entityType: r.entityType,
        entityId: r.entityId,
        tabType: display.tabType,
        label: display.label,
        icon: display.icon,
        lastVisitedAt: r.lastVisitedAt.toISOString(),
      }
    }),
  )
}

export async function listBacklinks(
  db: RlsClient,
  params: ListBacklinksParams & { limit?: number; offset?: number; scopes?: string[] },
) {
  const { orgId, userId, app, entityType, entityId, limit = 50, offset = 0, scopes } = params
  // When the actor scopes are provided, gate the result on the referenced entity's read scope.
  // The frontend only mounts <BacklinksPanel> after entity-detail load proves access; this
  // backend check defends direct `/api/references` calls from being a sniffer for handle ids.
  if (scopes) {
    const readScope = resolveReadScopeForReference(orgId, app, entityType)
    if (!readScope) return []
    if (!hasScope(readScope, scopes)) return []
  }
  return db
    .select({
      threadId: threadReferences.threadId,
      handle: threads.handle,
      title: threads.title,
      updatedAt: threads.updatedAt,
    })
    .from(threadReferences)
    .innerJoin(threads, eq(threads.id, threadReferences.threadId))
    .innerJoin(
      threadParticipants,
      and(eq(threadParticipants.threadId, threads.id), eq(threadParticipants.userId, userId)),
    )
    .where(
      and(
        eq(threadReferences.app, app),
        eq(threadReferences.entityType, entityType),
        eq(threadReferences.entityId, entityId),
        eq(threads.orgId, orgId),
        // Exclude private 1:1 Liaison assistant chats. `agent_chat` threads
        // accumulate entity references to power the assistant's OWN context
        // (the deictic "this ticket" resolution + the context strip, both read
        // via listRecentReferences). Those are private, incidental visits that
        // pile up as the user works and never clear -- surfacing them here would
        // leak a stale, misleadingly auto-titled chat onto every entity it ever
        // glanced at. The public "Referenced in N threads" backlinks panel is
        // for shared threads/approvals that genuinely reference the entity.
        ne(threads.type, "agent_chat"),
      ),
    )
    .orderBy(asc(threadReferences.createdAt))
    .limit(limit)
    .offset(offset)
}
