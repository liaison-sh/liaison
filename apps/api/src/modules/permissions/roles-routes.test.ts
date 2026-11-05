// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { createScope } from "~/modules/permissions/types"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("roles route scope guard", () => {
  let adminToken: string

  beforeAll(async () => {
    await acquireTestLock()

    // Bootstrap admin (gets kernel:admin scope)
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "roles-admin@test.com",
        password: "testpass123",
        name: "Admin",
      }),
    })
    const body = (await res.json()) as any
    adminToken = body.data.accessToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("allows admin to create a role", async () => {
    const res = await app.request("/api/admin/roles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ name: "test-role", description: "A test role" }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as any
    expect(body.data.id).toBeDefined()
    expect(body.data.name).toBe("test-role")
  })

  it("rejects unauthenticated request with 401", async () => {
    const res = await app.request("/api/admin/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-role-2" }),
    })
    expect(res.status).toBe(401)
  })

  it("rejects authenticated user without kernel:admin scope with 403", async () => {
    // Create a non-admin role
    const roleRes = await app.request("/api/admin/roles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ name: "member-role", description: "Non-admin role" }),
    })
    const roleBody = (await roleRes.json()) as any
    const roleId = roleBody.data.id

    // Invite a regular user with the non-admin role
    const inviteRes = await app.request("/api/admin/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ email: "regular@test.com", roleId }),
    })
    const inviteBody = (await inviteRes.json()) as any
    const inviteToken = inviteBody.data.inviteToken

    // Register via invite
    const regRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteToken,
        password: "testpass123",
        name: "Regular User",
      }),
    })
    const regBody = (await regRes.json()) as any
    const userToken = regBody.data.accessToken

    // Try to create a role — should be 403
    const res = await app.request("/api/admin/roles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ name: "test-role-forbidden" }),
    })
    expect(res.status).toBe(403)
  })
})

describe("Fix #12: deleteRole blocks when users are assigned", () => {
  it("throws when deleting a role with active user assignments", async () => {
    const { sql } = await import("~/db/connection")
    const { withRlsContext } = await import("~/db/rls")
    const { deleteRole } = await import("~/modules/permissions/roles")

    const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001"
    const TEST_USER_ID = "00000000-0000-0000-0000-d12000000001"

    // Ensure org and user exist for the FK constraint
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${TEST_ORG_ID}, 'Test Org', 'test-delrole') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${TEST_USER_ID}, ${TEST_ORG_ID}, 'delrole-test@test.com', 'DelRole User') ON CONFLICT (id) DO NOTHING`

    // Create a role and assign a user to it
    const [role] = await sql`
      INSERT INTO kernel.roles (org_id, name) VALUES (${TEST_ORG_ID}, 'delete-guard-test')
      ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${TEST_USER_ID}, ${role.id}, ${TEST_ORG_ID}) ON CONFLICT DO NOTHING`

    // Attempt to delete should throw
    try {
      await withRlsContext(
        {
          actorType: "user",
          userId: TEST_USER_ID,
          orgId: TEST_ORG_ID,
          scopes: ["kernel:users:admin"],
          dimensionGrants: {},
        },
        (tx) =>
          deleteRole(tx, {
            roleId: role.id,
            orgId: TEST_ORG_ID,
            actorId: TEST_USER_ID,
            actorScopes: [createScope("*")],
            actorDimensionGrants: { "*": ["*"] },
          }),
      )
      expect(true).toBe(false) // Should not reach here
    } catch (err: any) {
      expect(err.message).toContain("active user assignments")
    }

    // Clean up
    await sql`DELETE FROM kernel.user_roles WHERE role_id = ${role.id}`
    await sql`DELETE FROM kernel.roles WHERE id = ${role.id}`
    await sql`DELETE FROM kernel.users WHERE id = ${TEST_USER_ID}`
  })
})

describe("Security: dimension wildcard blocked", () => {
  it("grantDimension rejects wildcard dimension key", async () => {
    const { grantDimension } = await import("~/modules/permissions/roles")
    const { withRlsContext } = await import("~/db/rls")
    const { createScope } = await import("~/modules/permissions/types")
    const { sql } = await import("~/db/connection")

    const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001"
    const TEST_USER_ID = "00000000-0000-0000-0000-000000000002"

    // Create a role to grant dimensions on
    const [role] = await sql`
      INSERT INTO kernel.roles (org_id, name) VALUES (${TEST_ORG_ID}, 'wildcard-dim-test')
      ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `

    try {
      await withRlsContext(
        {
          actorType: "user",
          userId: TEST_USER_ID,
          orgId: TEST_ORG_ID,
          scopes: ["kernel:users:admin"],
          dimensionGrants: {},
        },
        (tx) =>
          grantDimension(tx, {
            roleId: role.id,
            orgId: TEST_ORG_ID,
            dimension: "*",
            values: ["*"],
            actorId: TEST_USER_ID,
            actorScopes: [createScope("kernel:users:admin")],
            actorDimensionGrants: {},
          }),
      )
      expect(true).toBe(false) // Should not reach
    } catch (err: any) {
      expect(err.message).toContain("Wildcard dimension")
    }

    // Clean up
    await sql`DELETE FROM kernel.roles WHERE id = ${role.id}`
  })
})

describe("GET /api/admin/roles/users/:userId/dimensions", () => {
  const ORG = "00000000-0000-4000-8000-00000000d110"
  const ADMIN = "00000000-0000-4000-8000-00000000d111"
  const TARGET = "00000000-0000-4000-8000-00000000d112"
  const ROLE = "00000000-0000-4000-8000-00000000d113"
  let adminToken: string
  let nonAdminToken: string

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Dimension Read Org', 'dimension-read-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ADMIN}, ${ORG}, 'dimension-admin@test.com', 'Dimension Admin')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${TARGET}, ${ORG}, 'dimension-target@test.com', 'Dimension Target')`
    await sql`INSERT INTO kernel.roles (id, org_id, name) VALUES (${ROLE}, ${ORG}, 'shared inbox')`
    await sql`INSERT INTO kernel.user_dimension_grants (user_id, org_id, dimension_key, dimension_values) VALUES (${TARGET}, ${ORG}, 'mail:inbox', ${JSON.stringify(["account-1"])})`
    await sql`INSERT INTO kernel.role_dimension_grants (role_id, dimension_key, dimension_values) VALUES (${ROLE}, 'mail:inbox', ${JSON.stringify(["account-2"])})`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${TARGET}, ${ROLE}, ${ORG})`
    adminToken = await signAccessToken(
      {
        userId: ADMIN,
        orgId: ORG,
        name: "Dimension Admin",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:users:admin"],
      },
      env.JWT_SECRET,
    )
    nonAdminToken = await signAccessToken(
      {
        userId: TARGET,
        orgId: ORG,
        name: "Dimension Target",
        authVersion: 1,
        permissionVersion: 1,
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("returns 403 without kernel:users:admin", async () => {
    const res = await app.request(`/api/admin/roles/users/${TARGET}/dimensions`, {
      headers: { Authorization: `Bearer ${nonAdminToken}` },
    })

    expect(res.status).toBe(403)
  })

  it("returns direct and role-derived dimension grants for admins", async () => {
    const res = await app.request(`/api/admin/roles/users/${TARGET}/dimensions`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.direct).toEqual({ "mail:inbox": ["account-1"] })
    expect(body.data.derived).toEqual({ "mail:inbox": [{ roleId: ROLE, values: ["account-2"] }] })
  })
})
