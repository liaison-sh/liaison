// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { invalidateAuthCache } from "~/middleware/auth"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("Permission propagation", () => {
  let adminToken: string
  let userToken: string
  let userId: string
  let roleId: string

  beforeAll(async () => {
    await acquireTestLock()

    // Bootstrap admin
    const bootstrap = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "perm-admin@test.com",
        password: "TestPass123!",
        name: "Admin",
      }),
    })
    const bootstrapBody = (await bootstrap.json()) as any
    adminToken = bootstrapBody.data.accessToken

    // Create a role with kernel:contacts:read
    const roleRes = await app.request("/api/admin/roles", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "contacts-reader" }),
    })
    const roleBody = (await roleRes.json()) as any
    roleId = roleBody.data.id

    await app.request(`/api/admin/roles/${roleId}/scopes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "kernel:contacts:read" }),
    })

    // Invite and register a user
    const inviteRes = await app.request("/api/admin/invites", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "perm-user@test.com", roleId }),
    })
    const inviteBody = (await inviteRes.json()) as any
    const inviteToken = inviteBody.data.inviteToken

    const registerRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteToken, password: "TestPass123!", name: "User" }),
    })
    const registerBody = (await registerRes.json()) as any
    userToken = registerBody.data.accessToken

    // Get user ID
    const meRes = await app.request("/api/users/me", {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    const meBody = (await meRes.json()) as any
    userId = meBody.data.id
  })

  afterAll(releaseTestLock)

  it("revoking a scope invalidates the user token within cache TTL", async () => {
    // Verify user can access contacts
    const before = await app.request("/api/contacts", {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect(before.status).toBe(200)

    // Revoke the scope (bumps permissionVersion)
    await app.request(
      `/api/admin/roles/${roleId}/scopes/${encodeURIComponent("kernel:contacts:read")}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      },
    )

    // Clear auth cache so next request hits DB
    invalidateAuthCache()

    // Old token is now rejected (permissionVersion mismatch)
    const after = await app.request("/api/contacts", {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect(after.status).toBe(401)
  })

  it("unassigning and reassigning a role bumps permissionVersion each time", async () => {
    const [before] = await sql`SELECT permission_version FROM kernel.users WHERE id = ${userId}`

    // Unassign (bumps once)
    await app.request(`/api/admin/roles/${roleId}/users/${userId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    })

    const [afterUnassign] =
      await sql`SELECT permission_version FROM kernel.users WHERE id = ${userId}`
    expect(afterUnassign.permission_version).toBe(before.permission_version + 1)

    // Assign (bumps again)
    await app.request(`/api/admin/roles/${roleId}/users`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    })

    const [afterAssign] =
      await sql`SELECT permission_version FROM kernel.users WHERE id = ${userId}`
    expect(afterAssign.permission_version).toBe(before.permission_version + 2)
  })
})
