// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0134 grants mcp_manager:connection:read to every role that 0133 (or an admin) gave
// mcp_manager:personal_connection:write without it. The manifest's `member` tier holds both;
// without the read scope the connection list route and the rows' SELECT policy refused a
// member holding the kernel `member` preset or a custom role, so Settings > My connections
// crashed on a permission error (regression smoke on demo, 2026-10-08).
//
// Runs the migration file itself against an org seeded with the role kinds it must tell apart:
//   - a custom member role and the kernel `member` preset holding the personal scope gain the
//     read scope, and their holders' permission_version moves;
//   - a role without the personal scope, an admin (`*`) and a manifest-managed `<app>.<role>`
//     are left alone;
//   - running it again changes nothing.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const PERSONAL = "mcp_manager:personal_connection:write"
const SCOPE = "mcp_manager:connection:read"
const MIGRATION = join(import.meta.dir, "0134_mcp_member_roles_connection_read.sql")

async function runMigration(): Promise<void> {
  const statements = readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim() !== "")
  await withSystemDb("0134-test-run", async (tx) => {
    for (const statement of statements) await tx.execute(drizzleSql.raw(statement))
  })
}

let orgId: string

async function roleId(name: string): Promise<string> {
  const rows = extractRows<{ id: string }>(
    await withSystemDb("0134-test-role", (tx) =>
      tx.execute(
        drizzleSql`SELECT id FROM kernel.roles WHERE org_id = ${orgId} AND name = ${name}`,
      ),
    ),
  )
  if (!rows[0]) throw new Error(`no role ${name}`)
  return rows[0].id
}

async function createRole(name: string, scopes: string[]): Promise<string> {
  const id = randomUUID()
  await withSystemDb("0134-test-seed-role", async (tx) => {
    await tx.execute(
      drizzleSql`INSERT INTO kernel.roles (id, org_id, name) VALUES (${id}::uuid, ${orgId}, ${name})`,
    )
    for (const scope of scopes) {
      await tx.execute(
        drizzleSql`INSERT INTO kernel.role_scope_grants (id, role_id, scope) VALUES (gen_random_uuid(), ${id}::uuid, ${scope})`,
      )
    }
  })
  return id
}

async function holderOf(role: string): Promise<string> {
  const id = randomUUID()
  await withSystemDb("0134-test-seed-user", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (${id}::uuid, ${orgId}, ${`0134-${id}@t.co`}, 'Holder', 'active', 'hash', 1, 1)
    `)
    await tx.execute(
      drizzleSql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${id}::uuid, ${role}::uuid, ${orgId})`,
    )
  })
  return id
}

async function grants(role: string): Promise<string[]> {
  return extractRows<{ scope: string }>(
    await withSystemDb("0134-test-grants", (tx) =>
      tx.execute(
        drizzleSql`SELECT scope FROM kernel.role_scope_grants WHERE role_id = ${role}::uuid`,
      ),
    ),
  ).map((r) => r.scope)
}

async function permissionVersion(user: string): Promise<number> {
  const rows = extractRows<{ v: number }>(
    await withSystemDb("0134-test-pv", (tx) =>
      tx.execute(
        drizzleSql`SELECT permission_version AS v FROM kernel.users WHERE id = ${user}::uuid`,
      ),
    ),
  )
  return Number(rows[0]?.v)
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
})

afterAll(releaseTestLock)

describe("0134: member roles that write personal MCP connections can read them", () => {
  it("grants connection:read to roles holding the personal scope, never to others, admins or manifest roles", async () => {
    const sales = await createRole("Sales team", [
      "kernel:threads:read",
      "kernel:threads:write",
      PERSONAL,
    ])
    const guest = await createRole("Guest reader", ["kernel:threads:read", "kernel:contacts:read"])
    const member = await roleId("member")
    const admin = await roleId("admin")
    const manifestRole = await roleId("tickets.support")
    await withSystemDb("0134-test-member-personal", (tx) =>
      tx.execute(
        drizzleSql`INSERT INTO kernel.role_scope_grants (id, role_id, scope) VALUES (gen_random_uuid(), ${member}::uuid, ${PERSONAL}) ON CONFLICT (role_id, scope) DO NOTHING`,
      ),
    )
    const salesHolder = await holderOf(sales)
    const guestHolder = await holderOf(guest)
    const manifestBefore = (await grants(manifestRole)).sort()
    expect(await grants(sales)).not.toContain(SCOPE)

    await runMigration()

    expect(await grants(sales)).toContain(SCOPE)
    expect(await grants(member)).toContain(SCOPE)
    expect(await grants(guest)).not.toContain(SCOPE)
    expect(await grants(admin)).toEqual(["*"])
    expect((await grants(manifestRole)).sort()).toEqual(manifestBefore)
    expect(await permissionVersion(salesHolder)).toBe(2)
    expect(await permissionVersion(guestHolder)).toBe(1)

    // Re-runnable: nothing more is granted and no session is bumped again.
    await runMigration()
    expect((await grants(sales)).filter((s) => s === SCOPE)).toHaveLength(1)
    expect(await permissionVersion(salesHolder)).toBe(2)
  })
})
