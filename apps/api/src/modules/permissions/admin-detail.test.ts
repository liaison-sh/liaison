// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("admin detail endpoints", () => {
  let adminToken: string
  let memberToken: string
  let memberUserId: string
  let supportRoleId: string
  let adminHeaders: Record<string, string>

  beforeAll(async () => {
    await acquireTestLock()

    // Bootstrap admin (gets kernel:admin)
    const adminRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin-detail@test.com",
        password: "testpass123",
        name: "Admin",
      }),
    })
    adminToken = ((await adminRes.json()) as any).data.accessToken
    adminHeaders = { Authorization: `Bearer ${adminToken}` }

    // Create "support" role
    const roleRes = await app.request("/api/admin/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders },
      body: JSON.stringify({ name: "support", description: "Support team" }),
    })
    supportRoleId = ((await roleRes.json()) as any).data.id

    // Grant a known scope to the support role
    await app.request(`/api/admin/roles/${supportRoleId}/scopes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders },
      body: JSON.stringify({ scope: "kernel:contacts:read" }),
    })

    // Invite + register a member
    const inviteRes = await app.request("/api/admin/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders },
      body: JSON.stringify({ email: "member-detail@test.com", roleId: supportRoleId }),
    })
    const inviteToken = ((await inviteRes.json()) as any).data.inviteToken
    const regRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteToken, password: "memberpass1", name: "Member User" }),
    })
    const regBody = (await regRes.json()) as any
    memberToken = regBody.data.accessToken
    const u = await sql`SELECT id FROM kernel.users WHERE email = 'member-detail@test.com'`
    memberUserId = u[0].id
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("GET /api/admin/users returns roles per row", async () => {
    const res = await app.request("/api/admin/users?limit=10&page=1", { headers: adminHeaders })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const row = body.data.find((r: any) => r.id === memberUserId)
    expect(row).toBeDefined()
    expect(Array.isArray(row.roles)).toBe(true)
    expect(row.roles.map((r: any) => r.name)).toContain("support")
  })

  it("GET /api/admin/users/:id returns detail with effectiveScopes + dimensions", async () => {
    const res = await app.request(`/api/admin/users/${memberUserId}`, { headers: adminHeaders })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.id).toBe(memberUserId)
    expect(body.data).toHaveProperty("lastLoginAt")
    expect(body.data.roles.map((r: any) => r.name)).toContain("support")
    const found = body.data.effectiveScopes.find((s: any) => s.scope === "kernel:contacts:read")
    expect(found).toBeDefined()
    expect(found.fromRoles).toContain("support")
    expect(body.data.dimensions).toEqual(expect.any(Object))
  })

  it("GET /api/admin/users/:id returns 404 for unknown id", async () => {
    const res = await app.request("/api/admin/users/00000000-0000-4000-8000-000000000000", {
      headers: adminHeaders,
    })
    expect(res.status).toBe(404)
  })

  it("GET /api/admin/users/:id forbids non-admin", async () => {
    const res = await app.request(`/api/admin/users/${memberUserId}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    })
    expect(res.status).toBe(403)
  })

  it("GET /api/admin/roles includes memberCount and scopeCount per row", async () => {
    const res = await app.request("/api/admin/roles", { headers: adminHeaders })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const supportRow = body.data.find((r: any) => r.id === supportRoleId)
    expect(supportRow).toBeDefined()
    expect(typeof supportRow.memberCount).toBe("number")
    expect(typeof supportRow.scopeCount).toBe("number")
    expect(supportRow.memberCount).toBeGreaterThanOrEqual(1)
    expect(supportRow.scopeCount).toBeGreaterThanOrEqual(1)
  })

  it("GET /api/admin/roles/:id returns scopes, dimensionGrants, members", async () => {
    const res = await app.request(`/api/admin/roles/${supportRoleId}`, { headers: adminHeaders })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(Array.isArray(body.data.scopes)).toBe(true)
    expect(Array.isArray(body.data.dimensionGrants)).toBe(true)
    expect(Array.isArray(body.data.members)).toBe(true)
    expect(body.data.scopes[0]).toEqual(
      expect.objectContaining({
        scope: expect.any(String),
        grantedAt: expect.any(String),
      }),
    )
    expect(body.data.members.find((m: any) => m.id === memberUserId)).toBeDefined()
  })

  it("GET /api/admin/roles/:id returns 404 for unknown id", async () => {
    const res = await app.request("/api/admin/roles/00000000-0000-4000-8000-000000000000", {
      headers: adminHeaders,
    })
    expect(res.status).toBe(404)
  })
})
