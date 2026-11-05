// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("user profile", () => {
  let token: string

  beforeAll(async () => {
    await acquireTestLock()
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpass123", name: "Admin" }),
    })
    token = ((await res.json()) as any as any).data.accessToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("GET /api/users/me returns profile", async () => {
    const res = await app.request("/api/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any as any
    expect(body.data.email).toBe("admin@test.com")
    expect(body.data.name).toBe("Admin")
    // The raw settings blob is not exposed on the profile.
    expect(body.data.settings).toBeUndefined()
  })

  it("PATCH /api/users/me updates profile", async () => {
    const res = await app.request("/api/users/me", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "Updated Admin", timezone: "Europe/Paris" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any as any
    expect(body.data.name).toBe("Updated Admin")
    expect(body.data.timezone).toBe("Europe/Paris")
  })

  it("cannot update email via profile endpoint", async () => {
    const res = await app.request("/api/users/me", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email: "new@test.com" }),
    })
    expect(res.status).toBe(200)
    const readRes = await app.request("/api/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = (await readRes.json()) as any
    expect(body.data.email).toBe("admin@test.com")
  })
})

describe("user deactivation", () => {
  let adminToken: string
  let userId: string
  let userRefreshToken: string

  beforeAll(async () => {
    await acquireTestLock()

    const adminRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpass123", name: "Admin" }),
    })
    adminToken = ((await adminRes.json()) as any).data.accessToken

    const roles = await sql`SELECT id FROM kernel.roles LIMIT 1`
    const inviteRes = await app.request("/api/admin/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ email: "target@test.com", roleId: roles[0].id }),
    })
    const inviteToken = ((await inviteRes.json()) as any).data.inviteToken

    const regRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteToken, password: "userpass123", name: "Target" }),
    })
    const regBody = (await regRes.json()) as any
    userRefreshToken = regBody.data.refreshToken

    const userRows = await sql`SELECT id FROM kernel.users WHERE email = 'target@test.com'`
    userId = userRows[0].id
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("admin deactivates user", async () => {
    const res = await app.request(`/api/admin/users/${userId}/deactivate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
  })

  it("deactivated user cannot login", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "target@test.com", password: "userpass123" }),
    })
    expect(res.status).toBe(401)
  })

  it("deactivated user cannot refresh", async () => {
    const res = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: userRefreshToken }),
    })
    expect(res.status).toBe(401)
  })

  it("admin reactivates user", async () => {
    const res = await app.request(`/api/admin/users/${userId}/reactivate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
  })

  it("reactivated user can login", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "target@test.com", password: "userpass123" }),
    })
    expect(res.status).toBe(200)
  })
})

describe("Fix #9: reactivateUser checks current status", () => {
  it("returns null when reactivating an already-active user", async () => {
    const { reactivateUser } = await import("~/modules/users/service")
    const { withPrivilegedDb } = await import("~/db/privileged")

    const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001"
    const TEST_USER_ID = "00000000-0000-0000-0000-000000000002"

    const result = await withPrivilegedDb(TEST_ORG_ID, "test-reactivate", (tx) =>
      reactivateUser(tx, {
        targetId: TEST_USER_ID,
        actorId: TEST_USER_ID,
        orgId: TEST_ORG_ID,
        actorScopes: ["*"],
      }),
    )
    // User is already active -> reactivateUser should return null (no-op)
    expect(result).toBeNull()
  })
})

describe("admin users list: people vs import placeholders", () => {
  let adminToken: string
  let orgId: string
  const PLACEHOLDER_ID = "00000000-0000-4000-8000-0000000000a1"
  const LEAVER_ID = "00000000-0000-4000-8000-0000000000a2"
  const ACTIVE_ID = "00000000-0000-4000-8000-0000000000a3"

  beforeAll(async () => {
    await acquireTestLock()
    const adminRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpass123", name: "Admin" }),
    })
    adminToken = ((await adminRes.json()) as any).data.accessToken
    const rows = await sql`SELECT org_id FROM kernel.users WHERE email = 'admin@test.com'`
    orgId = rows[0].org_id
    // The placeholder is the NEWEST row and shares a colleague's name: the old
    // created_at DESC order put it on top, above the real, active colleague.
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, created_at) VALUES
      (${ACTIVE_ID}, ${orgId}, 'sam@test.com', 'Sam Colleague', 'active', now() - interval '3 days'),
      (${LEAVER_ID}, ${orgId}, 'bea@test.com', 'Bea Leaver', 'deactivated', now() - interval '2 days'),
      (${PLACEHOLDER_ID}, ${orgId}, 'slack-import+sam@import.invalid', 'Sam Colleague', 'deactivated', now())`
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  async function list(query = "") {
    const res = await app.request(`/api/admin/users${query}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
    return (await res.json()) as any
  }

  it("lists real people only by default, active first then by name", async () => {
    const body = await list()
    expect(body.data.map((u: any) => u.email)).toEqual([
      "admin@test.com",
      "sam@test.com",
      "bea@test.com",
    ])
    expect(body.meta.total).toBe(3)
  })

  it("lists the import placeholders under kind=imported", async () => {
    const body = await list("?kind=imported")
    expect(body.data.map((u: any) => u.id)).toEqual([PLACEHOLDER_ID])
    expect(body.meta.total).toBe(1)
  })

  it("refuses to reactivate an import placeholder", async () => {
    const res = await app.request(`/api/admin/users/${PLACEHOLDER_ID}/reactivate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as any
    expect(body.error.code).toBe("IMPORT_PLACEHOLDER")
    const rows = await sql`SELECT status FROM kernel.users WHERE id = ${PLACEHOLDER_ID}`
    expect(rows[0].status).toBe("deactivated")
  })

  it("still reactivates a real deactivated person", async () => {
    const res = await app.request(`/api/admin/users/${LEAVER_ID}/reactivate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
  })
})
