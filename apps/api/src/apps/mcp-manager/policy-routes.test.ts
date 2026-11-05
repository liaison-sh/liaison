// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T20 — Tool-policy routes test. The PUT /connections/:id/policy endpoint is
// implemented inline in routes.ts (single Hono surface) — this test isolates
// the policy-specific assertions to keep the routes test from getting too
// large.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { mcpConnections, mcpToolPolicy } from "~/db/schema/app_mcp_manager"
import { errorHandler } from "~/middleware/error-handler"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { mcpManagerRoutes } from "./routes"
import { buildMcpWorld, type McpTestWorld } from "./test-helpers/world"

function appAs(actor: UserContext) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", actor.userId)
    c.set("orgId", actor.orgId)
    c.set("scopes", actor.scopes as any)
    c.set("dimensionGrants", actor.dimensionGrants ?? {})
    await next()
  })
  app.route("/apps/mcp-manager", mcpManagerRoutes)
  // Mirror production (app.ts) so a thrown PermissionDeniedError → 403 (not a bare 500).
  app.onError(errorHandler)
  return app
}

async function seedConnection(orgId: string, createdBy: string, slug: string) {
  return withSystemDb("pr-seed-conn", async (db) => {
    const [row] = await db
      .insert(mcpConnections)
      .values({
        orgId,
        slug,
        displayName: slug,
        transport: "http",
        httpUrl: "https://x",
        authFlavor: "none",
        createdBy,
      })
      .returning({ id: mcpConnections.id })
    return row.id
  })
}

describe("mcp-manager policy routes", () => {
  let world: McpTestWorld
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)
  beforeEach(async () => {
    world = await buildMcpWorld()
  })

  it("PUT /:id/policy upserts overrideDecision; subsequent PUT overwrites", async () => {
    const connId = await seedConnection(
      world.org.id,
      world.admin.userId,
      `t-${crypto.randomUUID().slice(0, 6)}`,
    )
    const adminPolicy: UserContext = {
      ...world.admin,
      scopes: ["mcp_manager:policy:write", "mcp_manager:connection:read"],
    }
    const first = await appAs(adminPolicy).request(
      `/apps/mcp-manager/connections/${connId}/policy`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: "search", overrideDecision: "gate" }),
      },
    )
    expect(first.status).toBe(200)
    const second = await appAs(adminPolicy).request(
      `/apps/mcp-manager/connections/${connId}/policy`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: "search", overrideDecision: "deny" }),
      },
    )
    expect(second.status).toBe(200)
    const rows = await withSystemDb("pr-fetch", (db) =>
      db
        .select()
        .from(mcpToolPolicy)
        .where(and(eq(mcpToolPolicy.connectionId, connId), eq(mcpToolPolicy.toolName, "search"))),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].overrideDecision).toBe("deny")
  })

  it("PUT /:id/policy with roleOverrides round-trips the JSON array", async () => {
    const connId = await seedConnection(
      world.org.id,
      world.admin.userId,
      `t-${crypto.randomUUID().slice(0, 6)}`,
    )
    const adminPolicy: UserContext = {
      ...world.admin,
      scopes: ["mcp_manager:policy:write", "mcp_manager:connection:read"],
    }
    const res = await appAs(adminPolicy).request(`/apps/mcp-manager/connections/${connId}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "write_issue",
        overrideDecision: "gate",
        roleOverrides: [
          { roleId: world.roles.editor, decision: "auto" },
          { roleId: world.roles.viewer, decision: "deny" },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const [row] = await withSystemDb("pr-fetch-ovr", (db) =>
      db
        .select()
        .from(mcpToolPolicy)
        .where(
          and(eq(mcpToolPolicy.connectionId, connId), eq(mcpToolPolicy.toolName, "write_issue")),
        ),
    )
    expect(row.roleOverrides).toHaveLength(2)
    expect(row.roleOverrides![0].decision).toBe("auto")
  })

  it("PUT rejects 403 without mcp_manager:policy:write", async () => {
    const connId = await seedConnection(
      world.org.id,
      world.admin.userId,
      `t-${crypto.randomUUID().slice(0, 6)}`,
    )
    const res = await appAs(world.bob).request(`/apps/mcp-manager/connections/${connId}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: "x", overrideDecision: "gate" }),
    })
    expect(res.status).toBe(403)
  })

  it("PUT returns 404 when connection is invisible under RLS (cross-org)", async () => {
    const otherConnId = await seedConnection(
      world.otherOrg.id,
      world.otherAdmin.userId,
      `t-${crypto.randomUUID().slice(0, 6)}`,
    )
    const adminPolicy: UserContext = {
      ...world.admin,
      scopes: ["mcp_manager:policy:write", "mcp_manager:connection:read"],
    }
    const res = await appAs(adminPolicy).request(
      `/apps/mcp-manager/connections/${otherConnId}/policy`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: "x", overrideDecision: "gate" }),
      },
    )
    expect(res.status).toBe(404)
  })

  it("GET /:id/policy returns all tool policies for a connection", async () => {
    const connId = await seedConnection(
      world.org.id,
      world.admin.userId,
      `t-${crypto.randomUUID().slice(0, 6)}`,
    )
    const adminPolicy: UserContext = {
      ...world.admin,
      scopes: [
        "mcp_manager:policy:write",
        "mcp_manager:policy:read",
        "mcp_manager:connection:read",
      ],
    }
    for (const t of ["a", "b", "c"]) {
      await appAs(adminPolicy).request(`/apps/mcp-manager/connections/${connId}/policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: t, overrideDecision: "gate" }),
      })
    }
    const get = await appAs(adminPolicy).request(`/apps/mcp-manager/connections/${connId}/policy`, {
      method: "GET",
    })
    expect(get.status).toBe(200)
    const body = (await get.json()) as any
    expect(body.data).toHaveLength(3)
  })
})
