// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { makeMcpRepo } from "~/apps/mcp-manager/repo"
import { buildMcpWorld, type McpTestWorld } from "~/apps/mcp-manager/test-helpers/world"
import { withSystemDb } from "~/db/privileged"
import { mcpConnectionHealth, mcpConnections } from "~/db/schema/app_mcp_manager"
import { HealthTracker } from "~/modules/mcp-client/health"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

async function seedConnection(
  world: McpTestWorld,
  overrides: Record<string, unknown>,
): Promise<string> {
  return withSystemDb("seed-conn", async (db) => {
    const [row] = await db
      .insert(mcpConnections)
      .values({
        orgId: world.org.id,
        slug: `tracker-${Math.random().toString(36).slice(2, 8)}`,
        displayName: "Tracker Test",
        transport: "http",
        httpUrl: "https://example.test",
        authFlavor: "none",
        managedBy: "ui",
        createdBy: world.admin.userId,
        ...overrides,
      })
      .returning({ id: mcpConnections.id })
    return row.id
  })
}

describe("HealthTracker", () => {
  let world: McpTestWorld

  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
  })
  beforeEach(async () => {
    world = await buildMcpWorld()
  })

  it("markConnected sets status='connected' and resets counter", async () => {
    const connId = await seedConnection(world, {})
    const tracker = new HealthTracker(makeMcpRepo())
    await tracker.markDialFailed(connId, new Error("boom"))
    await tracker.markConnected(connId)
    const [row] = await withSystemDb("r", (db) =>
      db.select().from(mcpConnectionHealth).where(eq(mcpConnectionHealth.connectionId, connId)),
    )
    expect(row.status).toBe("connected")
    expect(row.consecutiveFailures).toBe(0)
    expect(row.lastHandshakeAt).not.toBeNull()
  })

  it("markDialFailed increments consecutive_failures and surfaces last error", async () => {
    const connId = await seedConnection(world, {})
    const tracker = new HealthTracker(makeMcpRepo())
    await tracker.markDialFailed(connId, new Error("ECONNREFUSED"))
    await tracker.markDialFailed(connId, new Error("ETIMEDOUT"))
    const [row] = await withSystemDb("r", (db) =>
      db.select().from(mcpConnectionHealth).where(eq(mcpConnectionHealth.connectionId, connId)),
    )
    expect(row.status).toBe("down")
    expect(row.consecutiveFailures).toBe(2)
    expect(row.lastError).toContain("ETIMEDOUT")
    expect(row.lastErrorAt).not.toBeNull()
  })

  it("markNeedsReauth flips to needs_reauth and persists reason", async () => {
    const connId = await seedConnection(world, {})
    const tracker = new HealthTracker(makeMcpRepo())
    await tracker.markNeedsReauth(connId, "refresh token expired")
    const [row] = await withSystemDb("r", (db) =>
      db.select().from(mcpConnectionHealth).where(eq(mcpConnectionHealth.connectionId, connId)),
    )
    expect(row.status).toBe("needs_reauth")
    expect(row.lastError).toBe("refresh token expired")
  })

  it("a successful call does not clear needs_reauth: only a new sign-in does", async () => {
    // A 403 insufficient_scope leaves the token good for other tools, so a
    // later success must not hide the "Sign in again" the user still owes.
    const connId = await seedConnection(world, {})
    const tracker = new HealthTracker(makeMcpRepo())
    await tracker.markNeedsReauth(connId, "insufficient_scope")
    // Another process (a fresh tracker, empty cache) records a success.
    await new HealthTracker(makeMcpRepo()).markConnected(connId)
    const read = async () =>
      (
        await withSystemDb("r", (db) =>
          db.select().from(mcpConnectionHealth).where(eq(mcpConnectionHealth.connectionId, connId)),
        )
      )[0]
    expect((await read()).status).toBe("needs_reauth")
    await tracker.clearNeedsReauth(connId)
    expect((await read()).status).toBe("idle")
    await tracker.markConnected(connId)
    expect((await read()).status).toBe("connected")
  })

  it("getCachedStatus returns last write without DB round-trip", async () => {
    const connId = await seedConnection(world, {})
    const tracker = new HealthTracker(makeMcpRepo())
    expect(tracker.getCachedStatus(connId)).toBeNull()
    await tracker.markConnected(connId)
    expect(tracker.getCachedStatus(connId)).toBe("connected")
  })

  it("does NOT expose markDisabled — 'disabled' is owned by mcp_connections.disabled (spec §3.4)", () => {
    const tracker = new HealthTracker(makeMcpRepo())
    expect("markDisabled" in tracker).toBe(false)
    // Status enum doesn't include "disabled" either — single source of truth.
    expect(["connected", "idle", "dialing", "down", "failed", "needs_reauth"]).not.toContain(
      "disabled",
    )
  })
})
