// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("0000_initial migration", () => {
  it("allows approval thread type", async () => {
    const rows = extractRows<{ def: string }>(
      await withSystemDb("migration-threads-type-check", (db) =>
        db.execute(drizzleSql`
          SELECT pg_get_constraintdef(c.oid) AS def
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE c.conname = 'threads_type_check' AND n.nspname = 'kernel'
        `),
      ),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].def).toContain("'approval'")
  })

  it("allows subrun thread type (folded from 0004)", async () => {
    const rows = extractRows<{ def: string }>(
      await withSystemDb("migration-threads-type-subrun", (db) =>
        db.execute(drizzleSql`
          SELECT pg_get_constraintdef(c.oid) AS def
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE c.conname = 'threads_type_check' AND n.nspname = 'kernel'
        `),
      ),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].def).toContain("'subrun'")
  })

  it("keeps approval request RLS scope matching segment-safe", async () => {
    const rows = extractRows<{ expr: string }>(
      await withSystemDb("migration-approval-rls-policy", (db) =>
        db.execute(drizzleSql`
          SELECT pg_get_expr(polqual, polrelid) AS expr
          FROM pg_policy
          WHERE polname = 'approval_requests_select'
        `),
      ),
    )
    const expr = rows[0]?.expr ?? ""

    expect(expr).toMatch(/"?left"?\(required\.scope, \(length\(g\.scope\) \+ 1\)\)/)
    expect(expr).toMatch(/"?left"?\(required\.scope, \(length\(rsg\.scope\) \+ 1\)\)/)
    expect(expr).not.toMatch(/required\.scope\s+(~~|LIKE)\s+/i)
  })
})

// mcp_manager schema assertions (folded from 0003_app_mcp_manager.test.ts).
async function pickAdminUserId(orgId: string): Promise<string> {
  return withSystemDb("test-mcp-pick-user", async (db) => {
    const rows = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id FROM kernel.users WHERE org_id = ${orgId} LIMIT 1
      `),
    )
    if (!rows[0]) throw new Error("no users in test org")
    return rows[0].id
  })
}

describe("app_mcp_manager schema (folded from 0003)", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
  })

  // mcp_connection_access arrives in 0198 (who may use an org MCP server).
  it("creates app_mcp_manager schema with all six tables", async () => {
    const rows = extractRows<{ table_name: string }>(
      await withSystemDb("test-mcp-mig", (db) =>
        db.execute(drizzleSql`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'app_mcp_manager'
          ORDER BY table_name
        `),
      ),
    )
    const names = rows.map((r) => r.table_name)
    expect(names).toEqual([
      "mcp_connection_access",
      "mcp_connection_health",
      "mcp_connections",
      "mcp_oauth_state",
      "mcp_resource_subscription",
      "mcp_tool_policy",
    ])
  })

  it("enforces UNIQUE(org_id, slug) on mcp_connections", async () => {
    const org = await createTestOrg()
    const adminId = await pickAdminUserId(org.id)
    const slug = `dup-${crypto.randomBytes(3).toString("hex")}`
    let err: unknown
    try {
      await withSystemDb("test-mcp-dup", async (db) => {
        await db.execute(drizzleSql`
          INSERT INTO app_mcp_manager.mcp_connections
            (org_id, slug, display_name, transport, ownership_scope, http_url, auth_flavor, created_by)
          VALUES
            (${org.id}, ${slug}, 'A', 'http', 'org', 'https://a.example', 'none', ${adminId}),
            (${org.id}, ${slug}, 'B', 'http', 'org', 'https://b.example', 'none', ${adminId})
        `)
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    const cause = (err as { cause?: { constraint_name?: string; code?: string } })?.cause
    expect(cause?.constraint_name).toBe("uq_mcp_connections_org_slug")
    expect(cause?.code).toBe("23505")
  })

  it("mcp_connection_health.status enum has no 'disabled' value", async () => {
    const rows = extractRows<{ enumlabel: string }>(
      await withSystemDb("test-mcp-enum", (db) =>
        db.execute(drizzleSql`
          SELECT enumlabel FROM pg_enum
          WHERE enumtypid = 'app_mcp_manager.mcp_connection_health_status'::regtype
          ORDER BY enumsortorder
        `),
      ),
    )
    const labels = rows.map((r) => r.enumlabel)
    expect(labels).toEqual(["connected", "idle", "dialing", "down", "failed", "needs_reauth"])
  })

  it("rejects personal connection without owner_user_id (CHECK constraint)", async () => {
    const org = await createTestOrg()
    const adminId = await pickAdminUserId(org.id)
    const slug = `bad-${crypto.randomBytes(3).toString("hex")}`
    let err: unknown
    try {
      await withSystemDb("test-mcp-personal-check", async (db) => {
        await db.execute(drizzleSql`
          INSERT INTO app_mcp_manager.mcp_connections
            (org_id, slug, display_name, transport, ownership_scope, owner_user_id, http_url, auth_flavor, created_by)
          VALUES
            (${org.id}, ${slug}, 'X', 'http', 'personal', NULL, 'https://x.example', 'none', ${adminId})
        `)
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    const cause = (err as { cause?: { constraint_name?: string; code?: string } })?.cause
    expect(cause?.constraint_name).toBe("mcp_connections_personal_owner_check")
    expect(cause?.code).toBe("23514")
  })
})
