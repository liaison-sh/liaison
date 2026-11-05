// SPDX-License-Identifier: FSL-1.1-ALv2
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { organizations, roleScopeGrants, roles, userRoles, users } from "~/db/schema/kernel"
import { hashPassword } from "~/lib/crypto"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { createTestOrg } from "~/tests/helpers/org"

export interface McpTestWorld {
  org: { id: string }
  otherOrg: { id: string }
  /** Admin in `org` with full `mcp_manager:*` + manage scopes. */
  admin: UserContext
  /** Member in `org` with editor + viewer roles attached. */
  alice: UserContext
  /** Member in `org` with no `mcp_manager:*` scope. */
  bob: UserContext
  /** Admin in `otherOrg` (for cross-org isolation tests). */
  otherAdmin: UserContext
  /** Role ids inside `org` (for tool-policy roleOverrides tests). */
  roles: { editor: string; viewer: string }
}

const MCP_MANAGER_ADMIN_SCOPES = [
  "mcp_manager:connection:read",
  "mcp_manager:connection:write",
  "mcp_manager:connection:admin",
  "mcp_manager:policy:read",
  "mcp_manager:policy:write",
  "mcp_manager:audit:read",
  "mcp_manager:usage:read",
]

async function buildUserContext(userId: string, orgId: string): Promise<UserContext> {
  const perms = await withPrivilegedDb(orgId, "mcp-world-load-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
}

async function mintUserInOrg(
  orgId: string,
  email: string,
  opts: { roleIds: string[] },
): Promise<string> {
  return withSystemDb("mcp-world-mint-user", async (db) => {
    const passwordHash = await hashPassword("Passw0rd!")
    const [u] = await db
      .insert(users)
      .values({ orgId, email, passwordHash, name: email.split("@")[0], status: "active" })
      .returning({ id: users.id })
    for (const roleId of opts.roleIds) {
      await db.insert(userRoles).values({ userId: u.id, roleId, orgId })
    }
    return u.id
  })
}

async function setUserScopesViaRole(
  orgId: string,
  userId: string,
  scopes: string[],
): Promise<void> {
  await withSystemDb("mcp-world-set-scopes", async (db) => {
    const [scoped] = await db
      .insert(roles)
      .values({ orgId, name: `mcp-scoped-${crypto.randomUUID().slice(0, 8)}` })
      .returning({ id: roles.id })
    for (const scope of scopes) {
      await db.insert(roleScopeGrants).values({ roleId: scoped.id, scope })
    }
    await db.delete(userRoles).where(and(eq(userRoles.userId, userId), eq(userRoles.orgId, orgId)))
    await db.insert(userRoles).values({ userId, roleId: scoped.id, orgId })
  })
}

/**
 * Build a fully-formed two-org test world for the MCP manager.
 *
 * Requires the caller to hold the test lock (`acquireTestLock` in `beforeAll`),
 * because internally we call `createTestOrg` which truncates org-scoped kernel
 * tables. The second org and its admin are minted by direct insert (no
 * `bootstrapRegister` — that helper enforces a single-org invariant).
 */
export async function buildMcpWorld(
  opts: {
    /** Scopes the admin holds beyond the MCP manager's admin set (e.g. `mcp:*`). */
    adminScopes?: string[]
  } = {},
): Promise<McpTestWorld> {
  const orgA = await createTestOrg()
  const orgB = await withSystemDb("mcp-world-second-org", async (db) => {
    const [row] = await db
      .insert(organizations)
      .values({
        name: `McpWorld B ${crypto.randomUUID().slice(0, 6)}`,
        slug: `mcp-b-${crypto.randomUUID().slice(0, 6)}`,
      })
      .returning({ id: organizations.id })
    return { id: row.id }
  })

  // Find admin user that createTestOrg minted (the only user in orgA so far).
  const adminId = await withSystemDb("mcp-world-find-admin", async (db) => {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.orgId, orgA.id))
      .limit(1)
    if (!rows[0]) throw new Error("buildMcpWorld: no admin user in orgA")
    return rows[0].id
  })
  // Replace the "*" admin role with an exact-scope role so scope checks are genuine.
  await setUserScopesViaRole(orgA.id, adminId, [
    ...MCP_MANAGER_ADMIN_SCOPES,
    ...(opts.adminScopes ?? []),
  ])

  // Editor + viewer role IDs in orgA (used by tool-policy roleOverrides tests).
  const { editorId, viewerId } = await withSystemDb("mcp-world-create-roles", async (db) => {
    const [editor] = await db
      .insert(roles)
      .values({ orgId: orgA.id, name: "mcp-editor", description: "MCP test editor" })
      .returning({ id: roles.id })
    const [viewer] = await db
      .insert(roles)
      .values({ orgId: orgA.id, name: "mcp-viewer", description: "MCP test viewer" })
      .returning({ id: roles.id })
    // Editor gets :write (so personal-INSERT works under B3's tightened RLS);
    // viewer keeps :read only. Per spec §3.4: personal-INSERT requires :write.
    await db.insert(roleScopeGrants).values([
      { roleId: editor.id, scope: "mcp_manager:connection:read" },
      { roleId: editor.id, scope: "mcp_manager:connection:write" },
      { roleId: viewer.id, scope: "mcp_manager:connection:read" },
    ])
    return { editorId: editor.id, viewerId: viewer.id }
  })

  const aliceId = await mintUserInOrg(
    orgA.id,
    `alice-${crypto.randomUUID().slice(0, 6)}@mcp.local`,
    {
      roleIds: [editorId, viewerId],
    },
  )
  const bobId = await mintUserInOrg(orgA.id, `bob-${crypto.randomUUID().slice(0, 6)}@mcp.local`, {
    roleIds: [],
  })

  // Bootstrap an admin in orgB by direct insert.
  const otherAdminId = await withSystemDb("mcp-world-other-admin", async (db) => {
    const passwordHash = await hashPassword("Passw0rd!")
    const [u] = await db
      .insert(users)
      .values({
        orgId: orgB.id,
        email: `other-${crypto.randomUUID().slice(0, 6)}@mcp.local`,
        passwordHash,
        name: "OtherAdmin",
        status: "active",
      })
      .returning({ id: users.id })
    const [scoped] = await db
      .insert(roles)
      .values({ orgId: orgB.id, name: "other-admin" })
      .returning({ id: roles.id })
    for (const scope of MCP_MANAGER_ADMIN_SCOPES) {
      await db.insert(roleScopeGrants).values({ roleId: scoped.id, scope })
    }
    await db.insert(userRoles).values({ userId: u.id, roleId: scoped.id, orgId: orgB.id })
    return u.id
  })

  const [admin, alice, bob, otherAdmin] = await Promise.all([
    buildUserContext(adminId, orgA.id),
    buildUserContext(aliceId, orgA.id),
    buildUserContext(bobId, orgA.id),
    buildUserContext(otherAdminId, orgB.id),
  ])

  return {
    org: orgA,
    otherOrg: orgB,
    admin,
    alice,
    bob,
    otherAdmin,
    roles: { editor: editorId, viewer: viewerId },
  }
}
