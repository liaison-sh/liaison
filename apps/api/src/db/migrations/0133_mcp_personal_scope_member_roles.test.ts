// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0133 grants mcp_manager:personal_connection:write to every existing MEMBER role (S16, A31:
// "granted to every member role by default"). 0125 only reached the mcp-manager manifest's
// `member` role and the system-managed Full Member, so in an org whose people hold the kernel
// `member` preset or a custom role, nobody could add a personal MCP connection until an admin
// edited every role by hand.
//
// Runs the migration file itself (it already ran once on this DB through db:migrate, before
// these rows existed) against an org seeded with the role kinds it must tell apart:
//   - a custom member role and the kernel `member` preset gain the scope, and their holders'
//     permission_version moves so live sessions pick it up;
//   - a read-only role (the `viewer` preset, a custom guest-like role), a guest-like role with a
//     narrow write scope (fix8 M3: a member role writes conversations AND contacts), an admin
//     (`*`), and a
//     manifest-managed `<app>.<role>` (reseeded by the app on every boot) are left alone;
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

const SCOPE = "mcp_manager:personal_connection:write"
const MIGRATION = join(import.meta.dir, "0133_mcp_personal_scope_member_roles.sql")

async function runMigration(): Promise<void> {
  const statements = readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim() !== "")
  await withSystemDb("0133-test-run", async (tx) => {
    for (const statement of statements) await tx.execute(drizzleSql.raw(statement))
  })
}

let orgId: string

async function roleId(name: string): Promise<string> {
  const rows = extractRows<{ id: string }>(
    await withSystemDb("0133-test-role", (tx) =>
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
  await withSystemDb("0133-test-seed-role", async (tx) => {
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
  await withSystemDb("0133-test-seed-user", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (${id}::uuid, ${orgId}, ${`0133-${id}@t.co`}, 'Holder', 'active', 'hash', 1, 1)
    `)
    await tx.execute(
      drizzleSql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${id}::uuid, ${role}::uuid, ${orgId})`,
    )
  })
  return id
}

async function grants(role: string): Promise<string[]> {
  return extractRows<{ scope: string }>(
    await withSystemDb("0133-test-grants", (tx) =>
      tx.execute(
        drizzleSql`SELECT scope FROM kernel.role_scope_grants WHERE role_id = ${role}::uuid`,
      ),
    ),
  ).map((r) => r.scope)
}

async function permissionVersion(user: string): Promise<number> {
  const rows = extractRows<{ v: number }>(
    await withSystemDb("0133-test-pv", (tx) =>
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

describe("0133: personal MCP connections for every member role", () => {
  it("grants the scope to custom and preset member roles, never to read-only, admin or manifest roles", async () => {
    const sales = await createRole("Sales team", [
      "kernel:threads:read",
      "kernel:threads:write",
      "kernel:contacts:read",
      "kernel:contacts:write",
    ])
    const guest = await createRole("Guest reader", ["kernel:threads:read", "kernel:contacts:read"])
    // fix8 M3: a guest-like role with a write scope is not a member role. The first 0133
    // granted it (one grant not ending in `:read`); the rule is now the member preset's
    // baseline, writing conversations AND contacts.
    const replier = await createRole("Ticket replier", [
      "kernel:threads:read",
      "tickets:tickets:read",
      "tickets:tickets:reply",
    ])
    const threadsOnly = await createRole("Thread poster", [
      "kernel:threads:read",
      "kernel:threads:write",
    ])
    // A role whose grants cover the baseline through a parent scope is a member role.
    const kernelWide = await createRole("Kernel wide", ["kernel:threads", "kernel:contacts:*"])
    const replierHolder = await holderOf(replier)
    const member = await roleId("member")
    const viewer = await roleId("viewer")
    const admin = await roleId("admin")
    const manifestRole = await roleId("tickets.support")
    const salesHolder = await holderOf(sales)
    const guestHolder = await holderOf(guest)
    const manifestBefore = (await grants(manifestRole)).sort()
    expect(await grants(sales)).not.toContain(SCOPE)

    await runMigration()

    expect(await grants(sales)).toContain(SCOPE)
    expect(await grants(member)).toContain(SCOPE)
    expect(await grants(guest)).not.toContain(SCOPE)
    expect(await grants(replier)).not.toContain(SCOPE)
    expect(await grants(threadsOnly)).not.toContain(SCOPE)
    expect(await grants(kernelWide)).toContain(SCOPE)
    expect(await permissionVersion(replierHolder)).toBe(1)
    expect(await grants(viewer)).not.toContain(SCOPE)
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
