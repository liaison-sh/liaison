// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0284 hands the kernel member tier's data store and dashboard scopes (added to the `member`
// preset by 0275, which only new orgs are seeded with) to the orgs created before: their
// `member` preset and their "Full Member" role. Runs the migration file itself against an org
// seeded with the cases it must tell apart:
//   - a pre-0275 `member` preset (none of the four) gains all four; its holder's permission
//     version moves and their personal agent's ceiling gains them, within an administrator's
//     narrowing when there is one;
//   - a `member` preset already holding one of them (seeded after 0275, or tuned) is left alone;
//   - "Full Member" gains all four; an app role and `admin` are untouched;
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

const TIER = [
  "kernel:dashboards:share",
  "kernel:dashboards:write",
  "kernel:data:read",
  "kernel:data:write",
]
const MIGRATION = join(import.meta.dir, "0284_kernel_member_tier_dashboards.sql")

async function runMigration(): Promise<void> {
  const statements = readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim() !== "")
  await withSystemDb("0284-test-run", async (tx) => {
    for (const statement of statements) await tx.execute(drizzleSql.raw(statement))
  })
}

const exec = <T>(label: string, q: ReturnType<typeof drizzleSql>) =>
  withSystemDb(label, async (tx) => extractRows<T>(await tx.execute(q)))

async function roleId(orgId: string, name: string): Promise<string> {
  const [row] = await exec<{ id: string }>(
    "0284-test-role",
    drizzleSql`SELECT id FROM kernel.roles WHERE org_id = ${orgId} AND name = ${name}`,
  )
  if (!row) throw new Error(`no role ${name}`)
  return row.id
}

async function grants(role: string): Promise<string[]> {
  return (
    await exec<{ scope: string }>(
      "0284-test-grants",
      drizzleSql`SELECT scope FROM kernel.role_scope_grants WHERE role_id = ${role}::uuid ORDER BY scope`,
    )
  ).map((r) => r.scope)
}

async function dropTier(role: string, keep: string[] = []): Promise<void> {
  for (const scope of TIER.filter((s) => !keep.includes(s))) {
    await exec(
      "0284-test-drop",
      drizzleSql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${role}::uuid AND scope = ${scope}`,
    )
  }
}

/** A holder of `role` with a personal agent whose ceiling is `ceiling`. */
async function holderWithAgent(
  orgId: string,
  role: string,
  ceiling: string[],
  restriction: string[] | null = null,
): Promise<{ user: string; agent: string }> {
  const user = randomUUID()
  const agent = randomUUID()
  await exec(
    "0284-test-user",
    drizzleSql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (${user}::uuid, ${orgId}, ${`0284-${user}@t.co`}, 'Holder', 'active', 'hash', 1, 1)`,
  )
  await exec(
    "0284-test-user-role",
    drizzleSql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${user}::uuid, ${role}::uuid, ${orgId})`,
  )
  await exec(
    "0284-test-agent",
    drizzleSql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling, ceiling_restriction)
      VALUES (${agent}::uuid, ${orgId}, 'personal', ${`@m0284-${user.slice(0, 8)}`}, 'Agent', ${user}::uuid,
              ${JSON.stringify(ceiling)}::jsonb, ${restriction ? JSON.stringify(restriction) : null}::jsonb)`,
  )
  return { user, agent }
}

async function permissionVersion(user: string): Promise<number> {
  const [row] = await exec<{ v: number }>(
    "0284-test-pv",
    drizzleSql`SELECT permission_version AS v FROM kernel.users WHERE id = ${user}::uuid`,
  )
  return Number(row?.v)
}

async function ceiling(agent: string): Promise<string[]> {
  const [row] = await exec<{ c: string[] }>(
    "0284-test-ceiling",
    drizzleSql`SELECT scope_ceiling AS c FROM kernel.agents WHERE id = ${agent}::uuid`,
  )
  return [...(row?.c ?? [])].sort()
}

beforeAll(acquireTestLock)

afterAll(releaseTestLock)

describe("0284: the kernel member tier reaches orgs created before 0275", () => {
  it("grants the data store and dashboard scopes to a pre-0275 member preset, its holders and their agents", async () => {
    // createTestOrg truncates the org tables: one org per case.
    const oldOrg = (await createTestOrg()).id
    const member = await roleId(oldOrg, "member")
    await dropTier(member) // as an org seeded before 0275
    const admin = await roleId(oldOrg, "admin")
    const plain = await holderWithAgent(oldOrg, member, ["kernel:threads:read"])
    const narrowed = await holderWithAgent(
      oldOrg,
      member,
      ["kernel:threads:read"],
      ["kernel:threads:read", "kernel:dashboards"],
    )
    const wide = await holderWithAgent(oldOrg, member, ["kernel:*"])

    await runMigration()

    expect(await grants(member)).toEqual(expect.arrayContaining(TIER))
    expect(await grants(admin)).toEqual(["*"])
    expect(await permissionVersion(plain.user)).toBe(2)
    expect(await ceiling(plain.agent)).toEqual(["kernel:threads:read", ...TIER].sort())
    // An administrator's narrowing keeps out what it does not cover.
    expect(await ceiling(narrowed.agent)).toEqual(
      ["kernel:dashboards:share", "kernel:dashboards:write", "kernel:threads:read"].sort(),
    )
    // A ceiling that already covers them is not rewritten.
    expect(await ceiling(wide.agent)).toEqual(["kernel:*"])

    // Re-runnable: nothing more is granted and no session is bumped again.
    await runMigration()
    expect(await permissionVersion(plain.user)).toBe(2)
    expect((await ceiling(plain.agent)).length).toBe(1 + TIER.length)
  })

  it("leaves a member preset that already holds part of the tier alone, and completes Full Member", async () => {
    const tunedOrg = (await createTestOrg()).id
    const member = await roleId(tunedOrg, "member")
    await dropTier(member, ["kernel:data:read"]) // an admin removed the rest
    const fullMember = randomUUID()
    await exec(
      "0284-test-full-member",
      drizzleSql`INSERT INTO kernel.roles (id, org_id, name, system_managed)
        VALUES (${fullMember}::uuid, ${tunedOrg}, 'Full Member', true)
        ON CONFLICT (org_id, name) DO NOTHING`,
    )
    const fm = await roleId(tunedOrg, "Full Member")
    await dropTier(fm)
    const appRole = await roleId(tunedOrg, "tickets.support")
    const appBefore = await grants(appRole)
    const tuned = await holderWithAgent(tunedOrg, member, ["kernel:threads:read"])

    await runMigration()

    expect(await grants(member)).not.toContain("kernel:dashboards:write")
    expect(await permissionVersion(tuned.user)).toBe(1)
    expect(await grants(fm)).toEqual(expect.arrayContaining(TIER))
    expect(await grants(appRole)).toEqual(appBefore)
  })
})
