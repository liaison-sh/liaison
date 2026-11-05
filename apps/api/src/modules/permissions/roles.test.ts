// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { createPersonalAgent } from "~/modules/agent/directory/personal-agent"
import { dimensionDefRegistry } from "~/modules/apps/app-registries"
import { hasScope } from "~/modules/permissions/permissions"
import {
  assignRole,
  deleteRole,
  grantDimension,
  grantScope,
  grantUserDimension,
  grantUserScope,
  revokeDimension,
  revokeScope,
  revokeUserDimension,
  revokeUserScope,
  unassignRole,
  updateRole,
} from "~/modules/permissions/roles"
import { createScope } from "~/modules/permissions/types"

// Mock RlsClient with queueEvent
const publishedEvents: any[] = []
const rlsDb = db as unknown as RlsClient
;(rlsDb as any).queueEvent = async (event: any) => {
  publishedEvents.push(event)
}
const originalTransaction = (rlsDb as any).transaction.bind(rlsDb)
;(rlsDb as any).transaction = async (fn: any) => {
  return originalTransaction(async (tx: any) => {
    tx.queueEvent = async (event: any) => {
      publishedEvents.push(event)
    }
    return fn(tx)
  })
}

/** Shorthand for creating Scope[] from string literals in tests. */
const scopes = (...s: string[]) => s.map(createScope)

const ORG = "00000000-0000-0000-0000-000000000060"
const ADMIN_USER = "00000000-0000-0000-0000-000000000061"
const TARGET_USER = "00000000-0000-0000-0000-000000000062"
let roleId: string

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'RoleTestOrg', 'roletestorg') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ADMIN_USER}, ${ORG}, 'admin-role@t.com', 'Admin') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${TARGET_USER}, ${ORG}, 'target-role@t.com', 'Target') ON CONFLICT DO NOTHING`
  // Create a role with two scopes
  const [r] =
    await sql`INSERT INTO kernel.roles (org_id, name) VALUES (${ORG}, 'Escalation Test Role') RETURNING id`
  roleId = r.id
  await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${roleId}, 'kernel:threads:write')`
  await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${roleId}, 'customer:crm:write')`
  dimensionDefRegistry.set([ORG, "kernel", "region"], {
    type: "enum",
    values: ["eu", "us"],
  })
})

beforeEach(() => {
  publishedEvents.length = 0
})

afterAll(async () => {
  await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${roleId}`
  await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  dimensionDefRegistry.delete([ORG, "kernel", "region"])
})

describe("scope grant authorization logic", () => {
  it("actor holding parent scope can grant child", () => {
    expect(hasScope("kernel:users:read", ["kernel:users"])).toBe(true)
    expect(hasScope("kernel:users:read", ["kernel"])).toBe(true)
  })

  it("actor without scope cannot grant it", () => {
    expect(hasScope("kernel:users:admin", ["kernel:users:read"])).toBe(false)
    expect(hasScope("kernel:admin", ["kernel:users"])).toBe(false)
  })

  it("wildcard scope allows any grant", () => {
    expect(hasScope("anything:here", ["*"])).toBe(true)
  })

  it("scope format validation rejects malformed strings", () => {
    expect(hasScope("", ["kernel"])).toBe(false)
    expect(hasScope("kernel:users", [])).toBe(false)
  })
})

describe("assignRole scope escalation", () => {
  it("blocks assignment when actor lacks a scope the role grants", async () => {
    // Actor holds kernel:threads:write but NOT customer:crm:write
    const result = await assignRole(rlsDb, {
      userId: TARGET_USER,
      roleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("kernel:threads:write", "kernel:users:admin"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).toEqual({ error: "SCOPE_ESCALATION" })
    // Verify no assignment was created
    const [row] =
      await sql`SELECT 1 FROM kernel.user_roles WHERE user_id = ${TARGET_USER} AND role_id = ${roleId}`
    expect(row).toBeUndefined()
  })

  it("allows assignment when actor holds all scopes the role grants", async () => {
    const result = await assignRole(rlsDb, {
      userId: TARGET_USER,
      roleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("kernel:threads:write", "customer:crm:write", "kernel:users:admin"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).toEqual({ assigned: true })
    expect(publishedEvents).toHaveLength(1)
    expect(publishedEvents[0].entity).toBe("role_assignment")
    // Cleanup
    await unassignRole(rlsDb, {
      userId: TARGET_USER,
      roleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
  })

  it("allows assignment when actor holds parent scopes", async () => {
    // "kernel" covers "kernel:threads:write", "customer" covers "customer:crm:write"
    const result = await assignRole(rlsDb, {
      userId: TARGET_USER,
      roleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("kernel", "customer"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).toEqual({ assigned: true })
    await unassignRole(rlsDb, {
      userId: TARGET_USER,
      roleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
  })

  it("wildcard actor bypasses escalation check entirely", async () => {
    const result = await assignRole(rlsDb, {
      userId: TARGET_USER,
      roleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).toEqual({ assigned: true })
    await unassignRole(rlsDb, {
      userId: TARGET_USER,
      roleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
  })

  it("returns null for non-existent role", async () => {
    const result = await assignRole(rlsDb, {
      userId: TARGET_USER,
      roleId: "00000000-0000-0000-0000-000000000099",
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).toBeNull()
  })
})

describe("assignRole dimension escalation", () => {
  let dimRoleId: string

  beforeAll(async () => {
    const [r] =
      await sql`INSERT INTO kernel.roles (org_id, name) VALUES (${ORG}, 'Dimension Escalation Role') RETURNING id`
    dimRoleId = r.id
    // Role grants region:["us","eu"] — a superset of a us-only actor's grants.
    await sql`INSERT INTO kernel.role_dimension_grants (role_id, dimension_key, dimension_values)
      VALUES (${dimRoleId}, 'kernel:region', ${JSON.stringify(["us", "eu"])}::jsonb)`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.user_roles WHERE role_id = ${dimRoleId}`
    await sql`DELETE FROM kernel.role_dimension_grants WHERE role_id = ${dimRoleId}`
    await sql`DELETE FROM kernel.roles WHERE id = ${dimRoleId}`
  })

  it("blocks assignment when the role grants dimension values the actor lacks", async () => {
    // Actor holds region:["us"] only; role grants region:["us","eu"].
    const result = await assignRole(rlsDb, {
      userId: TARGET_USER,
      roleId: dimRoleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "kernel:region": ["us"] },
    })
    expect(result).toEqual({ error: "DIMENSION_ESCALATION" })
    const [row] =
      await sql`SELECT 1 FROM kernel.user_roles WHERE user_id = ${TARGET_USER} AND role_id = ${dimRoleId}`
    expect(row).toBeUndefined()
  })

  it("allows assignment when the actor's dimension grants cover the role's", async () => {
    const result = await assignRole(rlsDb, {
      userId: TARGET_USER,
      roleId: dimRoleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "kernel:region": ["us", "eu"] },
    })
    expect(result).toEqual({ assigned: true })
    await unassignRole(rlsDb, {
      userId: TARGET_USER,
      roleId: dimRoleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "kernel:region": ["*"] },
    })
  })

  it("allows assignment when the actor holds the dimension wildcard", async () => {
    const result = await assignRole(rlsDb, {
      userId: TARGET_USER,
      roleId: dimRoleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "kernel:region": ["*"] },
    })
    expect(result).toEqual({ assigned: true })
    await unassignRole(rlsDb, {
      userId: TARGET_USER,
      roleId: dimRoleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "kernel:region": ["*"] },
    })
  })

  it("blocks assignment when the actor holds no grant for the dimension (no grant = no access)", async () => {
    // actorDimensionGrants lacks kernel:region entirely. At runtime that means
    // the actor cannot see any row of that dimension, so it cannot hand the
    // dimension out either.
    const result = await assignRole(rlsDb, {
      userId: TARGET_USER,
      roleId: dimRoleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: {},
    })
    expect(result).toEqual({ error: "DIMENSION_ESCALATION" })
    const [row] =
      await sql`SELECT 1 FROM kernel.user_roles WHERE user_id = ${TARGET_USER} AND role_id = ${dimRoleId}`
    expect(row).toBeUndefined()
  })

  it("allows assignment when the actor carries the global wildcard grant", async () => {
    const result = await assignRole(rlsDb, {
      userId: TARGET_USER,
      roleId: dimRoleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).toEqual({ assigned: true })
    await unassignRole(rlsDb, {
      userId: TARGET_USER,
      roleId: dimRoleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
  })
})

describe("permissionVersion bumping", () => {
  let testRoleId: string

  beforeAll(async () => {
    const [r] =
      await sql`INSERT INTO kernel.roles (org_id, name) VALUES (${ORG}, 'PermVersion Test Role') RETURNING id`
    testRoleId = r.id
    // Assign TARGET_USER to the role so bumpRoleUsers affects them
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${TARGET_USER}, ${testRoleId}, ${ORG}) ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.user_roles WHERE role_id = ${testRoleId}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${testRoleId}`
    await sql`DELETE FROM kernel.roles WHERE id = ${testRoleId}`
  })

  it("grantScope increments permissionVersion for role members", async () => {
    const [before] =
      await sql`SELECT permission_version FROM kernel.users WHERE id = ${TARGET_USER}`
    await grantScope(rlsDb, {
      roleId: testRoleId,
      orgId: ORG,
      scope: "test:items:read",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    const [after] = await sql`SELECT permission_version FROM kernel.users WHERE id = ${TARGET_USER}`
    expect(after.permission_version).toBe(before.permission_version + 1)
    // Cleanup scope grant
    await revokeScope(rlsDb, {
      roleId: testRoleId,
      orgId: ORG,
      scope: "test:items:read",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
  })

  it("assignRole increments permissionVersion for the assigned user", async () => {
    // First unassign to test fresh assign
    await unassignRole(rlsDb, {
      userId: TARGET_USER,
      roleId: testRoleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    const [before] =
      await sql`SELECT permission_version FROM kernel.users WHERE id = ${TARGET_USER}`
    await assignRole(rlsDb, {
      userId: TARGET_USER,
      roleId: testRoleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    const [after] = await sql`SELECT permission_version FROM kernel.users WHERE id = ${TARGET_USER}`
    expect(after.permission_version).toBe(before.permission_version + 1)
  })

  it("bumps a DIFFERENT user's permissionVersion under liaison_rls (real RLS path)", async () => {
    // The other tests in this block run grantScope on __privileged_db__
    // (BYPASSRLS), so RLS policies never apply and a cross-user UPDATE is
    // never actually exercised. This test runs the mutation inside
    // withRlsContext as ADMIN_USER (an admin actor whose userId differs from
    // the target) so the bump for TARGET_USER must pass the
    // users_update_admin_rls policy (own-row users_update_rls matches 0 rows
    // because current_user_id = ADMIN_USER ≠ TARGET_USER). It pins the fix:
    // if the admin UPDATE policy regresses, the bump silently affects 0 rows
    // and this assertion fails.
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${TARGET_USER}, ${testRoleId}, ${ORG}) ON CONFLICT DO NOTHING`
    const [before] =
      await sql`SELECT permission_version FROM kernel.users WHERE id = ${TARGET_USER}`

    await withRlsContext(
      {
        actorType: "user",
        userId: ADMIN_USER,
        orgId: ORG,
        // kernel:users:admin → satisfies users_update_admin_rls (session_is_admin)
        // for the cross-user permission_version bump; test → lets the actor grant
        // the app-namespaced test scope (grantScope's hasScope authorization).
        scopes: ["kernel:users:admin", "test"],
        dimensionGrants: {},
      },
      (tx) =>
        grantScope(tx, {
          roleId: testRoleId,
          orgId: ORG,
          scope: "test:items:rls",
          actorId: ADMIN_USER,
          actorScopes: scopes("kernel:users:admin", "test"),
          actorDimensionGrants: { "*": ["*"] },
        }),
    )

    const [after] = await sql`SELECT permission_version FROM kernel.users WHERE id = ${TARGET_USER}`
    expect(after.permission_version).toBe(before.permission_version + 1)

    // Cleanup the scope grant created above.
    await revokeScope(rlsDb, {
      roleId: testRoleId,
      orgId: ORG,
      scope: "test:items:rls",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
  })
})

describe("symmetric authorization — revoke/unassign", () => {
  it("revokeScope rejects when actor does not hold the scope", async () => {
    await expect(
      revokeScope(rlsDb, {
        roleId,
        orgId: ORG,
        scope: "customer:crm:write",
        actorId: ADMIN_USER,
        actorScopes: scopes("kernel:users:admin"),
        actorDimensionGrants: { "*": ["*"] },
      }),
    ).rejects.toThrow("Cannot revoke a scope you do not hold")
  })

  it("revokeScope succeeds when actor holds the scope", async () => {
    // Grant first so we have something to revoke
    await grantScope(rlsDb, {
      roleId,
      orgId: ORG,
      scope: "test:revoke:read",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    const result = await revokeScope(rlsDb, {
      roleId,
      orgId: ORG,
      scope: "test:revoke:read",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).not.toBeNull()
  })

  it("revokeScope succeeds when actor holds wildcard scope", async () => {
    await grantScope(rlsDb, {
      roleId,
      orgId: ORG,
      scope: "test:revoke2:read",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    const result = await revokeScope(rlsDb, {
      roleId,
      orgId: ORG,
      scope: "test:revoke2:read",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).not.toBeNull()
  })

  it("actor with parent scope can revoke child scope", async () => {
    await grantScope(rlsDb, {
      roleId,
      orgId: ORG,
      scope: "test:revoke3:read",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    const result = await revokeScope(rlsDb, {
      roleId,
      orgId: ORG,
      scope: "test:revoke3:read",
      actorId: ADMIN_USER,
      actorScopes: scopes("test"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).not.toBeNull()
  })

  it("unassignRole rejects when actor lacks role scopes", async () => {
    // Role has kernel:threads:write and customer:crm:write
    // Actor only has kernel:users:admin
    const result = await unassignRole(rlsDb, {
      userId: TARGET_USER,
      roleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("kernel:users:admin"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).toEqual({ error: "SCOPE_ESCALATION" })
  })
})

describe("dimension escalation checks", () => {
  it("grantDimension rejects when actor does not hold the dimension values", async () => {
    await expect(
      grantDimension(rlsDb, {
        roleId,
        orgId: ORG,
        dimension: "region",
        values: ["eu", "us"],
        actorId: ADMIN_USER,
        actorScopes: scopes("*"),
        actorDimensionGrants: { region: ["eu"] },
      }),
    ).rejects.toThrow("Cannot grant dimension values you do not hold")
  })

  it("grantDimension and grantUserDimension reject when the actor holds NO grant for the dimension", async () => {
    // Runtime treats a missing grant as no access, so it cannot be a licence to
    // grant any value (including "*") of that dimension.
    await expect(
      grantDimension(rlsDb, {
        roleId,
        orgId: ORG,
        dimension: "region",
        values: ["*"],
        actorId: ADMIN_USER,
        actorScopes: scopes("*"),
        actorDimensionGrants: { somethingElse: ["x"] },
      }),
    ).rejects.toThrow("Cannot grant dimension values you do not hold")
    await expect(
      grantUserDimension(rlsDb, {
        userId: TARGET_USER,
        orgId: ORG,
        dimension: "region",
        values: ["eu"],
        actorId: ADMIN_USER,
        actorScopes: scopes("*"),
        actorDimensionGrants: {},
      }),
    ).rejects.toThrow("Cannot grant dimension values you do not hold")
  })

  it("grantDimension succeeds when actor holds wildcard dimension", async () => {
    const result = await grantDimension(rlsDb, {
      roleId,
      orgId: ORG,
      dimension: "region",
      values: ["eu", "us"],
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { region: ["*"] },
    })
    expect(result).toBeDefined()
  })

  it("grantDimension succeeds when actor holds the global wildcard grant", async () => {
    const result = await grantDimension(rlsDb, {
      roleId,
      orgId: ORG,
      dimension: "region",
      values: ["eu"],
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).toBeDefined()
  })
})

describe("updateRole — rename / re-describe", () => {
  let editRoleId: string
  let systemRoleId: string

  beforeAll(async () => {
    const [r] =
      await sql`INSERT INTO kernel.roles (org_id, name, description) VALUES (${ORG}, 'Editable Role', 'before') RETURNING id`
    editRoleId = r.id
    const [s] =
      await sql`INSERT INTO kernel.roles (org_id, name, system_managed) VALUES (${ORG}, 'System Role', true) RETURNING id`
    systemRoleId = s.id
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.roles WHERE id IN (${editRoleId}, ${systemRoleId})`
  })

  it("renames a role and queues a role:update event", async () => {
    const result = await updateRole(rlsDb, {
      roleId: editRoleId,
      orgId: ORG,
      name: "Renamed Role",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).not.toBeNull()
    expect(result?.name).toBe("Renamed Role")
    const [row] = await sql`SELECT name FROM kernel.roles WHERE id = ${editRoleId}`
    expect(row.name).toBe("Renamed Role")
    expect(publishedEvents).toHaveLength(1)
    expect(publishedEvents[0].entity).toBe("role")
    expect(publishedEvents[0].action).toBe("update")
  })

  it("updates only the description when name is omitted", async () => {
    const result = await updateRole(rlsDb, {
      roleId: editRoleId,
      orgId: ORG,
      description: "after",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result?.description).toBe("after")
    const [row] = await sql`SELECT name, description FROM kernel.roles WHERE id = ${editRoleId}`
    // Name unchanged from the prior test's rename.
    expect(row.name).toBe("Renamed Role")
    expect(row.description).toBe("after")
  })

  it("returns null for a non-existent role", async () => {
    const result = await updateRole(rlsDb, {
      roleId: "00000000-0000-0000-0000-0000000000ff",
      orgId: ORG,
      name: "Nope",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).toBeNull()
  })

  it("refuses to RENAME a system-managed role (would orphan it on app sync)", async () => {
    await expect(
      updateRole(rlsDb, {
        roleId: systemRoleId,
        orgId: ORG,
        name: "Renamed System Role",
        actorId: ADMIN_USER,
        actorScopes: scopes("*"),
        actorDimensionGrants: { "*": ["*"] },
      }),
    ).rejects.toThrow("Cannot rename a system-managed role")
    const [row] = await sql`SELECT name FROM kernel.roles WHERE id = ${systemRoleId}`
    expect(row.name).toBe("System Role")
  })

  it("allows a description edit on a system-managed role (only rename is refused)", async () => {
    const result = await updateRole(rlsDb, {
      roleId: systemRoleId,
      orgId: ORG,
      description: "system role, description editable",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result?.description).toBe("system role, description editable")
  })

  it("refuses to rename or delete a role that grants more than the actor holds", async () => {
    const [wide] = await sql`
      INSERT INTO kernel.roles (org_id, name) VALUES (${ORG}, 'Wide Role') RETURNING id`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${wide.id}, '*')`
    await sql`INSERT INTO kernel.role_dimension_grants (role_id, dimension_key, dimension_values)
      VALUES (${wide.id}, 'kernel:region', '["eu"]'::jsonb)`
    try {
      const delegated = {
        orgId: ORG,
        actorId: ADMIN_USER,
        actorScopes: scopes("kernel:users:admin"),
        actorDimensionGrants: {},
      }
      await expect(
        updateRole(rlsDb, { ...delegated, roleId: wide.id, name: "member" }),
      ).rejects.toThrow("grants more than you hold")
      await expect(deleteRole(rlsDb, { ...delegated, roleId: wide.id })).rejects.toThrow(
        "grants more than you hold",
      )
      // Every scope but not the dimension value: still refused.
      await expect(
        updateRole(rlsDb, { ...delegated, actorScopes: scopes("*"), roleId: wide.id, name: "x" }),
      ).rejects.toThrow("grants more than you hold")
      const [row] = await sql`SELECT name FROM kernel.roles WHERE id = ${wide.id}`
      expect(row.name).toBe("Wide Role")
    } finally {
      await sql`DELETE FROM kernel.role_dimension_grants WHERE role_id = ${wide.id}`
      await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${wide.id}`
      await sql`DELETE FROM kernel.roles WHERE id = ${wide.id}`
    }
  })

  it("passing the SAME name for a system-managed role is not treated as a rename", async () => {
    // name === current name → `renaming` is false → allowed (idempotent no-op on name).
    const result = await updateRole(rlsDb, {
      roleId: systemRoleId,
      orgId: ORG,
      name: "System Role",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result?.name).toBe("System Role")
  })
})

describe("dimension value validation against enum type", () => {
  beforeAll(() => {
    // Register a dimension definition for the test org
    dimensionDefRegistry.set([ORG, "test-app", "region"], {
      type: "enum",
      values: ["eu", "us", "ap"],
    })
  })

  afterAll(() => {
    dimensionDefRegistry.delete([ORG, "test-app", "region"])
  })

  it("grantDimension rejects invalid values for enum dimensions", async () => {
    await expect(
      grantDimension(rlsDb, {
        roleId,
        orgId: ORG,
        dimension: "region",
        values: ["eu", "mars"],
        actorId: ADMIN_USER,
        actorScopes: scopes("*"),
        actorDimensionGrants: { "*": ["*"] },
      }),
    ).rejects.toThrow("Invalid values for enum dimension")
  })

  it("grantDimension allows wildcard for enum dimensions", async () => {
    const result = await grantDimension(rlsDb, {
      roleId,
      orgId: ORG,
      dimension: "region",
      values: ["*"],
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).toBeDefined()
  })

  it("grantDimension allows valid enum values", async () => {
    const result = await grantDimension(rlsDb, {
      roleId,
      orgId: ORG,
      dimension: "region",
      values: ["eu", "us"],
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    expect(result).toBeDefined()
  })
})

describe("dimension key canonicalization", () => {
  beforeAll(() => {
    dimensionDefRegistry.set([ORG, "mail", "inbox"], { type: "membership" })
  })

  afterAll(async () => {
    dimensionDefRegistry.delete([ORG, "mail", "inbox"])
    await sql`DELETE FROM kernel.user_dimension_grants WHERE user_id = ${TARGET_USER} AND org_id = ${ORG} AND dimension_key = 'mail:inbox'`
  })

  it("stores user dimension grants with the canonical full key", async () => {
    await grantUserDimension(rlsDb, {
      userId: TARGET_USER,
      orgId: ORG,
      dimension: "inbox",
      values: ["account-1"],
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "mail:inbox": ["*"] },
    })

    const [row] = await sql`
      SELECT dimension_key, dimension_values
      FROM kernel.user_dimension_grants
      WHERE user_id = ${TARGET_USER} AND org_id = ${ORG} AND dimension_key = 'mail:inbox'
    `
    expect(row.dimension_key).toBe("mail:inbox")
    expect(row.dimension_values).toEqual(["account-1"])
  })

  it("does not double-prefix already canonical dimension keys", async () => {
    await grantUserDimension(rlsDb, {
      userId: TARGET_USER,
      orgId: ORG,
      dimension: "mail:inbox",
      values: ["account-2"],
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "mail:inbox": ["*"] },
    })

    const [row] = await sql`
      SELECT dimension_key, dimension_values
      FROM kernel.user_dimension_grants
      WHERE user_id = ${TARGET_USER} AND org_id = ${ORG} AND dimension_key = 'mail:inbox'
    `
    expect(row.dimension_key).toBe("mail:inbox")
    expect(row.dimension_values).toEqual(["account-2"])
  })

  it("rejects unknown dimension keys", async () => {
    await expect(
      grantUserDimension(rlsDb, {
        userId: TARGET_USER,
        orgId: ORG,
        dimension: "mail:unknown",
        values: ["account-1"],
        actorId: ADMIN_USER,
        actorScopes: scopes("*"),
        actorDimensionGrants: { "mail:inbox": ["*"] },
      }),
    ).rejects.toThrow(/Unknown dimension/i)
  })
})

describe("revokeDimension symmetric authorization", () => {
  it("revokeDimension rejects when actor does not hold the granted values", async () => {
    // First grant region: ["eu", "us"] on the role
    await grantDimension(rlsDb, {
      roleId,
      orgId: ORG,
      dimension: "region",
      values: ["eu", "us"],
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { region: ["*"] },
    })

    // Actor only holds ["eu"] — cannot revoke because role has ["eu", "us"]
    await expect(
      revokeDimension(rlsDb, {
        roleId,
        orgId: ORG,
        dimension: "region",
        actorId: ADMIN_USER,
        actorScopes: scopes("*"),
        actorDimensionGrants: { region: ["eu"] },
      }),
    ).rejects.toThrow("Cannot revoke dimension values you do not hold")
  })

  it("revokeDimension succeeds when actor holds wildcard", async () => {
    const result = await revokeDimension(rlsDb, {
      roleId,
      orgId: ORG,
      dimension: "region",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { region: ["*"] },
    })
    // May return null if already revoked by previous test, or the grant
    expect(result === null || result !== undefined).toBe(true)
  })
})

describe("P1a-T19: personal agent ceiling tracks role membership", () => {
  const CEILING_ROLE_USER = "00000000-0000-0000-0000-000000000063"
  let ceilingRoleId: string

  beforeAll(async () => {
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${CEILING_ROLE_USER}, ${ORG}, 'ceiling-role@t.com', 'Ceiling Role User') ON CONFLICT DO NOTHING`
    await withPrivilegedDb(ORG, "ceiling-role-test-seed", (tx) =>
      createPersonalAgent(tx, {
        orgId: ORG,
        userId: CEILING_ROLE_USER,
        email: "ceiling-role@t.com",
      }),
    )
    const [r] = await sql`
      INSERT INTO kernel.roles (org_id, name) VALUES (${ORG}, 'Ceiling Role Membership Role') RETURNING id
    `
    ceilingRoleId = r.id
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ceilingRoleId}, 'test:ceiling:role:membership')`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG} AND role_id = ${ceilingRoleId}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ceilingRoleId}`
    await sql`DELETE FROM kernel.roles WHERE id = ${ceilingRoleId}`
    await sql`DELETE FROM kernel.agents WHERE owner_user_id = ${CEILING_ROLE_USER}`
    await sql`DELETE FROM kernel.users WHERE id = ${CEILING_ROLE_USER}`
  })

  it("unassigning a role shrinks the member's personal agent ceiling", async () => {
    await assignRole(rlsDb, {
      userId: CEILING_ROLE_USER,
      roleId: ceilingRoleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })

    const [afterAssign] = await sql`
      SELECT scope_ceiling FROM kernel.agents
      WHERE owner_user_id = ${CEILING_ROLE_USER} AND kind = 'personal'
    `
    expect(afterAssign.scope_ceiling as string[]).toContain("test:ceiling:role:membership")

    await unassignRole(rlsDb, {
      userId: CEILING_ROLE_USER,
      roleId: ceilingRoleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })

    const [afterUnassign] = await sql`
      SELECT scope_ceiling FROM kernel.agents
      WHERE owner_user_id = ${CEILING_ROLE_USER} AND kind = 'personal'
    `
    expect(afterUnassign.scope_ceiling as string[]).not.toContain("test:ceiling:role:membership")
  })

  it("revoking a role's scope shrinks EVERY current member's ceiling", async () => {
    await assignRole(rlsDb, {
      userId: CEILING_ROLE_USER,
      roleId: ceilingRoleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })

    const [afterAssign] = await sql`
      SELECT scope_ceiling FROM kernel.agents
      WHERE owner_user_id = ${CEILING_ROLE_USER} AND kind = 'personal'
    `
    expect(afterAssign.scope_ceiling as string[]).toContain("test:ceiling:role:membership")

    await revokeScope(rlsDb, {
      roleId: ceilingRoleId,
      orgId: ORG,
      scope: "test:ceiling:role:membership",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })

    const [afterRevoke] = await sql`
      SELECT scope_ceiling FROM kernel.agents
      WHERE owner_user_id = ${CEILING_ROLE_USER} AND kind = 'personal'
    `
    expect(afterRevoke.scope_ceiling as string[]).not.toContain("test:ceiling:role:membership")

    // Cleanup so the role still has its scope for any later re-run assumptions.
    await grantScope(rlsDb, {
      roleId: ceilingRoleId,
      orgId: ORG,
      scope: "test:ceiling:role:membership",
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
    await unassignRole(rlsDb, {
      userId: CEILING_ROLE_USER,
      roleId: ceilingRoleId,
      orgId: ORG,
      actorId: ADMIN_USER,
      actorScopes: scopes("*"),
      actorDimensionGrants: { "*": ["*"] },
    })
  })
})

// The signal used to be recorded per affected user; now delivery resolves
// everything from the queued kernel permission event plus the database
// (FX8, grant-invalidation.ts). So the coverage these paths owe is that each
// one queues, in the SAME transaction as its write, the event that names its
// target: `data.roleId` for a role-level change (resolved to that role's
// CURRENT members at delivery, not enumerated here), `data.targetUserId` for
// a per-user one. `publishedEvents` is cleared before every test (see the
// file-level `beforeEach` above).
describe("grant changes queue the permission event that carries the invalidation", () => {
  const MEMBER_A = "00000000-0000-0000-0000-000000000064"
  const MEMBER_B = "00000000-0000-0000-0000-000000000065"
  const BYSTANDER = "00000000-0000-0000-0000-000000000066"
  const actor = {
    orgId: ORG,
    actorId: ADMIN_USER,
    actorScopes: scopes("*"),
    actorDimensionGrants: { "*": ["*"] },
  }
  let fanRoleId: string

  beforeAll(async () => {
    for (const [id, email] of [
      [MEMBER_A, "gi-member-a@t.com"],
      [MEMBER_B, "gi-member-b@t.com"],
      [BYSTANDER, "gi-bystander@t.com"],
    ]) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${id}, ${ORG}, ${email}, ${email}) ON CONFLICT DO NOTHING`
    }
    const [r] = await sql`
      INSERT INTO kernel.roles (org_id, name) VALUES (${ORG}, 'Grant Invalidation Role') RETURNING id
    `
    fanRoleId = r.id
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${MEMBER_A}, ${fanRoleId}, ${ORG}), (${MEMBER_B}, ${fanRoleId}, ${ORG})`
  })

  afterAll(async () => {
    const ids = [MEMBER_A, MEMBER_B, BYSTANDER]
    await sql`DELETE FROM kernel.user_scope_grants WHERE user_id = ANY(${ids})`
    await sql`DELETE FROM kernel.user_dimension_grants WHERE user_id = ANY(${ids})`
    await sql`DELETE FROM kernel.user_roles WHERE role_id = ${fanRoleId} OR user_id = ANY(${ids})`
    await sql`DELETE FROM kernel.role_dimension_grants WHERE role_id = ${fanRoleId}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${fanRoleId}`
    await sql`DELETE FROM kernel.roles WHERE id = ${fanRoleId}`
    await sql`DELETE FROM kernel.users WHERE id = ANY(${ids})`
  })

  it("grantScope on a role queues a role_scope grant event naming the role", async () => {
    await grantScope(rlsDb, { ...actor, roleId: fanRoleId, scope: "test:grant:invalidation" })
    expect(publishedEvents).toHaveLength(1)
    expect(publishedEvents[0]).toMatchObject({
      entity: "role_scope",
      action: "grant",
      entityId: fanRoleId,
      data: { roleId: fanRoleId, scope: "test:grant:invalidation" },
    })
  })

  it("revokeScope on a role queues a role_scope revoke event naming the role", async () => {
    await revokeScope(rlsDb, { ...actor, roleId: fanRoleId, scope: "test:grant:invalidation" })
    expect(publishedEvents).toHaveLength(1)
    expect(publishedEvents[0]).toMatchObject({
      entity: "role_scope",
      action: "revoke",
      entityId: fanRoleId,
      data: { roleId: fanRoleId, scope: "test:grant:invalidation" },
    })
  })

  it("grantDimension on a role queues a role_dimension grant event naming the role", async () => {
    await grantDimension(rlsDb, {
      ...actor,
      roleId: fanRoleId,
      dimension: "region",
      values: ["eu"],
    })
    expect(publishedEvents).toHaveLength(1)
    expect(publishedEvents[0]).toMatchObject({
      entity: "role_dimension",
      action: "grant",
      entityId: fanRoleId,
      data: { roleId: fanRoleId, dimension: "kernel:region", values: ["eu"] },
    })
  })

  it("revokeDimension on a role queues a role_dimension revoke event naming the role", async () => {
    await revokeDimension(rlsDb, { ...actor, roleId: fanRoleId, dimension: "region" })
    expect(publishedEvents).toHaveLength(1)
    expect(publishedEvents[0]).toMatchObject({
      entity: "role_dimension",
      action: "revoke",
      entityId: fanRoleId,
      data: { roleId: fanRoleId, dimension: "kernel:region" },
    })
  })

  it("assignRole queues a role_assignment event naming the assigned user", async () => {
    await assignRole(rlsDb, { ...actor, userId: BYSTANDER, roleId: fanRoleId })
    expect(publishedEvents).toHaveLength(1)
    expect(publishedEvents[0]).toMatchObject({
      entity: "role_assignment",
      action: "assign",
      entityId: fanRoleId,
      data: { targetUserId: BYSTANDER, roleId: fanRoleId },
    })
  })

  it("unassignRole queues a role_assignment event naming the unassigned user", async () => {
    await unassignRole(rlsDb, { ...actor, userId: BYSTANDER, roleId: fanRoleId })
    expect(publishedEvents).toHaveLength(1)
    expect(publishedEvents[0]).toMatchObject({
      entity: "role_assignment",
      action: "unassign",
      entityId: fanRoleId,
      data: { targetUserId: BYSTANDER, roleId: fanRoleId },
    })
  })

  it("grantUserScope queues a user_scope grant event naming the granted user", async () => {
    await grantUserScope(rlsDb, { ...actor, userId: MEMBER_A, scope: "test:grant:user" })
    expect(publishedEvents).toHaveLength(1)
    expect(publishedEvents[0]).toMatchObject({
      entity: "user_scope",
      action: "grant",
      entityId: MEMBER_A,
      data: { targetUserId: MEMBER_A, scope: "test:grant:user" },
    })
  })

  it("revokeUserScope queues a user_scope revoke event naming the revoked user", async () => {
    await revokeUserScope(rlsDb, { ...actor, userId: MEMBER_A, scope: "test:grant:user" })
    expect(publishedEvents).toHaveLength(1)
    expect(publishedEvents[0]).toMatchObject({
      entity: "user_scope",
      action: "revoke",
      entityId: MEMBER_A,
      data: { targetUserId: MEMBER_A, scope: "test:grant:user" },
    })
  })

  it("grantUserDimension queues a user_dimension grant event naming the granted user", async () => {
    await grantUserDimension(rlsDb, {
      ...actor,
      userId: MEMBER_A,
      dimension: "region",
      values: ["us"],
    })
    expect(publishedEvents).toHaveLength(1)
    expect(publishedEvents[0]).toMatchObject({
      entity: "user_dimension",
      action: "grant",
      entityId: MEMBER_A,
      data: { targetUserId: MEMBER_A, dimension: "kernel:region", values: ["us"] },
    })
  })

  it("revokeUserDimension queues a user_dimension revoke event naming the revoked user", async () => {
    await revokeUserDimension(rlsDb, { ...actor, userId: MEMBER_A, dimension: "region" })
    expect(publishedEvents).toHaveLength(1)
    expect(publishedEvents[0]).toMatchObject({
      entity: "user_dimension",
      action: "revoke",
      entityId: MEMBER_A,
      data: { targetUserId: MEMBER_A, dimension: "kernel:region" },
    })
  })

  it("a revoke that changes nothing queues no event", async () => {
    await revokeUserScope(rlsDb, { ...actor, userId: MEMBER_B, scope: "test:grant:never:held" })
    await revokeScope(rlsDb, { ...actor, roleId: fanRoleId, scope: "test:grant:never:held" })
    expect(publishedEvents).toHaveLength(0)
  })

  it("deleteRole queues no grant-invalidation event: a role with members cannot be deleted", async () => {
    const [empty] = await sql`
      INSERT INTO kernel.roles (org_id, name) VALUES (${ORG}, 'Grant Invalidation Empty Role') RETURNING id
    `
    await deleteRole(rlsDb, { ...actor, roleId: empty.id })
    await expect(deleteRole(rlsDb, { ...actor, roleId: fanRoleId })).rejects.toThrow(
      "active user assignments",
    )
    const grantEntities = [
      "role_scope",
      "role_dimension",
      "role_assignment",
      "user_scope",
      "user_dimension",
    ]
    expect(publishedEvents.some((e) => grantEntities.includes(e.entity))).toBe(false)
  })
})
