// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import {
  computeEffectivePermissions,
  hasScope,
  loadEffectivePermissions,
} from "~/modules/permissions/permissions"

describe("hasScope", () => {
  it("exact match", () => {
    expect(hasScope("test:items:read", ["test:items:read"])).toBe(true)
  })

  it("parent grant covers children", () => {
    expect(hasScope("test:items:read", ["test:items"])).toBe(true)
    expect(hasScope("test:items:write", ["test:items"])).toBe(true)
  })

  it("grandparent grant covers descendants", () => {
    expect(hasScope("test:items:read", ["test"])).toBe(true)
  })

  it("sibling does not match", () => {
    expect(hasScope("test:items:read", ["test:items:write"])).toBe(false)
  })

  it("different app does not match", () => {
    expect(hasScope("test:items:read", ["other:items:read"])).toBe(false)
  })

  it("empty grants deny all", () => {
    expect(hasScope("test:items:read", [])).toBe(false)
  })

  it("partial segment does not match (test:item vs test:items)", () => {
    expect(hasScope("test:items:read", ["test:item"])).toBe(false)
  })

  it("wildcard-like parent covers all children", () => {
    expect(hasScope("kernel:users:read", ["kernel"])).toBe(true)
    expect(hasScope("kernel:audit:read", ["kernel"])).toBe(true)
  })

  it("grants everything with wildcard scope", () => {
    expect(hasScope("any:scope:here", ["*"])).toBe(true)
    expect(hasScope("kernel:threads:read", ["*"])).toBe(true)
  })

  it("kernel:skills:read + write do NOT satisfy kernel:skills:approve", () => {
    // Full Member holds only kernel:skills:read/write. A sibling three-part scope
    // never covers another sibling (no kernel:skills umbrella is granted), so a
    // Full Member cannot accidentally decide skill approvals.
    expect(hasScope("kernel:skills:approve", ["kernel:skills:read", "kernel:skills:write"])).toBe(
      false,
    )
    // But the kernel:skills umbrella (a two-part parent) WOULD cover it — asserting
    // the hierarchy semantics are intact.
    expect(hasScope("kernel:skills:approve", ["kernel:skills"])).toBe(true)
  })

  it("does not match across segment boundaries (prefix confusion)", () => {
    // kernel:threads must NOT grant kernel:threadSettings:write
    expect(hasScope("kernel:threadSettings:write", ["kernel:threads"])).toBe(false)
    // kernel:item must NOT grant kernel:items:read
    expect(hasScope("kernel:items:read", ["kernel:item"])).toBe(false)
  })
})

describe("computeEffectivePermissions", () => {
  it("unions scopes from multiple roles", () => {
    const result = computeEffectivePermissions({
      roleIds: [],
      roleScopeGrants: [{ scope: "test:items:read" }, { scope: "test:items:write" }],
      userScopeGrants: [{ scope: "test:extra:read" }],
      roleDimensionGrants: [],
      userDimensionGrants: [],
    })
    expect(result.scopes).toContain("test:items:read")
    expect(result.scopes).toContain("test:items:write")
    expect(result.scopes).toContain("test:extra:read")
  })

  it("deduplicates scopes", () => {
    const result = computeEffectivePermissions({
      roleIds: [],
      roleScopeGrants: [{ scope: "test:items:read" }, { scope: "test:items:read" }],
      userScopeGrants: [{ scope: "test:items:read" }],
      roleDimensionGrants: [],
      userDimensionGrants: [],
    })
    const count = result.scopes.filter((s) => s === "test:items:read").length
    expect(count).toBe(1)
  })

  it("unions dimension grants per key", () => {
    const result = computeEffectivePermissions({
      roleIds: [],
      roleScopeGrants: [],
      userScopeGrants: [],
      roleDimensionGrants: [{ dimensionKey: "team", dimensionValues: ["alpha"] }],
      userDimensionGrants: [{ dimensionKey: "team", dimensionValues: ["beta"] }],
    })
    expect(result.dimensionGrants.team).toContain("alpha")
    expect(result.dimensionGrants.team).toContain("beta")
  })

  it("deduplicates dimension values", () => {
    const result = computeEffectivePermissions({
      roleIds: [],
      roleScopeGrants: [],
      userScopeGrants: [],
      roleDimensionGrants: [{ dimensionKey: "team", dimensionValues: ["alpha"] }],
      userDimensionGrants: [{ dimensionKey: "team", dimensionValues: ["alpha"] }],
    })
    expect(result.dimensionGrants.team).toEqual(["alpha"])
  })
})

describe("loadEffectivePermissions — DB integration (T-8)", () => {
  const ORG_A = "00000000-0000-0000-0000-aaa000000001"
  const ORG_B = "00000000-0000-0000-0000-bbb000000001"
  const USER = "00000000-0000-0000-0000-aaa000000002"

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_A}, 'OrgA', 'perm-orga') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_B}, 'OrgB', 'perm-orgb') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG_A}, 'perm-user@test.com', 'PermUser') ON CONFLICT (id) DO NOTHING`

    // Grant the user a role and a scope in ORG_A
    const [role] = await sql`
      INSERT INTO kernel.roles (org_id, name) VALUES (${ORG_A}, 'perm-test-role')
      ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${USER}, ${role.id}, ${ORG_A}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${role.id}, 'kernel:items:read') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${USER}, ${ORG_A}, 'kernel:extra:read') ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.user_scope_grants WHERE user_id = ${USER}`
    await sql`DELETE FROM kernel.user_roles WHERE user_id = ${USER}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_A} AND name = 'perm-test-role'`
    await sql`DELETE FROM kernel.users WHERE id = ${USER}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_A}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_B}`
  })

  it("returns populated permissions for the correct org", async () => {
    const perms = await withPrivilegedDb(ORG_A, "test-perms", (tx) =>
      loadEffectivePermissions(tx, USER, ORG_A),
    )
    expect(perms.scopes).toContain("kernel:items:read")
    expect(perms.scopes).toContain("kernel:extra:read")
  })

  it("returns empty permissions when user has roles in orgA but query uses orgB (T-8)", async () => {
    const perms = await withPrivilegedDb(ORG_B, "test-perms-cross-org", (tx) =>
      loadEffectivePermissions(tx, USER, ORG_B),
    )
    expect(perms.scopes).toHaveLength(0)
    expect(perms.roles).toHaveLength(0)
    expect(Object.keys(perms.dimensionGrants)).toHaveLength(0)
  })

  it("hasScope returns false for empty required scope", () => {
    expect(hasScope("", ["kernel"])).toBe(false)
  })

  it("permissionVersion column exists and defaults to 1", async () => {
    const [user] = await withPrivilegedDb(ORG_A, "perm-version-check", (tx) =>
      tx
        .select({ permissionVersion: users.permissionVersion })
        .from(users)
        .where(eq(users.id, USER))
        .limit(1),
    )
    expect(user.permissionVersion).toBe(1)
  })

  it("unions scopes and dimension grants across multiple role assignments", async () => {
    const MULTI_USER = "00000000-0000-0000-0000-aaa000000099"
    const ROLE_A = "perm-multi-role-a"
    const ROLE_B = "perm-multi-role-b"

    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${MULTI_USER}, ${ORG_A}, 'perm-multi@test.com', 'PermMulti') ON CONFLICT (id) DO NOTHING`
    const [roleA] = await sql`
      INSERT INTO kernel.roles (org_id, name) VALUES (${ORG_A}, ${ROLE_A})
      ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `
    const [roleB] = await sql`
      INSERT INTO kernel.roles (org_id, name) VALUES (${ORG_A}, ${ROLE_B})
      ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${MULTI_USER}, ${roleA.id}, ${ORG_A}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${MULTI_USER}, ${roleB.id}, ${ORG_A}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${roleA.id}, 'kernel:multi:roleA') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${roleB.id}, 'kernel:multi:roleB') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_dimension_grants (role_id, dimension_key, dimension_values) VALUES (${roleA.id}, 'team', ${JSON.stringify(["alpha"])}::jsonb) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_dimension_grants (role_id, dimension_key, dimension_values) VALUES (${roleB.id}, 'team', ${JSON.stringify(["beta"])}::jsonb) ON CONFLICT DO NOTHING`

    try {
      const perms = await withPrivilegedDb(ORG_A, "multi-role-union", (tx) =>
        loadEffectivePermissions(tx, MULTI_USER, ORG_A),
      )
      expect(perms.roles).toHaveLength(2)
      expect(perms.scopes).toContain("kernel:multi:roleA")
      expect(perms.scopes).toContain("kernel:multi:roleB")
      expect(perms.dimensionGrants.team).toEqual(expect.arrayContaining(["alpha", "beta"]))
      expect(perms.dimensionGrants.team).toHaveLength(2)
    } finally {
      await sql`DELETE FROM kernel.role_dimension_grants WHERE role_id IN (${roleA.id}, ${roleB.id})`
      await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (${roleA.id}, ${roleB.id})`
      await sql`DELETE FROM kernel.user_roles WHERE user_id = ${MULTI_USER}`
      await sql`DELETE FROM kernel.users WHERE id = ${MULTI_USER}`
      await sql`DELETE FROM kernel.roles WHERE id IN (${roleA.id}, ${roleB.id})`
    }
  })
})
