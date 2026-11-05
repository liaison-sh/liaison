// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB unit test for the admin provisioner + its `ensureUser` primitive
 * (Task 5). The critical assertion is PASSWORD IMMUTABILITY: a re-run with a
 * DIFFERENT password must NOT overwrite the stored hash (the original still
 * verifies, the new one does not). Also: email case-insensitivity, role-grant
 * idempotency, and that the admin provisioner populates `ctx.actor`.
 *
 * Each test seeds its own org via `ensureOrg` (unique slug) so the admin
 * insert has roles + an org to attach to without truncating the shared DB.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { adminProvisioner } from "~/cli/provisioners/admin"
import { buildProvisionContext } from "~/cli/provisioners/types"
import { withSystemDb } from "~/db/privileged"
import { roles, userRoles, users } from "~/db/schema/kernel"
import { verifyPassword } from "~/lib/crypto"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

async function freshOrg(): Promise<string> {
  const { orgId } = await ensureOrg({
    slug: `cli-admin-${crypto.randomUUID().slice(0, 12)}`,
    name: "AdminTestOrg",
  })
  return orgId
}

describe("ensureUser primitive (Task 5)", () => {
  test("create: user row with admin role and a verifiable argon2id hash", async () => {
    const orgId = await freshOrg()
    const email = `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const { userId, created } = await ensureUser({
      orgId,
      email,
      name: "Owner",
      password: "S3cret-Original!",
      role: "admin",
    })
    expect(created).toBe(true)

    const [row] = await withSystemDb("t", (db) =>
      db
        .select({ hash: users.passwordHash, email: users.email })
        .from(users)
        .where(eq(users.id, userId)),
    )
    expect(row.hash).toBeTruthy()
    expect(await verifyPassword("S3cret-Original!", row.hash ?? "")).toBe(true)

    // admin role grant present.
    const [adminRole] = await withSystemDb("t", (db) =>
      db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), eq(roles.name, "admin"))),
    )
    const grants = await withSystemDb("t", (db) =>
      db.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId)),
    )
    expect(grants.some((g) => g.roleId === adminRole.id)).toBe(true)
  })

  test("PASSWORD IMMUTABILITY: re-run with a different password never overwrites the hash", async () => {
    const orgId = await freshOrg()
    const email = `imm-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const first = await ensureUser({
      orgId,
      email,
      name: "Owner",
      password: "ORIGINAL-pw-1!",
      role: "admin",
    })
    expect(first.created).toBe(true)

    const second = await ensureUser({
      orgId,
      email,
      name: "Owner",
      password: "DIFFERENT-pw-2!",
      role: "admin",
    })
    expect(second.created).toBe(false)
    expect(second.userId).toBe(first.userId)

    const [row] = await withSystemDb("t", (db) =>
      db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, first.userId)),
    )
    // ORIGINAL still verifies; the NEW one must NOT.
    expect(await verifyPassword("ORIGINAL-pw-1!", row.hash ?? "")).toBe(true)
    expect(await verifyPassword("DIFFERENT-pw-2!", row.hash ?? "")).toBe(false)
  })

  test("email case-insensitivity: Mixed@ and lower@ resolve to the same row", async () => {
    const orgId = await freshOrg()
    const local = `case-${crypto.randomUUID().slice(0, 8)}`
    const upper = `${local}@FABRIKAM.example`
    const lower = `${local}@fabrikam.example`
    const first = await ensureUser({
      orgId,
      email: upper,
      name: "Owner",
      password: "pw-x-1!",
      role: "admin",
    })
    const second = await ensureUser({
      orgId,
      email: lower,
      name: "Owner",
      password: "pw-y-2!",
      role: "admin",
    })
    expect(second.created).toBe(false)
    expect(second.userId).toBe(first.userId)

    // Exactly one user row for this local-part regardless of case.
    const rows = await withSystemDb("t", (db) =>
      db.select({ id: users.id, email: users.email }).from(users).where(eq(users.orgId, orgId)),
    )
    const matching = rows.filter((r) => r.email.toLowerCase() === lower)
    expect(matching.length).toBe(1)
  })

  test("role ensure: a pre-existing user missing the role grant gets it added without duplication", async () => {
    const orgId = await freshOrg()
    const email = `role-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    // First create with member role.
    const first = await ensureUser({
      orgId,
      email,
      name: "Member",
      password: "pw-1!",
      role: "member",
    })
    // Re-run as admin role → grant added, no password change, no dup of member.
    const second = await ensureUser({
      orgId,
      email,
      name: "Member",
      password: "pw-2!",
      role: "admin",
    })
    expect(second.userId).toBe(first.userId)
    expect(second.created).toBe(false)

    const grants = await withSystemDb("t", (db) =>
      db
        .select({ roleId: userRoles.roleId })
        .from(userRoles)
        .where(eq(userRoles.userId, first.userId)),
    )
    // Both member and admin grants present, no duplicate rows.
    expect(grants.length).toBe(2)
    expect(new Set(grants.map((g) => g.roleId)).size).toBe(2)

    // Re-running the same admin grant must not duplicate.
    await ensureUser({ orgId, email, name: "Member", password: "pw-3!", role: "admin" })
    const grants2 = await withSystemDb("t", (db) =>
      db
        .select({ roleId: userRoles.roleId })
        .from(userRoles)
        .where(eq(userRoles.userId, first.userId)),
    )
    expect(grants2.length).toBe(2)
  })
})

describe("admin provisioner (Task 5)", () => {
  test("apply ensures the admin, sets ctx.actor.userId + scopes=['*'], reports created", async () => {
    const orgId = await freshOrg()
    const email = `prov-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
    const config: ProvisioningConfig = {
      org: { slug: "ignored-here", name: "X" },
      admin: { email, name: "Owner", password: "prov-pw-1!" },
    }
    const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
    ctx.orgId = orgId // org provisioner would have set this.

    const plan = await adminProvisioner.plan(ctx, config)
    const result = await adminProvisioner.apply(ctx, plan, config)

    expect(ctx.actor.userId).not.toBe("")
    expect(ctx.actor.scopes).toEqual(["*"])
    const section = result.section as { id: string; email: string; created: boolean }
    expect(section.email).toBe(email)
    expect(section.created).toBe(true)
    expect(section.id).toBe(ctx.actor.userId)
    expect(result.changed).toContain("admin.created")
  })

  test("no admin in config → apply is a no-op (no section, ctx.actor untouched)", async () => {
    const orgId = await freshOrg()
    const config: ProvisioningConfig = { org: { slug: "x", name: "X" } }
    const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
    ctx.orgId = orgId
    const plan = await adminProvisioner.plan(ctx, config)
    const result = await adminProvisioner.apply(ctx, plan, config)
    expect(result.section).toBeUndefined()
    expect(ctx.actor.userId).toBe("")
  })
})
