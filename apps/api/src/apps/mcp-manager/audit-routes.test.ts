// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { auditLog } from "~/db/schema/kernel/audit-log"
import { errorHandler } from "~/middleware/error-handler"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { mcpManagerAuditRoutes } from "./audit-routes"
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
  app.route("/apps/mcp-manager", mcpManagerAuditRoutes)
  // Mirror production (app.ts) so a thrown PermissionDeniedError → 403 (not a bare 500).
  app.onError(errorHandler)
  return app
}

async function seedConnection(orgId: string, createdBy: string, slug: string): Promise<string> {
  return withSystemDb("ar-seed-conn", async (db) => {
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

async function seedAuditRow(args: {
  orgId: string
  connectionId: string
  toolName: string
  outcome: string
  decision: string
  latencyMs: number
  requestBytes: number
  responseBytes?: number
  timestamp?: Date
}) {
  await withSystemDb("ar-seed-audit", async (db) => {
    await db.insert(auditLog).values({
      orgId: args.orgId,
      actorId: null,
      actorType: "user",
      app: "mcp",
      entityType: "call",
      entityId: args.connectionId,
      action: "call.execute",
      timestamp: args.timestamp ?? new Date(),
      changes: {
        connection_id: args.connectionId,
        tool_name: args.toolName,
        outcome: args.outcome,
        decision: args.decision,
        policy_path: "connection_default",
        latency_ms: args.latencyMs,
        request_bytes: args.requestBytes,
        ...(args.responseBytes !== undefined ? { response_bytes: args.responseBytes } : {}),
      },
    })
  })
}

describe("mcp-manager audit + usage routes", () => {
  let world: McpTestWorld
  let connId: string

  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)
  beforeEach(async () => {
    world = await buildMcpWorld()
    connId = await seedConnection(
      world.org.id,
      world.admin.userId,
      `t-${crypto.randomUUID().slice(0, 6)}`,
    )
  })

  it("GET /:id/audit returns rows filtered to the connection, ordered newest first", async () => {
    const now = Date.now()
    await seedAuditRow({
      orgId: world.org.id,
      connectionId: connId,
      toolName: "linear:search",
      outcome: "ok",
      decision: "auto",
      latencyMs: 50,
      requestBytes: 100,
      responseBytes: 200,
      timestamp: new Date(now - 60_000),
    })
    await seedAuditRow({
      orgId: world.org.id,
      connectionId: connId,
      toolName: "linear:write",
      outcome: "denied",
      decision: "deny",
      latencyMs: 10,
      requestBytes: 50,
      timestamp: new Date(now),
    })
    const res = await appAs(world.admin).request(`/apps/mcp-manager/connections/${connId}/audit`, {
      method: "GET",
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toHaveLength(2)
    expect(body.data[0].changes.tool_name).toBe("linear:write") // newer first
    expect(body.truncated).toBe(false)
  })

  it("GET /:id/audit?decision=deny filters by decision", async () => {
    await seedAuditRow({
      orgId: world.org.id,
      connectionId: connId,
      toolName: "x:a",
      outcome: "ok",
      decision: "auto",
      latencyMs: 10,
      requestBytes: 10,
    })
    await seedAuditRow({
      orgId: world.org.id,
      connectionId: connId,
      toolName: "x:b",
      outcome: "denied",
      decision: "deny",
      latencyMs: 5,
      requestBytes: 10,
    })
    const res = await appAs(world.admin).request(
      `/apps/mcp-manager/connections/${connId}/audit?decision=deny`,
      { method: "GET" },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toHaveLength(1)
    expect(body.data[0].changes.decision).toBe("deny")
  })

  it("GET /:id/audit returns empty array for connection with no audit history", async () => {
    const res = await appAs(world.admin).request(`/apps/mcp-manager/connections/${connId}/audit`, {
      method: "GET",
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toEqual([])
  })

  it("GET /:id/audit rejects 403 without mcp_manager:audit:read scope", async () => {
    const res = await appAs(world.bob).request(`/apps/mcp-manager/connections/${connId}/audit`, {
      method: "GET",
    })
    expect(res.status).toBe(403)
  })

  it("GET /:id/audit returns 404 when connection invisible to actor (cross-org)", async () => {
    const otherConn = await seedConnection(world.otherOrg.id, world.otherAdmin.userId, "other-x")
    const adminReader: UserContext = {
      ...world.admin,
      scopes: ["mcp_manager:audit:read", "mcp_manager:connection:read"],
    }
    const res = await appAs(adminReader).request(
      `/apps/mcp-manager/connections/${otherConn}/audit`,
      { method: "GET" },
    )
    expect(res.status).toBe(404)
  })

  it("GET /:id/usage rolls up calls, errors, p95 latency, top tools over the window", async () => {
    for (let i = 0; i < 5; i++) {
      await seedAuditRow({
        orgId: world.org.id,
        connectionId: connId,
        toolName: "linear:search",
        outcome: "ok",
        decision: "auto",
        latencyMs: 10 + i,
        requestBytes: 100,
        responseBytes: 500,
      })
    }
    await seedAuditRow({
      orgId: world.org.id,
      connectionId: connId,
      toolName: "linear:write",
      outcome: "denied",
      decision: "deny",
      latencyMs: 5,
      requestBytes: 100,
    })

    const res = await appAs(world.admin).request(
      `/apps/mcp-manager/connections/${connId}/usage?window=1h`,
      { method: "GET" },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.calls).toBe(6)
    expect(body.data.errors).toBe(1)
    expect(body.data.p95LatencyMs).toBeGreaterThanOrEqual(10)
    expect(body.data.bytesIn).toBe(600) // 100 * 6
    expect(body.data.bytesOut).toBe(2500) // 500 * 5
    expect(body.data.topTools[0].toolName).toBe("linear:search")
    expect(body.data.topTools[0].calls).toBe(5)
  })

  it("GET /:id/usage rejects 403 without mcp_manager:usage:read", async () => {
    const partialReader: UserContext = {
      ...world.alice,
      scopes: ["mcp_manager:audit:read", "mcp_manager:connection:read"],
    }
    const res = await appAs(partialReader).request(
      `/apps/mcp-manager/connections/${connId}/usage?window=1h`,
      { method: "GET" },
    )
    expect(res.status).toBe(403)
  })
})
