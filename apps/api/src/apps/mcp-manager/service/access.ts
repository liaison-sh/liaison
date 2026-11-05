// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who may use an organization MCP server (migration 0198). An org connection is
// open to `everyone` (every active member, the default) or `restricted` to the
// roles and people listed in `mcp_connection_access`. Nothing here grants a
// scope: the permission loader (`mcpServerAccessGrants`,
// modules/permissions/permissions.ts) derives `mcp:<slug>` from these rows at
// each token issue, so a change only has to make every member's token stale:
// `permission_version` goes up for the whole org (a token minted before the
// change is refused and refreshed), the auth cache entries are dropped here and
// on peer processes, and one `user_scope` event names them all so their open
// sessions are invalidated (grant-invalidation.ts) on every node. The same
// steps as an app access change (`afterOrgAccessChange`,
// modules/apps/org-app-service.ts, which holds the one privileged step: the
// org-wide bump). Everything else runs under the admin's own RLS context.
//
// Personal connections have no access setting: only their owner uses them.

import { and, eq, inArray } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { mcpConnectionAccess, mcpConnections } from "~/db/schema/app_mcp_manager"
import { roles, users } from "~/db/schema/kernel"
import { afterOrgAccessChange } from "~/modules/apps/org-app-service"

export type McpAccessMode = "everyone" | "restricted"

export interface McpConnectionAccess {
  mode: McpAccessMode
  roleIds: string[]
  userIds: string[]
}

export class McpAccessError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "McpAccessError"
  }
}

async function loadOrgConnection(db: RlsClient, connectionId: string) {
  const [row] = await db
    .select({
      id: mcpConnections.id,
      slug: mcpConnections.slug,
      ownershipScope: mcpConnections.ownershipScope,
      accessMode: mcpConnections.accessMode,
    })
    .from(mcpConnections)
    .where(eq(mcpConnections.id, connectionId))
  if (!row) throw new McpAccessError(404, "NOT_FOUND", "Connection not found")
  if (row.ownershipScope !== "org") {
    throw new McpAccessError(
      409,
      "personal_connection",
      "A personal connection is used by its owner only; it has no access setting",
    )
  }
  return row
}

/** The connection's access: its mode and, when restricted, who is listed. */
export async function getConnectionAccess(
  actor: UserContext,
  connectionId: string,
): Promise<McpConnectionAccess> {
  return withRlsContext(actor, async (db) => {
    const conn = await loadOrgConnection(db, connectionId)
    const rows = await db
      .select({
        principalType: mcpConnectionAccess.principalType,
        principalId: mcpConnectionAccess.principalId,
      })
      .from(mcpConnectionAccess)
      .where(eq(mcpConnectionAccess.connectionId, connectionId))
    return {
      mode: conn.accessMode,
      roleIds: rows.filter((r) => r.principalType === "role").map((r) => r.principalId),
      userIds: rows.filter((r) => r.principalType === "user").map((r) => r.principalId),
    }
  })
}

/**
 * Set who may use an org connection, as the admin (RLS: the org's rows only,
 * `mcp_manager:connection:admin` to write the list). Every role and person
 * must belong to the org (400 otherwise; RLS shows no other org's rows).
 * `everyone` clears the list. Returns the stored access.
 */
export async function setConnectionAccess(
  actor: UserContext,
  connectionId: string,
  access: McpConnectionAccess,
): Promise<McpConnectionAccess> {
  const roleIds = access.mode === "restricted" ? [...new Set(access.roleIds)] : []
  const userIds = access.mode === "restricted" ? [...new Set(access.userIds)] : []

  const slug = await withRlsContext(actor, async (db) => {
    const conn = await loadOrgConnection(db, connectionId)
    const foundRoles = roleIds.length
      ? await db
          .select({ id: roles.id })
          .from(roles)
          .where(and(eq(roles.orgId, actor.orgId), inArray(roles.id, roleIds)))
      : []
    const foundUsers = userIds.length
      ? await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.orgId, actor.orgId), inArray(users.id, userIds)))
      : []
    if (foundRoles.length !== roleIds.length || foundUsers.length !== userIds.length) {
      throw new McpAccessError(
        400,
        "INVALID_ARGUMENT",
        "Every role and person must belong to this workspace",
      )
    }
    await db
      .update(mcpConnections)
      .set({ accessMode: access.mode, updatedAt: new Date() })
      .where(eq(mcpConnections.id, connectionId))
    await db.delete(mcpConnectionAccess).where(eq(mcpConnectionAccess.connectionId, connectionId))
    const principals = [
      ...roleIds.map((id) => ({ principalType: "role" as const, principalId: id })),
      ...userIds.map((id) => ({ principalType: "user" as const, principalId: id })),
    ]
    if (principals.length > 0) {
      await db
        .insert(mcpConnectionAccess)
        .values(principals.map((p) => ({ connectionId, orgId: actor.orgId, ...p })))
    }
    await db.queueEvent({
      app: "mcp_manager",
      entity: "connection",
      action: "access_updated",
      entityId: connectionId,
      orgId: actor.orgId,
      actorId: actor.userId,
      actorType: "user",
      data: { slug: conn.slug, mode: access.mode, roleIds, userIds },
    })
    return conn.slug
  })

  // Committed: every member's token goes stale, their caches and ceilings follow.
  await afterOrgAccessChange(actor.orgId, {
    scope: `mcp:${slug}`,
    mode: access.mode,
    actorId: actor.userId,
  })
  return { mode: access.mode, roleIds, userIds }
}

/**
 * An organization server added or deleted changes who holds its namespace just
 * as an access change does: the loader grants `mcp:<slug>` to every member of an
 * `everyone` server from the next token, but a personal agent's ceiling is
 * persisted, so without this a member's agent never saw a server added after the
 * agent was created (its turns judged the tools against a ceiling without the
 * namespace), and a deleted server's namespace stayed in every ceiling. Runs once,
 * after the commit, on the process that published the `connection` event (the
 * event subscriber skips copies arriving from peers). Personal connections grant
 * their owner directly (`grantOwnerToolNamespace`) and need nothing here.
 */
export async function afterMcpConnectionLifecycle(event: {
  app: string
  entity: string
  action: string
  orgId?: string | null
  actorId?: string | null
  data?: unknown
}): Promise<void> {
  if (event.app !== "mcp_manager" || event.entity !== "connection") return
  if (event.action !== "created" && event.action !== "deleted") return
  const data = (event.data ?? {}) as { slug?: unknown; ownershipScope?: unknown }
  if (!event.orgId || typeof data.slug !== "string" || data.ownershipScope === "personal") return
  await afterOrgAccessChange(event.orgId, {
    scope: `mcp:${data.slug}`,
    mode: event.action,
    actorId: event.actorId ?? null,
  })
}
