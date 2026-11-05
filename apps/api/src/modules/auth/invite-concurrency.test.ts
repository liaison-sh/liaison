// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { generateToken, hashToken } from "~/lib/crypto"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("concurrent invite claims", () => {
  let roleId: string

  beforeAll(async () => {
    await acquireTestLock()

    // Bootstrap: create admin user + org
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin@concurrency.com",
        password: "testpass123",
        name: "Admin",
      }),
    })

    const roles = await sql`SELECT id FROM kernel.roles WHERE name = 'admin' LIMIT 1`
    roleId = roles[0].id
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("concurrent invite claims — only one succeeds", async () => {
    const orgRows = await sql`SELECT id FROM kernel.organizations LIMIT 1`
    const orgId = orgRows[0].id
    const adminRows =
      await sql`SELECT id FROM kernel.users WHERE email = 'admin@concurrency.com' LIMIT 1`
    const adminId = adminRows[0].id

    // Create invitation directly in DB to avoid route-level mock interference
    const token = generateToken()
    const tokenHash = hashToken(token)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    await sql`
      INSERT INTO kernel.invitations (org_id, email, role_id, token_hash, invited_by, expires_at)
      VALUES (${orgId}, 'race@test.com', ${roleId}, ${tokenHash}, ${adminId}, ${expiresAt}::timestamptz)
    `

    // Attempt two concurrent registrations with the same invite token
    const [res1, res2] = await Promise.all([
      app.request("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteToken: token, password: "testpass123", name: "User A" }),
      }),
      app.request("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteToken: token, password: "testpass123", name: "User B" }),
      }),
    ])

    const statuses = [res1.status, res2.status].sort()

    // Exactly one should succeed (200) and the other should fail (400)
    expect(statuses).toEqual([200, 400])

    // Verify only one user was created with that email
    const users = await sql`SELECT id FROM kernel.users WHERE email = 'race@test.com'`
    expect(users).toHaveLength(1)
  })
})
