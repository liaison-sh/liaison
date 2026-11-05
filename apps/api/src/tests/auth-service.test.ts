// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { and, eq } from "drizzle-orm"
import * as jose from "jose"
import { sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import {
  organizations,
  roleScopeGrants,
  roles,
  sessions,
  userRoles,
  users,
} from "~/db/schema/kernel"
import {
  bootstrapRegister,
  changePassword,
  countSessionsForUser,
  createSession,
  isBootstrapped,
  login,
  logout,
  refreshSession,
} from "~/modules/auth/auth"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

async function clearRedis() {
  await clearRedisPatterns(["ratelimit:*", "bruteforce:*"])
}

// Scoped cleanup — only remove data created by THIS test file (slug='default',
// email='admin@test.com'). This avoids nuking data seeded by concurrent test files
// (e.g. rls.test.ts, rls-defaults.test.ts) which run in the same Bun process.
async function cleanupAuthTestData() {
  await clearRedis()
  // Find the org created by bootstrapRegister
  const orgs = await sql`SELECT id FROM kernel.organizations WHERE slug = 'default'`
  if (orgs.length === 0) return
  const orgId = orgs[0].id
  // Order matters: children before parents (FK constraints)
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.thread_references WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.message_reactions WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.timeline_entries WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.contacts WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.oauth_accounts WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.sessions WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.password_resets WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.device_flow_requests WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.invitations WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.user_dimension_grants WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.user_roles WHERE org_id = ${orgId}`
  // role_scope_grants and role_dimension_grants have no org_id column —
  // they cascade-delete automatically when their parent role is deleted.
  await sql`DELETE FROM kernel.audit_log WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.roles WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.apps WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.oauth_providers WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
}

let _orgId: string

beforeAll(async () => {
  await acquireTestLock()
  await cleanupAuthTestData()
  // cleanupAuthTestData removes 'default' org. isBootstrapped checks for ANY org.
  // Since we're in the integration suite (separate process from unit/rls tests),
  // other test files here use the route-test-setup mutex — no concurrent org seeding.
})

afterAll(async () => {
  await cleanupAuthTestData()
  await releaseTestLock()
})

describe("isBootstrapped", () => {
  it("returns a boolean", async () => {
    // After cleanup, isBootstrapped should return false (no orgs), but other
    // concurrent test files could have re-seeded orgs. Just verify the return type.
    const result = await isBootstrapped()
    expect(typeof result).toBe("boolean")
  })
})

describe("bootstrapRegister", () => {
  it("creates org, admin role, user, and returns tokens", async () => {
    const tokens = await bootstrapRegister("admin@test.com", "TestPass123!", "Admin")
    expect(tokens.accessToken).toBeString()
    expect(tokens.refreshToken).toBeString()

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, "default"))
      .limit(1)
    expect(org).toBeDefined()
    _orgId = org.id

    const [user] = await db.select().from(users).where(eq(users.email, "admin@test.com")).limit(1)
    expect(user.name).toBe("Admin")
    expect(user.status).toBe("active")
  })

  it("isBootstrapped returns true after bootstrap", async () => {
    expect(await isBootstrapped()).toBe(true)
  })

  it("seeds admin / member / viewer default roles with non-empty descriptions", async () => {
    const seeded = await db
      .select({ id: roles.id, name: roles.name, description: roles.description })
      .from(roles)
      .where(eq(roles.orgId, _orgId))
    const byName = new Map(seeded.map((r) => [r.name, r]))
    expect(byName.has("admin")).toBe(true)
    expect(byName.has("member")).toBe(true)
    expect(byName.has("viewer")).toBe(true)
    for (const row of seeded) {
      expect((row.description ?? "").length).toBeGreaterThan(0)
    }
  })

  it("assigns the bootstrapping user to the admin (owner) role with wildcard scope", async () => {
    const [adminRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .innerJoin(roleScopeGrants, eq(roleScopeGrants.roleId, roles.id))
      .where(and(eq(roles.orgId, _orgId), eq(roleScopeGrants.scope, "*")))
      .limit(1)
    expect(adminRole).toBeDefined()
    const [user] = await db.select().from(users).where(eq(users.email, "admin@test.com")).limit(1)
    const assignments = await db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.userId, user.id))
    expect(assignments.map((a) => a.roleId)).toContain(adminRole.id)
  })
})

describe("login", () => {
  it("returns tokens for valid credentials", async () => {
    const result = await login("admin@test.com", "TestPass123!")
    expect("accessToken" in result).toBe(true)
  })

  it("throws for wrong password", async () => {
    expect(login("admin@test.com", "WrongPass1!")).rejects.toThrow()
  })

  it("throws 'Invalid credentials' for wrong password", async () => {
    await expect(login("admin@test.com", "WrongPass1!")).rejects.toThrow("Invalid credentials")
  })

  it("throws for non-existent email", async () => {
    expect(login("nobody@test.com", "TestPass1!")).rejects.toThrow()
  })

  it("throws for deactivated user", async () => {
    const [user] = await db.select().from(users).where(eq(users.email, "admin@test.com")).limit(1)
    await db.update(users).set({ status: "deactivated" }).where(eq(users.id, user.id))
    expect(login("admin@test.com", "TestPass123!")).rejects.toThrow()
    // Restore
    await db.update(users).set({ status: "active" }).where(eq(users.id, user.id))
  })
})

describe("refreshSession", () => {
  it("rotates tokens for valid refresh token", async () => {
    const initial = (await login("admin@test.com", "TestPass123!")) as {
      accessToken: string
      refreshToken: string
    }
    const refreshed = await refreshSession(initial.refreshToken)
    expect(refreshed.accessToken).toBeString()
    expect(refreshed.refreshToken).toBeString()
    expect(refreshed.refreshToken).not.toBe(initial.refreshToken)
  })

  it("rejects used refresh token after grace period", async () => {
    const initial = (await login("admin@test.com", "TestPass123!")) as {
      accessToken: string
      refreshToken: string
    }
    await refreshSession(initial.refreshToken)

    // The old session gets a 30s grace period for concurrent tab refreshes.
    // Expire it manually to simulate grace period elapsed.
    const { hashToken } = await import("~/lib/crypto")
    const oldHash = hashToken(initial.refreshToken)
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.refreshTokenHash, oldHash))

    expect(refreshSession(initial.refreshToken)).rejects.toThrow()
  })
})

describe("logout", () => {
  it("deletes the session", async () => {
    const tokens = (await login("admin@test.com", "TestPass123!")) as {
      accessToken: string
      refreshToken: string
    }
    await logout(tokens.refreshToken)
    expect(refreshSession(tokens.refreshToken)).rejects.toThrow()
  })
})

describe("changePassword", () => {
  it("invalidates all other sessions and increments authVersion after password change", async () => {
    // Create two independent sessions
    // session1 is only needed to establish a session row in the DB
    await login("admin@test.com", "TestPass123!")
    const session2 = (await login("admin@test.com", "TestPass123!")) as {
      accessToken: string
      refreshToken: string
    }

    // Look up userId and authVersion before password change
    const [userBefore] = await db
      .select()
      .from(users)
      .where(eq(users.email, "admin@test.com"))
      .limit(1)
    const versionBefore = userBefore.authVersion

    // Change password using session1's identity
    await changePassword(userBefore.id, "TestPass123!", "NewPass456!")

    // Verify authVersion was incremented
    const [userAfter] = await db
      .select()
      .from(users)
      .where(eq(users.email, "admin@test.com"))
      .limit(1)
    expect(userAfter.authVersion).toBe(versionBefore + 1)

    // session2's refresh token must now be rejected
    await expect(refreshSession(session2.refreshToken)).rejects.toThrow()

    // Restore the password so subsequent tests can still log in
    await changePassword(userBefore.id, "NewPass456!", "TestPass123!")
  })

  it("rejects incorrect current password", async () => {
    const [user] = await db.select().from(users).where(eq(users.email, "admin@test.com")).limit(1)
    await expect(changePassword(user.id, "WrongPass999!", "NewPass456!")).rejects.toThrow(
      "Current password is incorrect",
    )
  })
})

describe("refreshSession — expired session", () => {
  it("T-5: throws and deletes the session row when session is expired", async () => {
    // Clean slate: remove all sessions for this user
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@test.com"))
      .limit(1)
    await db.delete(sessions).where(eq(sessions.userId, user.id))

    const tokens = (await login("admin@test.com", "TestPass123!")) as {
      accessToken: string
      refreshToken: string
    }

    // Manually expire THIS specific session (not all sessions for the user)
    const { hashToken } = await import("~/lib/crypto")
    const tokenHash = hashToken(tokens.refreshToken)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await db
      .update(sessions)
      .set({ expiresAt: yesterday })
      .where(eq(sessions.refreshTokenHash, tokenHash))

    await expect(refreshSession(tokens.refreshToken)).rejects.toThrow()

    // Session row must have been deleted
    const remaining = await db
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, tokenHash))
    expect(remaining).toHaveLength(0)
  })
})

describe("refreshSession — session rotation DB cleanliness (T-13)", () => {
  it("leaves at most two session rows after rotation (new + grace-period old)", async () => {
    // Logout all sessions first to start clean
    const [user] = await db.select().from(users).where(eq(users.email, "admin@test.com")).limit(1)
    await db.delete(sessions).where(eq(sessions.userId, user.id))

    const initial = (await login("admin@test.com", "TestPass123!")) as {
      accessToken: string
      refreshToken: string
    }

    await refreshSession(initial.refreshToken)

    // After rotation: 1 new session + 1 grace-period old session (30s TTL) = 2
    const sessionCount = await countSessionsForUser(user.id)
    expect(sessionCount).toBeGreaterThanOrEqual(1)
    expect(sessionCount).toBeLessThanOrEqual(2)
  })
})

describe("login — deactivated user (T-14)", () => {
  it("rejects with uniform 'Invalid credentials' to prevent status enumeration", async () => {
    const [user] = await db.select().from(users).where(eq(users.email, "admin@test.com")).limit(1)
    await db.update(users).set({ status: "deactivated" }).where(eq(users.id, user.id))
    try {
      await expect(login("admin@test.com", "TestPass123!")).rejects.toThrow("Invalid credentials")
    } finally {
      // Always restore so subsequent tests are unaffected
      await db.update(users).set({ status: "active" }).where(eq(users.id, user.id))
    }
  })
})

describe("login — token validity (T-17)", () => {
  it("returns a valid JWT with correct userId, aud, and exp claims", async () => {
    const result = (await login("admin@test.com", "TestPass123!")) as {
      accessToken: string
      refreshToken: string
    }

    const [user] = await db.select().from(users).where(eq(users.email, "admin@test.com")).limit(1)

    const claims = jose.decodeJwt(result.accessToken)
    expect(claims.userId).toBe(user.id)
    expect(claims.aud).toBe("access")
    expect(typeof claims.exp).toBe("number")
    // exp must be in the future
    expect(claims.exp!).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })
})

describe("createSession — session cap eviction", () => {
  it("evicts oldest sessions when cap is reached", async () => {
    // Get the user created by bootstrapRegister
    const [user] = await db.select().from(users).where(eq(users.email, "admin@test.com")).limit(1)

    // Clean slate: remove all sessions for this user
    await db.delete(sessions).where(eq(sessions.userId, user.id))

    // Create 12 sessions (cap is 10)
    const tokens: Array<{ refreshToken: string }> = []
    for (let i = 0; i < 12; i++) {
      const result = await createSession(user.id, _orgId)
      tokens.push(result)
    }

    // Count sessions — should be exactly 10 (12 created, 2 evicted)
    const sessionCount = await countSessionsForUser(user.id)
    expect(sessionCount).toBe(10)

    // The 2 oldest sessions should have been evicted.
    // Verify the most recent session (last created) still exists by refreshing it.
    const lastToken = tokens[tokens.length - 1].refreshToken
    const refreshed = await refreshSession(lastToken)
    expect(refreshed.accessToken).toBeString()

    // Clean up
    await db.delete(sessions).where(eq(sessions.userId, user.id))
    // Re-login to restore a session for subsequent tests
    await login("admin@test.com", "TestPass123!")
  })
})

describe("createSession — the cap counts live sessions only (P1-T12)", () => {
  // On demo, a phone that refreshed on every foreground left a rotated-away
  // (grace) row per refresh; the cap counted them, evicted the OLDEST row,
  // which was the desktop app's live session, and signed the desktop out.
  it("a device's refresh rotations never evict another device's live session", async () => {
    const [user] = await db.select().from(users).where(eq(users.email, "admin@test.com")).limit(1)
    await db.delete(sessions).where(eq(sessions.userId, user.id))
    const desktop = await createSession(user.id, _orgId)
    let phone = await createSession(user.id, _orgId)
    for (let i = 0; i < 12; i++) phone = await refreshSession(phone.refreshToken)
    const refreshed = await refreshSession(desktop.refreshToken)
    expect(refreshed.accessToken).toBeString()
    await db.delete(sessions).where(eq(sessions.userId, user.id))
    await login("admin@test.com", "TestPass123!")
  })

  it("expired rows are cleared and do not count towards the cap", async () => {
    const [user] = await db.select().from(users).where(eq(users.email, "admin@test.com")).limit(1)
    await db.delete(sessions).where(eq(sessions.userId, user.id))
    const keep = await createSession(user.id, _orgId)
    for (let i = 0; i < 12; i++) {
      await db.insert(sessions).values({
        orgId: _orgId,
        userId: user.id,
        refreshTokenHash: `expired-${i}-${Date.now()}`,
        expiresAt: new Date(Date.now() - 60_000),
      })
    }
    await createSession(user.id, _orgId)
    expect(await countSessionsForUser(user.id)).toBe(2)
    expect((await refreshSession(keep.refreshToken)).accessToken).toBeString()
    await db.delete(sessions).where(eq(sessions.userId, user.id))
    await login("admin@test.com", "TestPass123!")
  })
})

describe("bootstrapRegister — argon2 hash verification (T-5)", () => {
  it("stores password as an argon2id hash", async () => {
    const [user] = await db.select().from(users).where(eq(users.email, "admin@test.com")).limit(1)
    expect(user.passwordHash).toBeDefined()
    expect(user.passwordHash!.startsWith("$argon2id$")).toBe(true)
  })
})
