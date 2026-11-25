// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Who, besides the person whose agent asks, can read a page. An approval card
 * quotes the page, so the card's audience follows the page's, never its scope.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  findOrgDocByTitle,
  findOrgRunningDocByTitlePrefix,
  findRoutineBoundRunningDoc,
  findUniqueOrgRunningWatchDoc,
  type KnowledgeActor,
  knowledgeActorFromContext,
} from "~/apps/knowledge/service"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { isUuid } from "~/lib/uuid"

/**
 * - `private`: its owner alone. An agent's write parks no card, as on a personal note.
 * - `restricted`: named people or roles. The card parks and is its owner's alone.
 * - `org`: the organization. The card is the organization's deciders', as ever.
 */
export type KnowledgeAudience = "private" | "restricted" | "org"

interface AudienceFacts {
  documentScope: string
  orgAccess: string
  ownerUserId: string | null
  createdBy: string | null
  /** Grants to anyone but the owner and the creator. */
  othersGranted: boolean
}

export function audienceOfFacts(f: AudienceFacts): KnowledgeAudience {
  if (f.documentScope === "personal") return "private"
  if (f.orgAccess !== "none") return "org"
  if (f.othersGranted) return "restricted"
  return f.ownerUserId === null || f.ownerUserId === f.createdBy ? "private" : "restricted"
}

interface PageAudience {
  audience: KnowledgeAudience
  ownerUserId: string | null
}

/** The audience of a stored page, or null when the reader of `tx` sees no such page. */
export async function audienceOfDocument(
  tx: Pick<RlsClient, "execute">,
  orgId: string,
  documentId: unknown,
): Promise<PageAudience | null> {
  if (typeof documentId !== "string" || !isUuid(documentId)) return null
  const [row] = extractRows<{
    document_scope: string
    org_access: string
    owner_user_id: string | null
    created_by: string | null
    others_granted: boolean
  }>(
    await tx.execute(drizzleSql`
      SELECT d.document_scope, d.org_access, d.owner_user_id::text AS owner_user_id,
             d.created_by::text AS created_by,
             EXISTS (
               SELECT 1 FROM ${kernelRel("resource_grants")} g
                WHERE g.org_id = d.org_id AND g.resource_type = 'knowledge.document'
                  AND g.resource_id = d.id
                  AND NOT (g.grantee_kind = 'user'
                           AND g.grantee IN (d.owner_user_id::text, d.created_by::text))
             ) AS others_granted
        FROM ${knowledgeRel("documents")} d
       WHERE d.id = ${documentId}::uuid AND d.org_id = ${orgId}::uuid
    `),
  )
  if (!row) return null
  return {
    ownerUserId: row.owner_user_id,
    audience: audienceOfFacts({
      documentScope: row.document_scope,
      orgAccess: row.org_access,
      ownerUserId: row.owner_user_id,
      createdBy: row.created_by,
      othersGranted: row.others_granted,
    }),
  }
}

/** The audience of the page a create would make, from the params it will use. */
export function audienceOfCreateParams(
  params: Record<string, unknown>,
  requestedBy: string,
): KnowledgeAudience {
  const sensitivity = params.sensitivity ?? "internal"
  const orgAccess =
    typeof params.orgAccess === "string"
      ? params.orgAccess
      : sensitivity === "confidential" || sensitivity === "restricted"
        ? "none"
        : "editor"
  return audienceOfFacts({
    documentScope: params.documentScope === "personal" ? "personal" : "organization",
    orgAccess,
    ownerUserId: typeof params.ownerUserId === "string" ? params.ownerUserId : requestedBy,
    createdBy: requestedBy,
    othersGranted: Array.isArray(params.shareWithRoles) && params.shareWithRoles.length > 0,
  })
}

/**
 * The audience a create really has. An organization create that names a page the
 * caller already maintains is written into that page (knowledge_create), so the
 * existing page's audience is the one that counts.
 */
export async function audienceOfCreate(
  tx: RlsClient,
  actor: KnowledgeActor,
  params: Record<string, unknown>,
): Promise<PageAudience> {
  const own: PageAudience = {
    audience: audienceOfCreateParams(params, actor.userId),
    ownerUserId: actor.userId,
  }
  if (params.documentScope === "personal") return own
  const title = typeof params.title === "string" ? params.title.trim() : ""
  const existing =
    (await findRoutineBoundRunningDoc(tx, actor.orgId, actor)) ??
    (title
      ? ((await findOrgDocByTitle(tx, actor.orgId, title, actor)) ??
        (await findOrgRunningDocByTitlePrefix(tx, actor.orgId, title, actor)) ??
        (await findUniqueOrgRunningWatchDoc(tx, actor.orgId, title, actor)))
      : null)
  if (!existing) return own
  return (await audienceOfDocument(tx, actor.orgId, existing.id)) ?? own
}

async function activeUser(orgId: string, userId: string | null): Promise<string | null> {
  if (!userId) return null
  const rows = await withPrivilegedDb(orgId, "knowledge-approval-owner", (tx) =>
    tx.execute(drizzleSql`
      SELECT id::text AS id FROM ${kernelRel("users")}
       WHERE id = ${userId}::uuid AND org_id = ${orgId}::uuid AND status = 'active'
         AND user_type = 'member'`),
  )
  return extractRows<{ id: string }>(rows)[0]?.id ?? null
}

/**
 * Who alone decides a gated knowledge write: null for a page the organization
 * reads (its deciders), else the page's owner, or the requester. A failure is the
 * requester's card: answering "the organization" would show it to people who may
 * not read the page.
 */
export async function knowledgeApprovalOwner(
  tool: string,
  params: Record<string, unknown>,
  ctx: { orgId: string; requestedBy: string },
): Promise<string | null> {
  try {
    if (tool === "create") {
      const target = await asRequester(ctx, (tx, actor) => audienceOfCreate(tx, actor, params))
      if (target.audience === "org") return null
      return (await activeUser(ctx.orgId, target.ownerUserId)) ?? ctx.requestedBy
    }
    const target = await withPrivilegedDb(ctx.orgId, "knowledge-approval-audience", (tx) =>
      audienceOfDocument(tx, ctx.orgId, params.id),
    )
    if (target?.audience === "org") return null
    return (await activeUser(ctx.orgId, target?.ownerUserId ?? null)) ?? ctx.requestedBy
  } catch {
    return ctx.requestedBy
  }
}

/** The requester's own view, with the permissions they hold now. */
async function asRequester<T>(
  ctx: { orgId: string; requestedBy: string },
  fn: (tx: RlsClient, actor: KnowledgeActor) => Promise<T>,
): Promise<T> {
  const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
  const perms = await withPrivilegedDb(ctx.orgId, "knowledge-approval-requester", (tx) =>
    loadEffectivePermissions(tx, ctx.requestedBy, ctx.orgId),
  )
  const input = {
    orgId: ctx.orgId,
    userId: ctx.requestedBy,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
    roles: perms.roles,
  }
  return withRlsContext({ actorType: "user" as const, ...input }, (tx) =>
    fn(tx, knowledgeActorFromContext(input)),
  )
}
