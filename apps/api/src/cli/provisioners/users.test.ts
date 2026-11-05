// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB unit test for the users provisioner (Task 6).
 *
 * Assertions:
 * - plan: an unknown role NAME → ConfigError(exit 2) BEFORE any invitation row;
 * - invite create: a new member → an invitation row + an `inviteUrl` in the report;
 * - invite re-run → `INVITE_PENDING` → `invited:false`, NO duplicate (count==1);
 * - invite for an already-existing user → `USER_EXISTS` → `invited:false`, no row;
 * - create mode idempotent by (orgId,email) (re-run → created:false, count==1);
 * - admin `actorScopes:['*']` lets an invite to an elevated-scope role succeed
 *   (no SCOPE_ESCALATION).
 *
 * The admin provisioner runs first per test to populate `ctx.actor` (userId +
 * scopes=['*']). A ConsoleEmailProvider is installed so the invite send never
 * touches a network transport.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { adminProvisioner } from "~/cli/provisioners/admin"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { usersProvisioner } from "~/cli/provisioners/users"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { invitations, roleScopeGrants, roles, users } from "~/db/schema/kernel"
import { ConsoleEmailProvider, setEmailProvider } from "~/infra/email"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(() => {
  setEmailProvider(new ConsoleEmailProvider())
  return acquireTestLock()
})
afterAll(releaseTestLock)

async function freshOrg(): Promise<string> {
  const { orgId } = await ensureOrg({
    slug: `cli-users-${crypto.randomUUID().slice(0, 12)}`,
    name: "UsersProvOrg",
  })
  return orgId
}

/** Ensure an admin and return a context with ctx.actor populated. */
async function ctxWithAdmin(orgId: string): Promise<ProvisionContext> {
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
  ctx.orgId = orgId
  const adminConfig: ProvisioningConfig = {
    org: { slug: "x", name: "X" },
    admin: {
      email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
      name: "Owner",
      password: "admin-pw-1!",
    },
  }
  const plan = await adminProvisioner.plan(ctx, adminConfig)
  await adminProvisioner.apply(ctx, plan, adminConfig)
  return ctx
}

async function invitationCount(orgId: string, email: string): Promise<number> {
  const rows = await withSystemDb("t", (db) =>
    db
      .select({ id: invitations.id })
      .from(invitations)
      .where(and(eq(invitations.orgId, orgId), eq(invitations.email, email.toLowerCase()))),
  )
  return rows.length
}

describe("users provisioner — plan (Task 6)", () => {
  test("unknown role name → ConfigError(exit 2) BEFORE any invitation row", async () => {
    const orgId = await freshOrg()
    const ctx = await ctxWithAdmin(orgId)
    const email = `nobody-${crypto.randomUUID().slice(0, 8)}@example.com`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      users: [{ email, name: "Nobody", role: "does-not-exist", mode: "invite" }],
    }

    let thrown: unknown
    try {
      await usersProvisioner.plan(ctx, config)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ConfigError)
    expect((thrown as ConfigError).exitCode).toBe(2)
    expect((thrown as ConfigError).message).toContain("does-not-exist")
    // No invitation row was created (plan is read-only).
    expect(await invitationCount(orgId, email)).toBe(0)
  })
})

describe("users provisioner — invite mode (Task 6)", () => {
  test("invite create → invitation row + inviteUrl reported; re-run → INVITE_PENDING, no dup", async () => {
    const orgId = await freshOrg()
    const ctx = await ctxWithAdmin(orgId)
    const email = `member-${crypto.randomUUID().slice(0, 8)}@example.com`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      users: [{ email, name: "Member", role: "member", mode: "invite" }],
    }

    const plan = await usersProvisioner.plan(ctx, config)
    const result = await usersProvisioner.apply(ctx, plan, config)
    const section = result.section as {
      users: Array<{ email: string; invited: boolean; inviteUrl?: string }>
    }
    expect(section.users[0].invited).toBe(true)
    // `?token=`, not `?invite=`: commit 79bd6791 ("emailed invite URL used
    // ?invite= but Register reads ?token=") changed the emitted URL and this
    // assertion was not updated with it, so it has been red ever since. The
    // product behaviour is the deliberate one; the assertion was stale.
    expect(section.users[0].inviteUrl).toContain("/register?token=")
    expect(await invitationCount(orgId, email)).toBe(1)
    expect(result.changed).toContain(`users.${email}`)

    // Re-run → INVITE_PENDING → invited:false, no duplicate row.
    const plan2 = await usersProvisioner.plan(ctx, config)
    const result2 = await usersProvisioner.apply(ctx, plan2, config)
    // The plan already knows: the waiting invite makes the re-run a no-op.
    expect(plan2.changes).toBe(0)
    expect(plan2.actions).toEqual([`user '${email}' invite already pending, unchanged`])
    const section2 = result2.section as { users: Array<{ invited: boolean }> }
    expect(section2.users[0].invited).toBe(false)
    expect(await invitationCount(orgId, email)).toBe(1)
    expect(result2.unchanged).toContain(`users.${email}`)
  })

  test("invite for an already-existing user → USER_EXISTS → invited:false, no row", async () => {
    const orgId = await freshOrg()
    const ctx = await ctxWithAdmin(orgId)
    // Insert an existing member user directly.
    const email = `existing-${crypto.randomUUID().slice(0, 8)}@example.com`
    await sql`
      INSERT INTO kernel.users (org_id, email, name, status)
      VALUES (${orgId}, ${email.toLowerCase()}, 'Existing', 'active')
    `
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      users: [{ email, name: "Existing", role: "member", mode: "invite" }],
    }
    const plan = await usersProvisioner.plan(ctx, config)
    const result = await usersProvisioner.apply(ctx, plan, config)
    const section = result.section as { users: Array<{ invited: boolean }> }
    expect(section.users[0].invited).toBe(false)
    expect(await invitationCount(orgId, email)).toBe(0)
  })

  test("admin actorScopes:['*'] lets an invite to an elevated-scope role succeed", async () => {
    const orgId = await freshOrg()
    const ctx = await ctxWithAdmin(orgId)
    expect(ctx.actor.scopes).toEqual(["*"])

    // Create a role granting an elevated scope the admin would not hold without '*'.
    const [elevated] = await withSystemDb("t", (db) =>
      db.insert(roles).values({ orgId, name: "auditor-users-test" }).returning({ id: roles.id }),
    )
    await withSystemDb("t", (db) =>
      db.insert(roleScopeGrants).values({ roleId: elevated.id, scope: "kernel:audit:read" }),
    )

    const email = `elevated-${crypto.randomUUID().slice(0, 8)}@example.com`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      users: [{ email, name: "Auditor", role: "auditor-users-test", mode: "invite" }],
    }
    const plan = await usersProvisioner.plan(ctx, config)
    const result = await usersProvisioner.apply(ctx, plan, config)
    const section = result.section as { users: Array<{ invited: boolean }> }
    // Wildcard scope → no SCOPE_ESCALATION → invited succeeds.
    expect(section.users[0].invited).toBe(true)
    expect(await invitationCount(orgId, email)).toBe(1)
  })
})

describe("users provisioner — create mode (Task 6)", () => {
  test("create mode idempotent by (orgId,email): re-run → created:false, count==1", async () => {
    const orgId = await freshOrg()
    const ctx = await ctxWithAdmin(orgId)
    const email = `created-${crypto.randomUUID().slice(0, 8)}@example.com`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      users: [{ email, name: "Made", role: "member", mode: "create", password: "made-pw-1!" }],
    }
    const plan = await usersProvisioner.plan(ctx, config)
    const result = await usersProvisioner.apply(ctx, plan, config)
    const section = result.section as { users: Array<{ created: boolean }> }
    expect(section.users[0].created).toBe(true)

    const plan2 = await usersProvisioner.plan(ctx, config)
    const result2 = await usersProvisioner.apply(ctx, plan2, config)
    const section2 = result2.section as { users: Array<{ created: boolean }> }
    expect(section2.users[0].created).toBe(false)

    const rows = await withSystemDb("t", (db) =>
      db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.orgId, orgId), eq(users.email, email.toLowerCase()))),
    )
    expect(rows.length).toBe(1)
  })
})

describe("users provisioner — create mode, a role added on re-run", () => {
  test("a second apply giving an existing user a new role reports it changed; an identical re-apply reports unchanged", async () => {
    const orgId = await freshOrg()
    const ctx = await ctxWithAdmin(orgId)
    await withSystemDb("t", (db) => db.insert(roles).values({ orgId, name: "teammate-users-test" }))
    const email = `rerole-${crypto.randomUUID().slice(0, 8)}@example.com`
    const first: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      users: [{ email, name: "Theo", role: "member", mode: "create", password: "made-pw-1!" }],
    }
    await usersProvisioner.apply(ctx, await usersProvisioner.plan(ctx, first), first)

    const second: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      users: [
        { email, name: "Theo", role: "teammate-users-test", mode: "create", password: "x-pw-1!" },
      ],
    }
    const plan2 = await usersProvisioner.plan(ctx, second)
    expect(plan2.actions).toEqual([`user '${email}' exists: grant role teammate-users-test`])
    expect(plan2.changes).toBe(1)
    const result2 = await usersProvisioner.apply(ctx, plan2, second)
    expect(result2.changed).toEqual([`users.${email}`])
    expect(result2.unchanged).toBeUndefined()
    const section2 = result2.section as { users: Array<{ created: boolean; roleGranted: boolean }> }
    expect(section2.users[0]).toMatchObject({ created: false, roleGranted: true })

    const plan3 = await usersProvisioner.plan(ctx, second)
    expect(plan3.actions).toEqual([`user '${email}' role teammate-users-test unchanged`])
    expect(plan3.changes).toBe(0)
    const result3 = await usersProvisioner.apply(ctx, plan3, second)
    expect(result3.changed).toBeUndefined()
    expect(result3.unchanged).toEqual([`users.${email}`])
    const section3 = result3.section as { users: Array<{ roleGranted: boolean }> }
    expect(section3.users[0].roleGranted).toBe(false)
  })

  test("plan for a user that does not exist yet says create", async () => {
    const orgId = await freshOrg()
    const ctx = await ctxWithAdmin(orgId)
    const email = `new-${crypto.randomUUID().slice(0, 8)}@example.com`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      users: [{ email, name: "New", role: "member", mode: "create", password: "made-pw-1!" }],
    }
    const plan = await usersProvisioner.plan(ctx, config)
    expect(plan.actions).toEqual([`create user '${email}' (role member)`])
    expect(plan.changes).toBe(1)
  })
})
