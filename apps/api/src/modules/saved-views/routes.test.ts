// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("saved-views routes", () => {
  let adminToken: string
  let userToken: string

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
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ email: "sv-user@test.com", roleId: roles[0].id }),
    })
    const inviteToken = ((await inviteRes.json()) as any).data.inviteToken
    const regRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteToken, password: "userpass123", name: "User" }),
    })
    userToken = ((await regRes.json()) as any).data.accessToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("rejects unauthenticated requests", async () => {
    const res = await app.request("/api/saved-views?app=tickets&viewId=inbox")
    expect(res.status).toBe(401)
  })

  it("returns 403 when sharedWithOrg=true and actor lacks share scope", async () => {
    await sql`DELETE FROM kernel.user_roles WHERE user_id = (SELECT id FROM kernel.users WHERE email = 'sv-user@test.com')`
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "sv-user@test.com", password: "userpass123" }),
    })
    const noScopeToken = ((await loginRes.json()) as any).data.accessToken
    const res = await app.request("/api/saved-views", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${noScopeToken}` },
      body: JSON.stringify({
        app: "tickets",
        viewId: "inbox",
        name: "Bad share",
        payload: {},
        sharedWithOrg: true,
      }),
    })
    expect(res.status).toBe(403)
    // Restore role for downstream tests
    await sql`INSERT INTO kernel.user_roles (org_id, user_id, role_id)
      SELECT u.org_id, u.id, r.id FROM kernel.users u, kernel.roles r
      WHERE u.email = 'sv-user@test.com' LIMIT 1`
    // Reissue token for downstream
    const reloginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "sv-user@test.com", password: "userpass123" }),
    })
    userToken = ((await reloginRes.json()) as any).data.accessToken
  })

  it("creates a private view and lists it back", async () => {
    const createRes = await app.request("/api/saved-views", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        app: "tickets",
        viewId: "inbox",
        name: "Mine",
        payload: { smartFilter: "all-open" },
      }),
    })
    expect(createRes.status).toBe(201)
    const created = ((await createRes.json()) as any).data

    const listRes = await app.request("/api/saved-views?app=tickets&viewId=inbox", {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect(listRes.status).toBe(200)
    const list = ((await listRes.json()) as any).data
    expect(list.map((v: any) => v.id)).toContain(created.id)
    expect(list.find((v: any) => v.id === created.id).name).toBe("Mine")
  })

  it("returns 400 when listing without app or viewId", async () => {
    const res = await app.request("/api/saved-views", {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect(res.status).toBe(400)
  })

  it("supports patch + delete round-trip", async () => {
    const createRes = await app.request("/api/saved-views", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        app: "tickets",
        viewId: "inbox",
        name: "Edit me",
        payload: {},
      }),
    })
    const id = ((await createRes.json()) as any).data.id

    const patchRes = await app.request(`/api/saved-views/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ name: "Renamed" }),
    })
    expect(patchRes.status).toBe(200)
    expect(((await patchRes.json()) as any).data.name).toBe("Renamed")

    const delRes = await app.request(`/api/saved-views/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect(delRes.status).toBe(200)
    expect(((await delRes.json()) as any).data).toEqual({ deleted: true })
  })

  it("clones a shared view into a private copy", async () => {
    const created = await app.request("/api/saved-views", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        app: "tickets",
        viewId: "inbox",
        name: "Sharable",
        payload: { x: 1 },
        sharedWithOrg: true,
      }),
    })
    expect(created.status).toBe(201)
    const sharedId = ((await created.json()) as any).data.id

    const cloneRes = await app.request(`/api/saved-views/${sharedId}/clone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect(cloneRes.status).toBe(201)
    const clone = ((await cloneRes.json()) as any).data
    expect(clone.sharedWithOrg).toBe(false)
    expect(clone.payload).toEqual({ x: 1 })
  })
})
