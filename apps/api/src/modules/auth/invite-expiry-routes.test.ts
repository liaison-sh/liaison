// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { invitations } from "~/db/schema/kernel"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("invitation expiry", () => {
  let adminToken: string
  let roleId: string

  beforeAll(async () => {
    await acquireTestLock()

    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@expiry.com", password: "testpass123", name: "Admin" }),
    })
    const body = (await res.json()) as any as any
    adminToken = body.data.accessToken

    const roles = await sql`SELECT id FROM kernel.roles WHERE name = 'admin' LIMIT 1`
    roleId = roles[0].id
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("rejects expired invitation", async () => {
    // Create invite
    const inviteRes = await app.request("/api/admin/invites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ email: "expired@test.com", roleId }),
    })
    const inviteBody = (await inviteRes.json()) as any
    const inviteToken = inviteBody.data.inviteToken

    // Manually expire the invitation in DB
    const { hashToken } = await import("~/lib/crypto")
    const tokenHash = hashToken(inviteToken)
    await db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.tokenHash, tokenHash))

    // Try to register with expired invite
    const registerRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteToken,
        password: "testpass123",
        name: "Expired User",
      }),
    })
    expect(registerRes.status).toBe(400)
  })
})
