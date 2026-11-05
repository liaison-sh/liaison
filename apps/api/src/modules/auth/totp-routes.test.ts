// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("invitation flow", () => {
  let adminToken: string
  let roleId: string

  beforeAll(async () => {
    await acquireTestLock()

    // Bootstrap admin
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpass123", name: "Admin" }),
    })
    const body = (await res.json()) as any as any
    adminToken = body.data.accessToken

    const roles = await sql`SELECT id FROM kernel.roles WHERE name = 'admin' LIMIT 1`
    roleId = roles[0].id
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("admin creates invite and invitee registers", async () => {
    const inviteRes = await app.request("/api/admin/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ email: "user@test.com", roleId }),
    })
    expect(inviteRes.status).toBe(201)
    const inviteBody = (await inviteRes.json()) as any
    expect(inviteBody.data.inviteToken).toBeDefined()

    const registerRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteToken: inviteBody.data.inviteToken,
        password: "userpass123",
        name: "User",
      }),
    })
    expect(registerRes.status).toBe(200)
    const registerBody = (await registerRes.json()) as any
    expect(registerBody.data.accessToken).toBeDefined()
  })

  it("rejects reuse of accepted invitation", async () => {
    const inviteRes = await app.request("/api/admin/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ email: "user2@test.com", roleId }),
    })
    const { data } = (await inviteRes.json()) as any

    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteToken: data.inviteToken, password: "pass12345", name: "U2" }),
    })

    const reuseRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteToken: data.inviteToken, password: "pass12345", name: "U3" }),
    })
    expect(reuseRes.status).toBe(400)
  })

  it("rejects invite for already-registered email", async () => {
    const res = await app.request("/api/admin/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ email: "admin@test.com", roleId }),
    })
    expect(res.status).toBe(409)
  })
})
