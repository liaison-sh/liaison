// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { and, eq } from "drizzle-orm"
import { buildMcpWorld, type McpTestWorld } from "~/apps/mcp-manager/test-helpers/world"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { runEnvBootstrap } from "~/modules/mcp-client/env-bootstrapper"
import {
  applyMcpConnectionEvent,
  ensureMcpOrg,
  initMcpClient,
  McpClientTestAccess,
} from "~/modules/mcp-client/index"
import { slugIndex } from "~/modules/mcp-client/slug-index"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("runEnvBootstrap", () => {
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

  it("upserts a new env connection", async () => {
    await runEnvBootstrap({
      LIAISON_MCP_LINEAR_TRANSPORT: "http",
      LIAISON_MCP_LINEAR_DISPLAY_NAME: "Linear",
      LIAISON_MCP_LINEAR_ORG: world.org.id,
      LIAISON_MCP_LINEAR_URL: "https://mcp.linear.app",
      LIAISON_MCP_LINEAR_AUTH: "bearer",
      LIAISON_MCP_LINEAR_BEARER_TOKEN: "tk-1",
    })
    const [row] = await withSystemDb("read", (db) =>
      db
        .select()
        .from(mcpConnections)
        .where(and(eq(mcpConnections.orgId, world.org.id), eq(mcpConnections.slug, "linear"))),
    )
    expect(row).toBeDefined()
    expect(row.managedBy).toBe("env")
    expect(row.transport).toBe("http")
    expect(row.httpUrl).toBe("https://mcp.linear.app")
    expect(row.secretsEncrypted).not.toBeNull()
  })

  it("a process that projected the org before the leader's bootstrap converges from its event", async () => {
    McpClientTestAccess.reset()
    await initMcpClient({ skipEnvBootstrap: true, skipReapTimer: true })
    try {
      // A peer: it projected the org (its first touch) before the env row existed.
      await ensureMcpOrg(world.org.id)
      await runEnvBootstrap({
        LIAISON_MCP_PEERSYNC_TRANSPORT: "http",
        LIAISON_MCP_PEERSYNC_DISPLAY_NAME: "Peer sync",
        LIAISON_MCP_PEERSYNC_ORG: world.org.id,
        LIAISON_MCP_PEERSYNC_URL: "https://peersync.example",
        LIAISON_MCP_PEERSYNC_AUTH: "none",
      })
      expect(slugIndex.get(world.org.id, "peersync")).toBeUndefined()
      const [row] = await withSystemDb("read", (db) =>
        db
          .select({ id: mcpConnections.id })
          .from(mcpConnections)
          .where(and(eq(mcpConnections.orgId, world.org.id), eq(mcpConnections.slug, "peersync"))),
      )
      // The bootstrap queued the connection event every process applies.
      const events = await sql<{ payload: Parameters<typeof applyMcpConnectionEvent>[0] }[]>`
        SELECT payload FROM kernel.pending_events
        WHERE org_id = ${world.org.id} AND payload->>'entityId' = ${row.id}`
      expect(events.length).toBe(1)
      for (const e of events) await applyMcpConnectionEvent(e.payload)
      expect(slugIndex.get(world.org.id, "peersync")).toBe(row.id)
    } finally {
      McpClientTestAccess.reset()
    }
  })

  it("two runs at once with the same env both succeed and leave one row", async () => {
    const env = {
      LIAISON_MCP_RACE_TRANSPORT: "http",
      LIAISON_MCP_RACE_DISPLAY_NAME: "Race",
      LIAISON_MCP_RACE_ORG: world.org.id,
      LIAISON_MCP_RACE_URL: "https://race.example",
      LIAISON_MCP_RACE_AUTH: "none",
    }
    await Promise.all([runEnvBootstrap(env), runEnvBootstrap(env)])
    const rows = await withSystemDb("read", (db) =>
      db
        .select()
        .from(mcpConnections)
        .where(and(eq(mcpConnections.orgId, world.org.id), eq(mcpConnections.slug, "race"))),
    )
    expect(rows).toHaveLength(1)
  })

  it("two leaders in turn with different env: the rows equal the second's", async () => {
    const base = {
      LIAISON_MCP_TURN_TRANSPORT: "http",
      LIAISON_MCP_TURN_ORG: world.org.id,
      LIAISON_MCP_TURN_AUTH: "none",
    }
    await runEnvBootstrap({
      ...base,
      LIAISON_MCP_TURN_DISPLAY_NAME: "Old",
      LIAISON_MCP_TURN_URL: "https://old.example",
    })
    await runEnvBootstrap({
      ...base,
      LIAISON_MCP_TURN_DISPLAY_NAME: "New",
      LIAISON_MCP_TURN_URL: "https://new.example",
    })
    const rows = await withSystemDb("read", (db) =>
      db
        .select()
        .from(mcpConnections)
        .where(and(eq(mcpConnections.orgId, world.org.id), eq(mcpConnections.slug, "turn"))),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.displayName).toBe("New")
    expect(rows[0]?.httpUrl).toBe("https://new.example")
  })

  it("env wins over an existing ui-managed row with the same slug", async () => {
    // Seed a ui-managed row
    await withSystemDb("seed", (db) =>
      db.insert(mcpConnections).values({
        orgId: world.org.id,
        slug: "linear",
        displayName: "Linear (UI)",
        transport: "http",
        httpUrl: "https://old",
        authFlavor: "none",
        managedBy: "ui",
        createdBy: world.admin.userId,
      }),
    )
    // Re-run env bootstrap with new url
    await runEnvBootstrap({
      LIAISON_MCP_LINEAR_TRANSPORT: "http",
      LIAISON_MCP_LINEAR_DISPLAY_NAME: "Linear (ENV)",
      LIAISON_MCP_LINEAR_ORG: world.org.id,
      LIAISON_MCP_LINEAR_URL: "https://new",
      LIAISON_MCP_LINEAR_AUTH: "none",
    })
    const [row] = await withSystemDb("read", (db) =>
      db
        .select()
        .from(mcpConnections)
        .where(and(eq(mcpConnections.orgId, world.org.id), eq(mcpConnections.slug, "linear"))),
    )
    expect(row.managedBy).toBe("env")
    expect(row.httpUrl).toBe("https://new")
    expect(row.displayName).toBe("Linear (ENV)")
  })

  it("orphans an env row when its env vars are removed at next boot", async () => {
    await runEnvBootstrap({
      LIAISON_MCP_LINEAR_TRANSPORT: "http",
      LIAISON_MCP_LINEAR_DISPLAY_NAME: "Linear",
      LIAISON_MCP_LINEAR_ORG: world.org.id,
      LIAISON_MCP_LINEAR_URL: "https://x",
      LIAISON_MCP_LINEAR_AUTH: "none",
    })
    await runEnvBootstrap({}) // env vars removed
    const [row] = await withSystemDb("read", (db) =>
      db
        .select()
        .from(mcpConnections)
        .where(and(eq(mcpConnections.orgId, world.org.id), eq(mcpConnections.slug, "linear"))),
    )
    expect(row).toBeDefined()
    expect(row.managedBy).toBe("ui")
    expect(row.displayName).toMatch(/^\[orphaned\] /)
  })

  it("env-managed row is re-orphaned idempotently (no double-prefix)", async () => {
    await runEnvBootstrap({
      LIAISON_MCP_LINEAR_TRANSPORT: "http",
      LIAISON_MCP_LINEAR_DISPLAY_NAME: "Linear",
      LIAISON_MCP_LINEAR_ORG: world.org.id,
      LIAISON_MCP_LINEAR_URL: "https://x",
      LIAISON_MCP_LINEAR_AUTH: "none",
    })
    await runEnvBootstrap({})
    await runEnvBootstrap({}) // run again — already orphaned, should be no-op
    const [row] = await withSystemDb("read", (db) =>
      db
        .select()
        .from(mcpConnections)
        .where(and(eq(mcpConnections.orgId, world.org.id), eq(mcpConnections.slug, "linear"))),
    )
    expect(row.displayName).toBe("[orphaned] Linear")
  })

  it("env bootstrap is idempotent (re-running with same vars does not change row)", async () => {
    const envVars = {
      LIAISON_MCP_LINEAR_TRANSPORT: "http",
      LIAISON_MCP_LINEAR_DISPLAY_NAME: "Linear",
      LIAISON_MCP_LINEAR_ORG: world.org.id,
      LIAISON_MCP_LINEAR_URL: "https://x",
      LIAISON_MCP_LINEAR_AUTH: "none",
    }
    await runEnvBootstrap(envVars)
    const [row1] = await withSystemDb("read", (db) =>
      db
        .select()
        .from(mcpConnections)
        .where(and(eq(mcpConnections.orgId, world.org.id), eq(mcpConnections.slug, "linear"))),
    )
    const id1 = row1.id
    await runEnvBootstrap(envVars)
    const [row2] = await withSystemDb("read", (db) =>
      db
        .select()
        .from(mcpConnections)
        .where(and(eq(mcpConnections.orgId, world.org.id), eq(mcpConnections.slug, "linear"))),
    )
    expect(row2.id).toBe(id1) // upsert, not replace
    expect(row2.managedBy).toBe("env")
  })
})
