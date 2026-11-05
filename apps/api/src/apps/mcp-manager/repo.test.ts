// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { McpRoleOverride } from "~/db/schema/app_mcp_manager"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { McpManagerRepoTestAccess, makeMcpRepo } from "./repo"
import { buildMcpWorld, type McpTestWorld } from "./test-helpers/world"

async function seedConnection(
  world: McpTestWorld,
  opts: {
    defaultPolicy?: "auto" | "gate_writes" | "gate_all"
    orgId?: string
    ownerUserId?: string
    slug?: string
  } = {},
): Promise<string> {
  const orgId = opts.orgId ?? world.org.id
  const adminId = opts.ownerUserId ?? world.admin.userId
  const slug = opts.slug ?? `seed-${crypto.randomBytes(3).toString("hex")}`
  return withSystemDb("repo-test-seed-conn", async (db) => {
    const rows = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO app_mcp_manager.mcp_connections
          (org_id, slug, display_name, transport, ownership_scope, http_url,
           auth_flavor, created_by, connection_default_policy)
        VALUES
          (${orgId}, ${slug}, ${slug}, 'http', 'org', 'https://x.example',
           'none', ${adminId},
           ${opts.defaultPolicy ?? "gate_writes"}::app_mcp_manager.mcp_default_policy)
        RETURNING id
      `),
    )
    return rows[0].id
  })
}

async function seedToolPolicy(
  connectionId: string,
  toolName: string,
  opts: {
    overrideDecision?: "auto" | "gate" | "deny" | null
    roleOverrides?: McpRoleOverride[]
  },
): Promise<void> {
  await withSystemDb("repo-test-seed-policy", async (db) => {
    const overrideJson = JSON.stringify(opts.roleOverrides ?? [])
    await db.execute(drizzleSql`
      INSERT INTO app_mcp_manager.mcp_tool_policy
        (connection_id, tool_name, override_decision, role_overrides)
      VALUES
        (${connectionId}, ${toolName},
         ${opts.overrideDecision ?? null}::app_mcp_manager.mcp_decision,
         ${overrideJson}::jsonb)
    `)
  })
}

describe("McpRepo", () => {
  let world: McpTestWorld

  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
  })
  beforeEach(async () => {
    McpManagerRepoTestAccess.clearAnnotationCache()
    world = await buildMcpWorld()
  })

  it("listForOrgBootstrap returns the org's enabled rows only (privileged read)", async () => {
    await seedConnection(world, { slug: "a-conn" })
    await seedConnection(world, {
      orgId: world.otherOrg.id,
      ownerUserId: world.otherAdmin.userId,
      slug: "b-conn",
    })
    const rows = await makeMcpRepo().listForOrgBootstrap(world.otherOrg.id)
    const slugs = rows.map((r) => r.slug)
    expect(slugs).not.toContain("a-conn")
    expect(slugs).toContain("b-conn")
  })

  it("getPolicyForCall — role override resolves most-permissively", async () => {
    const repo = makeMcpRepo()
    const connId = await seedConnection(world, { defaultPolicy: "gate_all" })
    await seedToolPolicy(connId, "create_issue", {
      overrideDecision: "deny",
      roleOverrides: [
        { roleId: world.roles.editor, decision: "deny" },
        { roleId: world.roles.viewer, decision: "auto" },
      ],
    })
    // Alice has both editor + viewer roles → permissive max is "auto" (viewer).
    const aliceWithRoles = {
      ...world.alice,
      roleIds: [world.roles.editor, world.roles.viewer],
      scopes: ["mcp_manager:policy:read", "mcp_manager:connection:read"],
    }
    const res = await repo.getPolicyForCall(connId, "create_issue", aliceWithRoles)
    expect(res.decision).toBe("auto")
    expect(res.policyPath).toBe("role")
    expect(res.policyRoleId).toBe(world.roles.viewer)
  })

  it("getPolicyForCall — falls through to tool override when no role matches", async () => {
    const repo = makeMcpRepo()
    const connId = await seedConnection(world, { defaultPolicy: "gate_writes" })
    await seedToolPolicy(connId, "read_issue", {
      overrideDecision: "auto",
      roleOverrides: [],
    })
    const aliceReader = {
      ...world.alice,
      roleIds: [],
      scopes: ["mcp_manager:policy:read", "mcp_manager:connection:read"],
    }
    const res = await repo.getPolicyForCall(connId, "read_issue", aliceReader)
    expect(res).toEqual({ decision: "auto", policyPath: "tool" })
  })

  it("getPolicyForCall — gate_writes runs a tool the server marks read-only, gates the rest", async () => {
    const repo = makeMcpRepo()
    const connId = await seedConnection(world, { defaultPolicy: "gate_writes" })
    await repo.upsertToolAnnotations(connId, [
      { name: "list_issues", annotations: { readOnlyHint: true } },
      { name: "wipe_issues", annotations: { readOnlyHint: true, destructiveHint: true } },
      { name: "update_issue", annotations: { readOnlyHint: false } },
      { name: "bare_tool", annotations: {} },
    ])
    const aliceReader = {
      ...world.alice,
      roleIds: [],
      scopes: ["mcp_manager:policy:read", "mcp_manager:connection:read"],
    }
    const decide = async (tool: string) =>
      (await repo.getPolicyForCall(connId, tool, aliceReader)).decision
    expect({
      readOnly: await decide("list_issues"),
      readOnlyButDestructive: await decide("wipe_issues"),
      write: await decide("update_issue"),
      noHints: await decide("bare_tool"),
      neverListed: await decide("delete_issue"),
    }).toEqual({
      readOnly: "auto",
      readOnlyButDestructive: "gate",
      write: "gate",
      noHints: "gate",
      neverListed: "gate",
    })
    const readRes = await repo.getPolicyForCall(connId, "list_issues", aliceReader)
    expect(readRes.policyPath).toBe("connection_default")
  })

  it("getPolicyForCall — gate_all gates a read-only tool; auto runs an unannotated one", async () => {
    const repo = makeMcpRepo()
    const gateAll = await seedConnection(world, { defaultPolicy: "gate_all" })
    const auto = await seedConnection(world, { defaultPolicy: "auto" })
    await repo.upsertToolAnnotations(gateAll, [
      { name: "list_issues", annotations: { readOnlyHint: true } },
    ])
    const aliceReader = {
      ...world.alice,
      roleIds: [],
      scopes: ["mcp_manager:policy:read", "mcp_manager:connection:read"],
    }
    expect((await repo.getPolicyForCall(gateAll, "list_issues", aliceReader)).decision).toBe("gate")
    expect((await repo.getPolicyForCall(auto, "delete_issue", aliceReader)).decision).toBe("auto")
  })

  it("getPolicyForCall — a per-tool override still wins over the read-only rule", async () => {
    const repo = makeMcpRepo()
    const connId = await seedConnection(world, { defaultPolicy: "gate_writes" })
    await repo.upsertToolAnnotations(connId, [
      { name: "list_issues", annotations: { readOnlyHint: true } },
    ])
    await seedToolPolicy(connId, "list_issues", { overrideDecision: "gate", roleOverrides: [] })
    const aliceReader = {
      ...world.alice,
      roleIds: [],
      scopes: ["mcp_manager:policy:read", "mcp_manager:connection:read"],
    }
    const res = await repo.getPolicyForCall(connId, "list_issues", aliceReader)
    expect(res).toEqual({ decision: "gate", policyPath: "tool" })
  })

  it("recordHealth upserts the per-connection row", async () => {
    const repo = makeMcpRepo()
    const connId = await seedConnection(world, {})
    await repo.recordHealth(connId, { status: "down", lastError: "ECONNREFUSED" })
    await repo.recordHealth(connId, {
      status: "connected",
      lastError: null,
      consecutiveFailures: 0,
    })
    const rows = extractRows<{ status: string; last_error: string | null }>(
      await withSystemDb("read-health", (db) =>
        db.execute(drizzleSql`
          SELECT status, last_error FROM app_mcp_manager.mcp_connection_health
          WHERE connection_id = ${connId}
        `),
      ),
    )
    expect(rows[0].status).toBe("connected")
    expect(rows[0].last_error).toBeNull()
  })
})
