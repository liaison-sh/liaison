// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { __privileged_db__ as db } from "~/db/connection"
import { roleScopeGrants, roles, userRoles, users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { verifyAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("token refresh recomputes permissions", () => {
  let adminToken: string
  let refreshToken: string

  beforeAll(async () => {
    await acquireTestLock()

    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "permtest@test.com",
        password: "testpass123",
        name: "Perm Test",
      }),
    })
    const body = (await res.json()) as any as any
    adminToken = body.data.accessToken
    refreshToken = body.data.refreshToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("permissions are enforced after role change via token refresh", async () => {
    // Original admin token can access admin-protected routes
    const adminCheck = await app.request("/api/users/me", {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(adminCheck.status).toBe(200)

    // Create a new limited role and reassign the user
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, "permtest@test.com"))
      .limit(1)

    const [limitedRole] = await db
      .insert(roles)
      .values({ orgId: user.orgId, name: "refresh-perm-test-viewer", description: "Read only" })
      .returning()

    await db.insert(roleScopeGrants).values({ roleId: limitedRole.id, scope: "kernel:audit:read" })

    // Remove old roles and assign new one
    await db.delete(userRoles).where(eq(userRoles.userId, user.id))
    await db
      .insert(userRoles)
      .values({ userId: user.id, roleId: limitedRole.id, orgId: user.orgId })

    // Refresh the token — this reloads permissions from DB and embeds them in the new JWT
    const refreshRes = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    })
    expect(refreshRes.status).toBe(200)
    const refreshBody = (await refreshRes.json()) as any

    // Verify the refreshed token has updated scopes embedded
    const refreshed = await verifyAccessToken(refreshBody.data.accessToken, env.JWT_SECRET)
    expect(refreshed.userId).toBe(user.id)
    expect(refreshed.orgId).toBe(user.orgId)
    expect(refreshed.scopes).toContain("kernel:audit:read")
    expect(refreshed.scopes).not.toContain("*")

    // Admin-only routes should now be forbidden with the refreshed (demoted) token
    const newToken = refreshBody.data.accessToken
    const threadsRes = await app.request("/api/threads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${newToken}`,
      },
      body: JSON.stringify({ participantIds: [], title: "Should fail" }),
    })
    // Without kernel:threads:write scope, thread creation should be denied
    expect(threadsRes.status).toBe(403)
  })

  it("rejects old access token after authVersion increment (T2)", async () => {
    // Use the admin token from beforeAll — no need for a fresh bootstrap
    const oldToken = adminToken

    // Verify old token works
    const checkRes = await app.request("/api/users/me", {
      headers: { Authorization: `Bearer ${oldToken}` },
    })
    expect(checkRes.status).toBe(200)

    // Increment authVersion directly in DB (simulates password reset)
    const decoded = await verifyAccessToken(oldToken, env.JWT_SECRET)
    await db
      .update(users)
      .set({ authVersion: decoded.authVersion + 1 })
      .where(eq(users.id, decoded.userId))

    // Invalidate auth cache so the test doesn't pass on stale cached authVersion
    const { invalidateAuthCache } = await import("~/middleware/auth")
    invalidateAuthCache(decoded.userId)

    // Old token should now be rejected (authVersion mismatch)
    const rejectedRes = await app.request("/api/users/me", {
      headers: { Authorization: `Bearer ${oldToken}` },
    })
    expect(rejectedRes.status).toBe(401)
  })
})
