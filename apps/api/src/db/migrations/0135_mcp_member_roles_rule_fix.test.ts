// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0135 takes back what the FIRST 0133 granted beyond member roles (fix8 M3). That version
// took any role with one grant not ending in `:read` for a member role, so a guest-like role
// that may only reply to tickets received mcp_manager:personal_connection:write, and through
// 0134 mcp_manager:connection:read. 0133 now names member roles by the kernel `member`
// preset's baseline (writing conversations AND contacts); 0135 corrects a database (demo)
// that ran the first version.
//
// Runs the migration file itself against roles seeded as the first 0133 + 0134 left them:
//   - a guest-like role holding both scopes with no hand-grant trail loses both, and its
//     holders' permission_version moves;
//   - the same role whose personal scope an admin granted by hand (a `role_scope.grant`
//     audit row, which grantScope leaves and a migration does not) keeps both scopes;
//   - a role whose read scope alone was hand granted keeps the read scope;
//   - a member role, an admin (`*`) and a manifest-managed `<app>.<role>` are left alone;
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
const READ = "mcp_manager:connection:read"
const MIGRATION = join(import.meta.dir, "0135_mcp_member_roles_rule_fix.sql")

async function runMigration(): Promise<void> {
  const statements = readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim() !== "")
  await withSystemDb("0135-test-run", async (tx) => {
    for (const statement of statements) await tx.execute(drizzleSql.raw(statement))
  })
}

let orgId: string

async function roleId(name: string): Promise<string> {
  const rows = extractRows<{ id: string }>(
    await withSystemDb("0135-test-role", (tx) =>
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
  await withSystemDb("0135-test-seed-role", async (tx) => {
    await tx.execute(
      drizzleSql`INSERT INTO kernel.roles (id, org_id, name) VALUES (${id}::uuid, ${orgId}, ${name})`,
    )
    for (const scope of scopes) await addGrant(tx, id, scope)
  })
  return id
}

async function addGrant(
  tx: Parameters<Parameters<typeof withSystemDb>[1]>[0],
  role: string,
  scope: string,
): Promise<void> {
  await tx.execute(
    drizzleSql`INSERT INTO kernel.role_scope_grants (id, role_id, scope) VALUES (gen_random_uuid(), ${role}::uuid, ${scope}) ON CONFLICT DO NOTHING`,
  )
}

/** The audit row grantScope's role_scope:grant event leaves (event-subscribers.ts). */
async function handGranted(role: string, scope: string): Promise<void> {
  await withSystemDb("0135-test-audit", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO kernel.audit_log (org_id, actor_type, app, entity_type, entity_id, action, changes)
      VALUES (${orgId}, 'user', 'kernel', 'role_scope', ${role}, 'role_scope.grant',
              ${JSON.stringify({ roleId: role, scope })}::jsonb)
    `),
  )
}

async function holderOf(role: string): Promise<string> {
  const id = randomUUID()
  await withSystemDb("0135-test-seed-user", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (${id}::uuid, ${orgId}, ${`0135-${id}@t.co`}, 'Holder', 'active', 'hash', 1, 1)
    `)
    await tx.execute(
      drizzleSql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${id}::uuid, ${role}::uuid, ${orgId})`,
    )
  })
  return id
}

async function grants(role: string): Promise<string[]> {
  return extractRows<{ scope: string }>(
    await withSystemDb("0135-test-grants", (tx) =>
      tx.execute(
        drizzleSql`SELECT scope FROM kernel.role_scope_grants WHERE role_id = ${role}::uuid`,
      ),
    ),
  )
    .map((r) => r.scope)
    .sort()
}

async function permissionVersion(user: string): Promise<number> {
  const rows = extractRows<{ v: number }>(
    await withSystemDb("0135-test-pv", (tx) =>
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

describe("0135: the personal MCP scopes leave the roles the first 0133 reached beyond members", () => {
  it("revokes them from a guest-like role, never a hand grant, a member, admin or manifest role", async () => {
    const guestLike = ["kernel:threads:read", "tickets:tickets:read", "tickets:tickets:reply"]
    // As the first 0133 + 0134 left them.
    const replier = await createRole("Ticket replier", [...guestLike, PERSONAL, READ])
    const replierHolder = await holderOf(replier)
    const handPersonal = await createRole("Replier with a hand grant", [
      ...guestLike,
      PERSONAL,
      READ,
    ])
    await handGranted(handPersonal, PERSONAL)
    const handRead = await createRole("Replier who reads by hand", [...guestLike, PERSONAL, READ])
    await handGranted(handRead, READ)
    const team = await createRole("Sales team", [
      "kernel:threads:read",
      "kernel:threads:write",
      "kernel:contacts:read",
      "kernel:contacts:write",
      PERSONAL,
      READ,
    ])
    const teamHolder = await holderOf(team)
    const member = await roleId("member")
    await withSystemDb("0135-test-member", async (tx) => {
      await addGrant(tx, member, PERSONAL)
      await addGrant(tx, member, READ)
    })
    const admin = await roleId("admin")
    const manifestRole = await roleId("tickets.support")
    await withSystemDb("0135-test-manifest", (tx) => addGrant(tx, manifestRole, PERSONAL))
    const manifestBefore = await grants(manifestRole)
    const teamBefore = await grants(team)
    const memberBefore = await grants(member)

    await runMigration()

    expect(await grants(replier)).toEqual([...guestLike].sort())
    expect(await permissionVersion(replierHolder)).toBe(2)
    expect(await grants(handPersonal)).toEqual([...guestLike, PERSONAL, READ].sort())
    expect(await grants(handRead)).toEqual([...guestLike, READ].sort())
    expect(await grants(team)).toEqual(teamBefore)
    expect(await permissionVersion(teamHolder)).toBe(1)
    expect(await grants(member)).toEqual(memberBefore)
    expect(await grants(admin)).toEqual(["*"])
    expect(await grants(manifestRole)).toEqual(manifestBefore)

    // Re-runnable: nothing more is revoked and no session is bumped again.
    await runMigration()
    expect(await grants(replier)).toEqual([...guestLike].sort())
    expect(await grants(handPersonal)).toEqual([...guestLike, PERSONAL, READ].sort())
    expect(await permissionVersion(replierHolder)).toBe(2)
  })
})
