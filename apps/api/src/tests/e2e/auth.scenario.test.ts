// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import {
  api,
  createUserWithScopes,
  extractSecretFromUri,
  generateTotpCode,
  login,
} from "@liaison/test-helpers"
import { setupScenario, teardownScenario } from "./setup"

describe("Auth Scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string

  // Shared state across sequential tests
  let invitedUserId: string
  let invitedUserToken: string
  let invitedUserRefresh: string
  let totpSecret: string
  let recoveryCodes: string[]

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 1,
      org: { name: "Auth Test Org" },
      populate: {
        users: { count: 10 },
        threads: { count: 20, participants: "random(2-4)", messages: "random(1-3)" },
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  // ─── Registration & Bootstrap (from auth.e2e.test.ts S02) ───

  it("bootstrap registration — first user creates org", async () => {
    const me = await api(url, "/api/users/me", { token: world.admin.token })
    expect(me.status).toBe(200)
    expect(me.body.data.email).toBe("admin@e2e.test")
    expect(me.body.data.name).toBe("E2E Admin")
    expect(me.body.data.status).toBe("active")

    const org = await api(url, "/api/org", { token: world.admin.token })
    expect(org.status).toBe(200)
    expect(org.body.data.timezone).toBe("UTC")
    expect(org.body.data.settings).toMatchObject({
      fileSizeLimitMb: 50,
      auditRetentionDays: 90,
    })
    // The storage quota is an operator cap (organizations.caps), not a setting.
    expect(org.body.data.settings.storageQuotaGb).toBeUndefined()
  })

  it("registration without invite rejected after bootstrap", async () => {
    const res = await api(url, "/api/auth/register", {
      body: { email: "rogue@test.com", password: "Rogue123!", name: "Rogue" },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain("Invitation required")
  })

  // ─── Login Lifecycle (from auth.e2e.test.ts S04) ───

  it("full auth lifecycle — login, access, refresh, logout", async () => {
    const loginRes = await api(url, "/api/auth/login", {
      body: { email: "admin@e2e.test", password: "SecurePass1!" },
    })
    expect(loginRes.status).toBe(200)

    const me = await api(url, "/api/users/me", { token: loginRes.body.data.accessToken })
    expect(me.status).toBe(200)
    expect(me.body.data.email).toBe("admin@e2e.test")

    const refreshRes = await api(url, "/api/auth/refresh", {
      body: { refreshToken: loginRes.body.data.refreshToken },
    })
    expect(refreshRes.status).toBe(200)

    // Old refresh token is rotated — within the 30s grace window it may still
    // succeed (concurrent-tab safety). Post-logout rejection below is the
    // authoritative check; integration tests cover grace-period expiry.
    const oldRefresh = await api(url, "/api/auth/refresh", {
      body: { refreshToken: loginRes.body.data.refreshToken },
    })
    expect([200, 401]).toContain(oldRefresh.status)

    // New token works
    const me2 = await api(url, "/api/users/me", { token: refreshRes.body.data.accessToken })
    expect(me2.status).toBe(200)

    // Logout
    const logoutRes = await api(url, "/api/auth/logout", {
      method: "POST",
      token: refreshRes.body.data.accessToken,
      body: { refreshToken: refreshRes.body.data.refreshToken },
    })
    expect(logoutRes.status).toBe(200)

    // Post-logout refresh fails
    const postLogout = await api(url, "/api/auth/refresh", {
      body: { refreshToken: refreshRes.body.data.refreshToken },
    })
    expect(postLogout.status).toBe(401)
  })

  // ─── Invitation Flow (from auth.e2e.test.ts S05) ───

  it("invitation flow — admin invites, invitee registers with role", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    // Create role with scopes
    const [role] = await env.db.sql.unsafe(
      `INSERT INTO ${ks}.roles (org_id, name, description)
       VALUES ($1, $2, 'E2E test role') RETURNING id`,
      [world.org.id, `e2e-invite-role-${Date.now()}`],
    )
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.role_scope_grants (role_id, scope) VALUES ($1, $2)`,
      [role.id, "kernel:threads:read"],
    )
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.role_scope_grants (role_id, scope) VALUES ($1, $2)`,
      [role.id, "kernel:threads:write"],
    )

    const inviteRes = await api(url, "/api/admin/invites", {
      token: world.admin.token,
      body: { email: "invited@e2e.test", roleId: role.id },
    })
    expect(inviteRes.status).toBe(201)

    const regRes = await api(url, "/api/auth/register", {
      body: {
        inviteToken: inviteRes.body.data.inviteToken,
        password: "SecurePass1!",
        name: "Invited User",
      },
    })
    expect(regRes.status).toBe(200)
    invitedUserToken = regRes.body.data.accessToken
    invitedUserRefresh = regRes.body.data.refreshToken

    const me = await api(url, "/api/users/me", { token: invitedUserToken })
    expect(me.status).toBe(200)
    expect(me.body.data.email).toBe("invited@e2e.test")
    expect(me.body.data.name).toBe("Invited User")
    invitedUserId = me.body.data.id
  })

  // ─── Password Reset (from auth.e2e.test.ts S06) ───

  it("password reset — request, reset, old sessions killed", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    // Login invited user to create active session
    const loginRes = await login(url, "invited@e2e.test", "SecurePass1!")

    // Request password reset
    const reqRes = await api(url, "/api/auth/password-reset/request", {
      body: { email: "invited@e2e.test" },
    })
    expect(reqRes.status).toBe(200)

    // Insert test reset token
    const resetToken = "test-reset-token-12345"
    const { createHash } = await import("node:crypto")
    const hashedToken = createHash("sha256").update(resetToken).digest("hex")
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.password_resets (user_id, org_id, token_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')`,
      [invitedUserId, world.org.id, hashedToken],
    )

    // Confirm reset
    const confirmRes = await api(url, "/api/auth/password-reset/confirm", {
      body: { token: resetToken, newPassword: "NewPassword1!" },
    })
    expect(confirmRes.status).toBe(200)

    // Old refresh token invalidated
    const oldRefreshRes = await api(url, "/api/auth/refresh", {
      body: { refreshToken: loginRes.refreshToken },
    })
    expect(oldRefreshRes.status).toBe(401)

    // Old password fails
    const oldPassRes = await api(url, "/api/auth/login", {
      body: { email: "invited@e2e.test", password: "SecurePass1!" },
    })
    expect(oldPassRes.status).toBe(401)

    // New password works
    const newPassRes = await api(url, "/api/auth/login", {
      body: { email: "invited@e2e.test", password: "NewPassword1!" },
    })
    expect(newPassRes.status).toBe(200)
    invitedUserToken = newPassRes.body.data.accessToken
    invitedUserRefresh = newPassRes.body.data.refreshToken
  })

  // ─── User Deactivation/Reactivation (from auth.e2e.test.ts S07) ───

  it("user deactivation and reactivation", async () => {
    // Login invited user
    const loginRes = await login(url, "invited@e2e.test", "NewPassword1!")

    // Deactivate
    const deactivateRes = await api(url, `/api/admin/users/${invitedUserId}/deactivate`, {
      method: "POST",
      token: world.admin.token,
    })
    expect(deactivateRes.status).toBe(200)

    // Refresh fails after deactivation
    const refreshRes = await api(url, "/api/auth/refresh", {
      body: { refreshToken: loginRes.refreshToken },
    })
    expect(refreshRes.status).toBe(401)

    // Login fails
    const loginFail = await api(url, "/api/auth/login", {
      body: { email: "invited@e2e.test", password: "NewPassword1!" },
    })
    expect(loginFail.status).toBe(401)

    // Reactivate
    const reactivateRes = await api(url, `/api/admin/users/${invitedUserId}/reactivate`, {
      method: "POST",
      token: world.admin.token,
    })
    expect(reactivateRes.status).toBe(200)

    // Login works again
    const loginOk = await api(url, "/api/auth/login", {
      body: { email: "invited@e2e.test", password: "NewPassword1!" },
    })
    expect(loginOk.status).toBe(200)
    invitedUserToken = loginOk.body.data.accessToken
    invitedUserRefresh = loginOk.body.data.refreshToken
  })

  // ─── User Profile Update (from auth.e2e.test.ts S08) ───

  it("user profile update", async () => {
    const patchRes = await api(url, "/api/users/me", {
      method: "PATCH",
      token: world.admin.token,
      body: { name: "Updated Name", timezone: "Europe/Paris", locale: "fr-FR" },
    })
    expect(patchRes.status).toBe(200)

    const me = await api(url, "/api/users/me", { token: world.admin.token })
    expect(me.status).toBe(200)
    expect(me.body.data.name).toBe("Updated Name")
    expect(me.body.data.timezone).toBe("Europe/Paris")
    expect(me.body.data.locale).toBe("fr-FR")
  })

  // ─── TOTP/MFA (from auth.e2e.test.ts S09) ───

  it("TOTP enrollment and login with 2FA", async () => {
    const setupRes = await api(url, "/api/auth/totp/setup", {
      method: "POST",
      token: invitedUserToken,
      body: { currentPassword: "NewPassword1!" },
    })
    expect(setupRes.status).toBe(200)
    expect(setupRes.body.data.otpauthUri).toMatch(/^otpauth:\/\/totp\//)
    expect(setupRes.body.data.recoveryCodes).toBeArray()
    expect(setupRes.body.data.recoveryCodes.length).toBe(8)

    totpSecret = extractSecretFromUri(setupRes.body.data.otpauthUri)
    recoveryCodes = setupRes.body.data.recoveryCodes

    // Confirm TOTP
    const code = generateTotpCode(totpSecret)
    const confirmRes = await api(url, "/api/auth/totp/confirm", {
      method: "POST",
      token: invitedUserToken,
      body: { code },
    })
    expect(confirmRes.status).toBe(200)

    // Logout
    await api(url, "/api/auth/logout", {
      method: "POST",
      token: invitedUserToken,
      body: { refreshToken: invitedUserRefresh },
    })

    // Login now requires TOTP
    const loginRes = await api(url, "/api/auth/login", {
      body: { email: "invited@e2e.test", password: "NewPassword1!" },
    })
    expect(loginRes.status).toBe(200)
    expect(loginRes.body.data.totpRequired).toBe(true)
    const challengeToken = loginRes.body.data.challengeToken
    expect(typeof challengeToken).toBe("string")
    expect(challengeToken.length).toBeGreaterThan(10)

    // Verify TOTP
    const totpCode = generateTotpCode(totpSecret)
    const verifyRes = await api(url, "/api/auth/totp/verify", {
      body: { challengeToken, code: totpCode },
    })
    expect(verifyRes.status).toBe(200)
    expect(typeof verifyRes.body.data.accessToken).toBe("string")
    expect(verifyRes.body.data.accessToken.length).toBeGreaterThan(10)
    expect(typeof verifyRes.body.data.refreshToken).toBe("string")
    expect(verifyRes.body.data.refreshToken.length).toBeGreaterThan(10)

    // Verify tokens work
    const me = await api(url, "/api/users/me", { token: verifyRes.body.data.accessToken })
    expect(me.status).toBe(200)

    invitedUserToken = verifyRes.body.data.accessToken
    invitedUserRefresh = verifyRes.body.data.refreshToken
  })

  // ─── TOTP Recovery Code (from auth.e2e.test.ts S10) ───

  it("TOTP recovery code usage", async () => {
    const loginRes = await api(url, "/api/auth/login", {
      body: { email: "invited@e2e.test", password: "NewPassword1!" },
    })
    expect(loginRes.status).toBe(200)
    expect(loginRes.body.data.totpRequired).toBe(true)

    // Use first recovery code
    const verifyRes = await api(url, "/api/auth/totp/verify", {
      body: { challengeToken: loginRes.body.data.challengeToken, recoveryCode: recoveryCodes[0] },
    })
    expect(verifyRes.status).toBe(200)

    // Attempt recovery code reuse — should fail
    const loginRes2 = await api(url, "/api/auth/login", {
      body: { email: "invited@e2e.test", password: "NewPassword1!" },
    })
    const reuseRes = await api(url, "/api/auth/totp/verify", {
      body: {
        challengeToken: loginRes2.body.data.challengeToken,
        recoveryCode: recoveryCodes[0],
      },
    })
    expect(reuseRes.status).toBe(401)
  })

  // ─── Middleware (from middleware.e2e.test.ts S24) ───

  it("error envelope — 404", async () => {
    const res = await api(url, "/api/nonexistent")
    expect(res.status).toBe(404)
    expect(res.body.error).toBeDefined()
    expect(res.body.error.code).toBe("NOT_FOUND")
    expect(res.body.error.message).toBe("Not found")
  })

  it("error envelope — 401 missing auth", async () => {
    const res = await api(url, "/api/users/me")
    expect(res.status).toBe(401)
    expect(res.body.error).toBeDefined()
    expect(res.body.error.message).toContain("Unauthorized")
  })

  it("error envelope — 401 invalid token", async () => {
    const res = await api(url, "/api/admin/invites", { token: "bad-token", body: {} })
    expect(res.status).toBe(401)
    expect(res.body.error).toBeDefined()
    expect(res.body.error.message).toContain("Unauthorized")
  })

  it("error envelope — 403 insufficient scope", async () => {
    const user = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["test:items:read"],
      schemaPrefix: env.schemaPrefix,
    })
    const res = await api(url, "/api/admin/invites", { token: user.token, body: {} })
    expect(res.status).toBe(403)
  })

  it("error envelope — malformed JSON returns 400", async () => {
    const res = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid-json",
    })
    expect(res.status).toBe(400)
  })

  it("rate limiting — exceed per-org limit, get 429", async () => {
    // Flush existing rate limit counters
    await env.redis.flushKeys(`${env.redisPrefix}ratelimit:`)

    // Lower per-org rate limit for testing (org settings → synced to Redis, org-scoped key)
    const patchRes = await api(url, "/api/org", {
      method: "PATCH",
      token: world.admin.token,
      body: { settings: { rateLimitPerMinute: 10 } },
    })
    expect(patchRes.status).toBe(200)

    // Send rapid authenticated requests — per-org limiter applies after auth sets orgId
    const results: number[] = []
    for (let i = 0; i < 13; i++) {
      const res = await api(url, "/api/org", { token: world.admin.token })
      results.push(res.status)
    }
    expect(results).toContain(429)

    // Restore high rate limit and flush counters
    await api(url, "/api/org", {
      method: "PATCH",
      token: world.admin.token,
      body: { settings: { rateLimitPerMinute: 10000 } },
    })
    await env.redis.flushKeys(`${env.redisPrefix}ratelimit:`)
  })

  it("brute-force protection on login", async () => {
    // Use a stable IP via X-Forwarded-For so brute-force counters accumulate correctly
    const testIp = "192.168.50.2"
    const xff = { "X-Forwarded-For": `${testIp}, 10.0.0.1` }

    // Flush brute-force keys
    await env.redis.flushKeys(env.redisPrefix)

    // Send 5 failed login attempts (threshold is >= 5)
    for (let i = 0; i < 5; i++) {
      await api(url, "/api/auth/login", {
        body: { email: "admin@e2e.test", password: "wrong-password" },
        headers: xff,
      })
    }

    // 6th attempt should be blocked
    const blockedRes = await api(url, "/api/auth/login", {
      body: { email: "admin@e2e.test", password: "SecurePass1!" },
      headers: xff,
    })
    expect(blockedRes.status).toBe(429)
    expect(blockedRes.headers.get("retry-after")).toBeDefined()

    // Clear brute-force and retry
    await env.redis.flushKeys(env.redisPrefix)
    const okRes = await api(url, "/api/auth/login", {
      body: { email: "admin@e2e.test", password: "SecurePass1!" },
      headers: xff,
    })
    expect(okRes.status).toBe(200)
  })
})
