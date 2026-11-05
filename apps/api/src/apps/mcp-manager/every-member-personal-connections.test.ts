// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every active member manages their OWN personal MCP servers, whatever their
// roles (S16). The grant does not ride on a role an admin may not have given:
// mcp-manager declares `everyMemberScopes` and the kernel unions them into each
// active member's effective scopes (loadEffectivePermissions). A person whose
// only role is a custom role with no MCP scope ("Intern") can list, add and
// remove their own personal server through the real routes, and still cannot
// create, edit or delete an org-level server nor touch a teammate's personal
// one. A restricted mcp-manager the person is kept out of, a removed app and a
// suspended account carry none of it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { sql } from "~/db/connection"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { errorHandler } from "~/middleware/error-handler"
import { validateAppManifest } from "~/modules/apps/contract"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import manifest from "./app.manifest.json"
import { mcpManagerRoutes } from "./routes"

const PERSONAL_WRITE = "mcp_manager:personal_connection:write"
const CONNECTION_READ = "mcp_manager:connection:read"

function appAs(actor: UserContext) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", actor.userId)
    c.set("orgId", actor.orgId)
    c.set("scopes", actor.scopes as never)
    c.set("dimensionGrants", actor.dimensionGrants ?? {})
    await next()
  })
  app.route("/apps/mcp-manager", mcpManagerRoutes)
  app.onError(errorHandler)
  return app
}

function send(actor: UserContext, method: string, path: string, body?: unknown) {
  return appAs(actor).request(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe("every member manages their own personal MCP servers, regardless of roles", () => {
  let orgId: string
  let internRoleId: string
  let internId: string
  let teammateId: string
  let adminId: string

  async function contextOf(userId: string): Promise<UserContext> {
    const perms = await withPrivilegedDb(orgId, "every-member-mcp-perms", (tx) =>
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

  async function seedConnection(
    slug: string,
    scope: "org" | "personal",
    ownerUserId: string | null,
  ): Promise<string> {
    return withSystemDb("every-member-mcp-seed", async (db) => {
      const [row] = await db
        .insert(mcpConnections)
        .values({
          orgId,
          slug,
          displayName: slug,
          transport: "http",
          httpUrl: "https://mcp.example.com/mcp",
          authFlavor: "none",
          ownershipScope: scope,
          ownerUserId,
          createdBy: ownerUserId ?? adminId,
        })
        .returning({ id: mcpConnections.id })
      return row.id
    })
  }

  async function rowById(id: string) {
    const [row] = await withSystemDb("every-member-mcp-row", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, id)),
    )
    return row ?? null
  }

  beforeAll(async () => {
    await acquireTestLock()
    // A real org: default roles, every default app registered (mcp-manager
    // included), and its bootstrap admin.
    orgId = (await createTestOrg()).id
    const [admin] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.users WHERE org_id = ${orgId} LIMIT 1`
    adminId = admin.id
    // A custom role an admin made, with no MCP scope at all.
    const [role] = await sql<{ id: string }[]>`
      INSERT INTO kernel.roles (org_id, name, description)
      VALUES (${orgId}, 'Intern', 'custom role without MCP scopes') RETURNING id`
    internRoleId = role.id
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope)
      VALUES (${internRoleId}, 'kernel:threads:read')`
    const ids: string[] = []
    for (const name of ["intern", "teammate"]) {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO kernel.users (org_id, email, name, status, password_hash)
        VALUES (${orgId}, ${`${name}-${crypto.randomUUID().slice(0, 8)}@every-member.test`},
                ${name}, 'active', 'hash') RETURNING id`
      await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
        VALUES (${u.id}, ${internRoleId}, ${orgId})`
      ids.push(u.id)
    }
    ;[internId, teammateId] = ids
  })

  afterAll(async () => {
    await sql`DELETE FROM app_mcp_manager.mcp_connections WHERE org_id = ${orgId}`
    await releaseTestLock()
  })

  it("the custom role grants no MCP scope; the person still holds the personal ones", async () => {
    const roleScopes = await sql<{ scope: string }[]>`
      SELECT scope FROM kernel.role_scope_grants WHERE role_id = ${internRoleId}`
    expect(roleScopes.map((r) => r.scope).filter((s) => s.startsWith("mcp_manager"))).toEqual([])
    const intern = await contextOf(internId)
    expect(intern.scopes).toContain(PERSONAL_WRITE)
    expect(intern.scopes).toContain(CONNECTION_READ)
    // Nothing org-level comes with it.
    expect(intern.scopes).not.toContain("mcp_manager:connection:write")
    expect(intern.scopes).not.toContain("mcp_manager:connection:admin")
    expect(intern.scopes).not.toContain("mcp_manager:policy:write")
  })

  it("lists, creates and deletes their own personal server through the real routes", async () => {
    const intern = await contextOf(internId)
    const created = await send(intern, "POST", "/apps/mcp-manager/connections", {
      slug: "intern-own",
      displayName: "My server",
      transport: "http",
      ownershipScope: "personal",
      httpUrl: "https://mcp.example.com/mcp",
      authFlavor: "none",
    })
    expect(created.status).toBe(200)
    const { id } = (await created.json()) as { id: string }
    const row = await rowById(id)
    expect(row?.ownershipScope).toBe("personal")
    expect(row?.ownerUserId).toBe(internId)

    const listed = await send(intern, "GET", "/apps/mcp-manager/connections")
    expect(listed.status).toBe(200)
    const data = ((await listed.json()) as { data: { id: string }[] }).data
    expect(data.map((r) => r.id)).toContain(id)

    const deleted = await send(intern, "DELETE", `/apps/mcp-manager/connections/${id}`)
    expect(deleted.status).toBe(200)
    expect(await rowById(id)).toBeNull()
  })

  it("cannot create, edit or delete an org-level server", async () => {
    const intern = await contextOf(internId)
    const create = await send(intern, "POST", "/apps/mcp-manager/connections", {
      slug: "intern-org",
      displayName: "Org attempt",
      transport: "http",
      ownershipScope: "org",
      httpUrl: "https://mcp.example.com/mcp",
      authFlavor: "none",
    })
    expect(create.status).toBe(403)
    expect(
      await withSystemDb("every-member-mcp-none", (db) =>
        db.select().from(mcpConnections).where(eq(mcpConnections.slug, "intern-org")),
      ),
    ).toHaveLength(0)

    const orgConn = await seedConnection("org-shared", "org", null)
    const patch = await send(intern, "PATCH", `/apps/mcp-manager/connections/${orgConn}`, {
      displayName: "Hacked",
    })
    expect([403, 404]).toContain(patch.status)
    const del = await send(intern, "DELETE", `/apps/mcp-manager/connections/${orgConn}`)
    expect([403, 404]).toContain(del.status)
    const row = await rowById(orgConn)
    expect(row?.displayName).toBe("org-shared")
  })

  it("never sees nor touches a teammate's personal server", async () => {
    const intern = await contextOf(internId)
    const theirs = await seedConnection("teammate-own", "personal", teammateId)

    const listed = await send(intern, "GET", "/apps/mcp-manager/connections")
    expect(listed.status).toBe(200)
    const ids = ((await listed.json()) as { data: { id: string }[] }).data.map((r) => r.id)
    expect(ids).not.toContain(theirs)
    const read = await send(intern, "GET", `/apps/mcp-manager/connections/${theirs}`)
    expect(read.status).toBe(404)

    const patch = await send(intern, "PATCH", `/apps/mcp-manager/connections/${theirs}`, {
      displayName: "Hacked",
    })
    expect([403, 404]).toContain(patch.status)
    const del = await send(intern, "DELETE", `/apps/mcp-manager/connections/${theirs}`)
    expect([403, 404]).toContain(del.status)
    expect((await rowById(theirs))?.displayName).toBe("teammate-own")
  })

  it("a restricted mcp-manager the person is kept out of drops the grant, like any app scope", async () => {
    await sql`UPDATE kernel.apps SET access_mode = 'restricted'
      WHERE org_id = ${orgId} AND name = 'mcp-manager'`
    try {
      const kept = await contextOf(internId)
      expect(kept.scopes).not.toContain(PERSONAL_WRITE)
      expect(kept.scopes).not.toContain(CONNECTION_READ)
      // Listing the person keeps the app, and the grant with it.
      await sql`INSERT INTO kernel.org_app_access (org_id, app, principal_type, principal_id)
        VALUES (${orgId}, 'mcp-manager', 'user', ${internId})`
      expect((await contextOf(internId)).scopes).toContain(PERSONAL_WRITE)
    } finally {
      await sql`DELETE FROM kernel.org_app_access WHERE org_id = ${orgId}`
      await sql`UPDATE kernel.apps SET access_mode = 'everyone'
        WHERE org_id = ${orgId} AND name = 'mcp-manager'`
    }
  })

  it("a removed app and a suspended account carry none of it", async () => {
    await sql`UPDATE kernel.apps SET status = 'removed'
      WHERE org_id = ${orgId} AND name = 'mcp-manager'`
    try {
      expect((await contextOf(internId)).scopes).not.toContain(PERSONAL_WRITE)
    } finally {
      await sql`UPDATE kernel.apps SET status = 'active'
        WHERE org_id = ${orgId} AND name = 'mcp-manager'`
    }
    await sql`UPDATE kernel.users SET status = 'suspended' WHERE id = ${teammateId}`
    try {
      expect((await contextOf(teammateId)).scopes).not.toContain(PERSONAL_WRITE)
    } finally {
      await sql`UPDATE kernel.users SET status = 'active' WHERE id = ${teammateId}`
    }
  })

  it("the manifest may only give every member scopes of its own member tier", () => {
    expect(validateAppManifest(manifest).success).toBe(true)
    const widened = { ...manifest, everyMemberScopes: ["mcp_manager:connection:write"] }
    const res = validateAppManifest(widened)
    expect(res.success).toBe(false)
    expect((res as { error?: string }).error).toContain("everyMemberScopes")
  })
})
