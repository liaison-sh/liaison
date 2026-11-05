// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { PERSONAL_AGENT_DISPLAY_NAME } from "@liaison/shared"
import { sql } from "~/db"
import { generateToken, hashToken } from "~/lib/crypto"
import {
  AuthServiceError,
  bootstrapRegister,
  createSession,
  inviteRegister,
} from "~/modules/auth/auth"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("recovery code hashing", () => {
  it("hashToken produces hex SHA-256 hash", () => {
    const hash = hashToken("ABCD-1234")
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("same input produces same hash", () => {
    const h1 = hashToken("TEST-CODE")
    const h2 = hashToken("TEST-CODE")
    expect(h1).toBe(h2)
  })

  it("different inputs produce different hashes", () => {
    const h1 = hashToken("CODE-AAAA")
    const h2 = hashToken("CODE-BBBB")
    expect(h1).not.toBe(h2)
  })
})

describe("BOOTSTRAP: personal agent auto-creation", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("registering the first user creates exactly one personal agent owned by them", async () => {
    const tokens = await bootstrapRegister("ada@test.com", "Passw0rd!", "Ada Lovelace")

    const rows = await sql`
      SELECT kind, owner_user_id, handle, display_name, scope_ceiling
      FROM kernel.agents
      WHERE owner_user_id = ${tokens.userId}
    `

    expect(rows.length).toBe(1)
    expect(rows[0]?.kind).toBe("personal")
    expect(rows[0]?.handle).toBe("@adas-agent")
    expect(rows[0]?.display_name).toBe(PERSONAL_AGENT_DISPLAY_NAME)
  })
})

describe("INVITE REGISTER: personal agent auto-creation", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("accepting an invite creates exactly one personal agent owned by the new user", async () => {
    const admin = await bootstrapRegister("invite-admin@test.com", "Passw0rd!", "Invite Admin")

    const roles = await sql`SELECT id FROM kernel.roles WHERE name = 'admin' LIMIT 1`
    const roleId = roles[0].id

    const inviteToken = generateToken()
    const tokenHash = hashToken(inviteToken)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    await sql`
      INSERT INTO kernel.invitations (org_id, email, role_id, token_hash, invited_by, expires_at)
      VALUES (${admin.orgId}, 'bob@test.com', ${roleId}, ${tokenHash}, ${admin.userId}, ${expiresAt}::timestamptz)
    `

    const result = await inviteRegister(inviteToken, "Passw0rd!", "Bob Builder")
    if (!result.success) throw new Error(result.error)

    const rows = await sql`
      SELECT kind, owner_user_id, handle, display_name, scope_ceiling
      FROM kernel.agents
      WHERE owner_user_id = ${result.data.userId}
    `

    expect(rows.length).toBe(1)
    expect(rows[0]?.kind).toBe("personal")
    expect(rows[0]?.handle).toBe("@bobs-agent")
    expect(rows[0]?.display_name).toBe(PERSONAL_AGENT_DISPLAY_NAME)
  })
})

describe("createSession", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("mints nothing for an account that is not active, whichever sign-in path asks", async () => {
    for (const status of ["suspended", "deactivated"] as const) {
      const user = await minimal.person((await createTestOrg()).id)
      // The person's registration signed them in once: that session is not this call's.
      const before = await sql`SELECT id FROM kernel.sessions WHERE user_id = ${user.id}`
      await sql`UPDATE kernel.users SET status = ${status} WHERE id = ${user.id}`
      const err = await createSession(user.id, user.orgId).catch((e) => e)
      expect(err).toBeInstanceOf(AuthServiceError)
      const rows = await sql`SELECT id FROM kernel.sessions WHERE user_id = ${user.id}`
      expect(rows.map((r) => r.id)).toEqual(before.map((r) => r.id))
    }
  })
})
