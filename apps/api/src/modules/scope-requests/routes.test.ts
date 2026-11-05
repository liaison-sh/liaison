// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { invalidateAuthCache } from "~/middleware/auth"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Json = Record<string, any>

async function req(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  const res = await app.request(path, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as Json }
}

async function makeRole(adminToken: string, name: string, scopes: string[]) {
  const roleRes = await req("/api/admin/roles", {
    method: "POST",
    token: adminToken,
    body: { name },
  })
  const roleId = roleRes.body.data.id as string
  for (const scope of scopes) {
    await req(`/api/admin/roles/${roleId}/scopes`, {
      method: "POST",
      token: adminToken,
      body: { scope },
    })
  }
  return roleId
}

async function inviteAndRegister(adminToken: string, email: string, roleId: string) {
  const invite = await req("/api/admin/invites", {
    method: "POST",
    token: adminToken,
    body: { email, roleId },
  })
  const inviteToken = invite.body.data.inviteToken as string
  const reg = await req("/api/auth/register", {
    method: "POST",
    body: { inviteToken, password: "TestPass123!", name: email.split("@")[0] },
  })
  const token = reg.body.data.accessToken as string
  const me = await req("/api/users/me", { token })
  return { token, userId: me.body.data.id as string }
}

describe("scope-requests routes", () => {
  let adminToken: string
  let requesterRoleId: string
  let ctoToken: string
  let seq = 0

  // Each test mints a fresh requester so a grant in one test (which bumps
  // permissionVersion and invalidates that user's token) can't break later tests.
  async function freshRequester() {
    seq += 1
    return inviteAndRegister(adminToken, `sr-user-${seq}-${Date.now()}@test.com`, requesterRoleId)
  }

  beforeAll(async () => {
    await acquireTestLock()

    const bootstrap = await req("/api/auth/register", {
      method: "POST",
      body: { email: "sr-admin@test.com", password: "TestPass123!", name: "Admin" },
    })
    adminToken = bootstrap.body.data.accessToken

    // Requester role: a baseline scope, none of the scopes requested in the tests.
    requesterRoleId = await makeRole(adminToken, "sr-requester", ["kernel:threads:read"])

    // CTO: holds kernel:scope_requests:admin but NOT kernel:contacts:write etc.
    const ctoRole = await makeRole(adminToken, "sr-cto", ["kernel:scope_requests:admin"])
    const cto = await inviteAndRegister(adminToken, "sr-cto@test.com", ctoRole)
    ctoToken = cto.token

    invalidateAuthCache()
  })

  afterAll(releaseTestLock)

  it("user requests a scope, admin approves, user gains the grant", async () => {
    const requester = await freshRequester()
    const reqRes = await req("/api/scope-requests", {
      method: "POST",
      token: requester.token,
      body: { scopes: ["kernel:contacts:write"], reason: "Need to edit contacts" },
    })
    expect(reqRes.status).toBe(201)
    const reqId = reqRes.body.data.id as string
    expect(reqId).toBeTruthy()

    const list = await req("/api/scope-requests?status=pending", { token: adminToken })
    expect(list.status).toBe(200)
    expect(list.body.data.some((r: Json) => r.id === reqId)).toBe(true)

    const dec = await req(`/api/scope-requests/${reqId}/decide`, {
      method: "POST",
      token: adminToken,
      body: { decision: "approve" },
    })
    expect(dec.status).toBe(200)
    expect(dec.body.data.status).toBe("approved")

    // The grant landed in user_scope_grants (deterministic; propagation via permissionVersion).
    const grant =
      await sql`SELECT 1 FROM kernel.user_scope_grants WHERE user_id = ${requester.userId} AND scope = 'kernel:contacts:write'`
    expect(grant.length).toBe(1)
  })

  // The grant INSERT hit the unique index and its 23505 was caught INSIDE the
  // approval's transaction, which Postgres then refuses to use: the status
  // UPDATE right after failed with 25P02 and the approve answered 500, every
  // time, for a person who already held the scope.
  it("approving a scope the requester already holds succeeds as a no-op grant", async () => {
    const requester = await freshRequester()
    const reqRes = await req("/api/scope-requests", {
      method: "POST",
      token: requester.token,
      body: { scopes: ["kernel:contacts:write"], reason: "Already granted meanwhile" },
    })
    expect(reqRes.status).toBe(201)
    const reqId = reqRes.body.data.id as string
    const [{ org_id: orgId }] =
      await sql`SELECT org_id FROM kernel.users WHERE id = ${requester.userId}`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${requester.userId}, ${orgId}, 'kernel:contacts:write')`

    const dec = await req(`/api/scope-requests/${reqId}/decide`, {
      method: "POST",
      token: adminToken,
      body: { decision: "approve" },
    })
    expect(dec.status).toBe(200)
    expect(dec.body.data.status).toBe("approved")
    const [row] = await sql`SELECT status FROM kernel.scope_requests WHERE id = ${reqId}`
    expect(row.status).toBe("approved")
    const grants =
      await sql`SELECT 1 FROM kernel.user_scope_grants WHERE user_id = ${requester.userId} AND scope = 'kernel:contacts:write'`
    expect(grants.length).toBe(1)
  })

  it("non-* approver cannot grant a scope they don't hold — request stays pending", async () => {
    const requester = await freshRequester()
    const reqRes = await req("/api/scope-requests", {
      method: "POST",
      token: requester.token,
      body: { scopes: ["kernel:org:admin"], reason: "Need org admin" },
    })
    const reqId = reqRes.body.data.id as string

    const dec = await req(`/api/scope-requests/${reqId}/decide`, {
      method: "POST",
      token: ctoToken,
      body: { decision: "approve" },
    })
    expect(dec.status).toBe(403)
    expect(dec.body.error.message).toMatch(/kernel:org:admin/)

    const still = await req(`/api/scope-requests/${reqId}`, { token: adminToken })
    expect(still.body.data.status).toBe("pending")
  })

  it("a non-admin cannot decide — 403 names kernel:scope_requests:admin", async () => {
    const requester = await freshRequester()
    const reqRes = await req("/api/scope-requests", {
      method: "POST",
      token: requester.token,
      body: { scopes: ["kernel:contacts:read"] },
    })
    const reqId = reqRes.body.data.id as string

    const dec = await req(`/api/scope-requests/${reqId}/decide`, {
      method: "POST",
      token: requester.token,
      body: { decision: "approve" },
    })
    expect(dec.status).toBe(403)
    expect(dec.body.error.details?.missingScope).toBe("kernel:scope_requests:admin")
  })

  it("double-decide is rejected with 409", async () => {
    const requester = await freshRequester()
    const reqRes = await req("/api/scope-requests", {
      method: "POST",
      token: requester.token,
      body: { scopes: ["kernel:audit:read"] },
    })
    const reqId = reqRes.body.data.id as string

    const first = await req(`/api/scope-requests/${reqId}/decide`, {
      method: "POST",
      token: adminToken,
      body: { decision: "approve" },
    })
    expect(first.status).toBe(200)

    const second = await req(`/api/scope-requests/${reqId}/decide`, {
      method: "POST",
      token: adminToken,
      body: { decision: "approve" },
    })
    expect(second.status).toBe(409)
  })

  it("duplicate pending request returns the existing one (dedupe)", async () => {
    const requester = await freshRequester()
    const a = await req("/api/scope-requests", {
      method: "POST",
      token: requester.token,
      body: { scopes: ["kernel:files:read"] },
    })
    const b = await req("/api/scope-requests", {
      method: "POST",
      token: requester.token,
      body: { scopes: ["kernel:files:read"] },
    })
    expect(a.body.data.id).toBe(b.body.data.id)
  })
})
