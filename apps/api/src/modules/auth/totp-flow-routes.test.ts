// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { __privileged_db__ as db } from "~/db/connection"
import { users } from "~/db/schema/kernel"
import { redis } from "~/lib/redis"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("TOTP full flow", () => {
  let adminToken: string
  let adminUserId: string

  beforeAll(async () => {
    await acquireTestLock()

    // Bootstrap admin
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "totp-admin@test.com",
        password: "testpass123",
        name: "Admin",
      }),
    })
    const body = (await res.json()) as any as any
    adminToken = body.data.accessToken

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, "totp-admin@test.com"))
      .limit(1)
    adminUserId = user.id
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("setup → confirm → login with TOTP → verify", async () => {
    // Step 1: Setup TOTP
    const setupRes = await app.request("/api/auth/totp/setup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ currentPassword: "testpass123" }),
    })
    expect(setupRes.status).toBe(200)
    const setupBody = (await setupRes.json()) as any
    expect(setupBody.data.secret).toBeDefined()
    expect(setupBody.data.otpauthUri).toBeDefined()
    expect(setupBody.data.recoveryCodes).toHaveLength(8)

    const secret = setupBody.data.secret
    const _recoveryCodes = setupBody.data.recoveryCodes

    // Step 2: Confirm TOTP with a valid code
    const { generateCurrentCode } = await import("~/modules/auth/totp")
    const code = generateCurrentCode(secret)

    const confirmRes = await app.request("/api/auth/totp/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ code }),
    })
    expect(confirmRes.status).toBe(200)

    // Step 3: Login now requires TOTP
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "totp-admin@test.com", password: "testpass123" }),
    })
    expect(loginRes.status).toBe(200)
    const loginBody = (await loginRes.json()) as any
    expect(loginBody.data.totpRequired).toBe(true)
    expect(loginBody.data.challengeToken).toBeDefined()

    // Step 4: Verify with TOTP code
    const verifyCode = generateCurrentCode(secret)
    const verifyRes = await app.request("/api/auth/totp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeToken: loginBody.data.challengeToken, code: verifyCode }),
    })
    expect(verifyRes.status).toBe(200)
    const verifyBody = (await verifyRes.json()) as any
    expect(verifyBody.data.accessToken).toBeDefined()
    // A browser caller (no app Origin) keeps its refresh token in the HttpOnly
    // liaison_rt cookie; only the shells' own origins get it in the body
    // (respondWithTokens, lib/response.ts refreshTokenDelivery, 81d09c7f6).
    const refreshCookie = verifyRes.headers
      .getSetCookie()
      .find((value) => value.startsWith("liaison_rt="))
    expect(refreshCookie).toBeDefined()
    expect(refreshCookie!.split(";")[0].length).toBeGreaterThan("liaison_rt=".length + 10)
    expect(refreshCookie).toContain("HttpOnly")
  })

  it("verify with recovery code works once then consumed", async () => {
    // Login to get challenge token
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "totp-admin@test.com", password: "testpass123" }),
    })
    const loginBody = (await loginRes.json()) as any
    const _challengeToken = loginBody.data.challengeToken

    // Get recovery codes from DB (they're hashed, so we need to fetch from setup)
    // We stored them during setup — use the first stored code
    // Actually, we need to get the unhashed codes from setup step.
    // Let's re-setup to get fresh codes
    const newSetupRes = await app.request("/api/auth/totp/setup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ currentPassword: "testpass123" }),
    })
    const newSetupBody = (await newSetupRes.json()) as any
    const secret = newSetupBody.data.secret
    const recoveryCodes = newSetupBody.data.recoveryCodes

    // Confirm with code
    const { generateCurrentCode } = await import("~/modules/auth/totp")
    const confirmRes = await app.request("/api/auth/totp/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ code: generateCurrentCode(secret) }),
    })
    expect(confirmRes.status).toBe(200)

    // Login again
    const login2Res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "totp-admin@test.com", password: "testpass123" }),
    })
    const login2Body = (await login2Res.json()) as any

    // Use first recovery code
    const recoveryRes = await app.request("/api/auth/totp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeToken: login2Body.data.challengeToken,
        recoveryCode: recoveryCodes[0],
      }),
    })
    expect(recoveryRes.status).toBe(200)

    // Login again and try same recovery code — should fail
    const login3Res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "totp-admin@test.com", password: "testpass123" }),
    })
    const login3Body = (await login3Res.json()) as any

    const reuse = await app.request("/api/auth/totp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeToken: login3Body.data.challengeToken,
        recoveryCode: recoveryCodes[0],
      }),
    })
    expect(reuse.status).toBe(401)
  })

  it("rate-limits TOTP verify attempts (brute-force protection)", async () => {
    // Login to get a challenge token
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "totp-admin@test.com", password: "testpass123" }),
    })
    const loginBody = (await loginRes.json()) as any
    const challengeToken = loginBody.data.challengeToken

    // Use a consistent IP so brute-force counters accumulate on the same key.
    // Without X-Forwarded-For, getClientIp generates a random UUID per request.
    const testIp = "192.168.99.1"

    // Clear any previous brute-force state for this user + IP
    await redis.del(`bruteforce:email:totp:${adminUserId}`)
    await redis.del(`bruteforce:ip:${testIp}`)

    // Make 5 attempts with wrong code (threshold is >= 5)
    for (let i = 0; i < 5; i++) {
      await app.request("/api/auth/totp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": `${testIp}, 10.0.0.1` },
        body: JSON.stringify({ challengeToken, code: "000000" }),
      })
    }

    // 6th attempt should be rate-limited
    const blockedRes = await app.request("/api/auth/totp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": `${testIp}, 10.0.0.1` },
      body: JSON.stringify({ challengeToken, code: "000000" }),
    })
    expect(blockedRes.status).toBe(429)
    expect(blockedRes.headers.get("Retry-After")).toBeDefined()

    // Clean up
    await redis.del(`bruteforce:email:totp:${adminUserId}`)
    await redis.del(`bruteforce:ip:${testIp}`)
  })

  it("rejects replayed TOTP code within the same time window", async () => {
    // Clear totpLastUsedAt from previous tests to avoid false replay detection
    await db
      .update(users)
      .set({ totpLastUsedAt: null })
      .where(eq(users.email, "totp-admin@test.com"))

    // Login to get a challenge token
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "totp-admin@test.com", password: "testpass123" }),
    })
    const loginBody = (await loginRes.json()) as any
    const challengeToken1 = loginBody.data.challengeToken

    // Get a valid TOTP code
    const { generateCurrentCode } = await import("~/modules/auth/totp")
    // Fetch the current secret from DB
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, "totp-admin@test.com"))
      .limit(1)
    const { CryptoContext, decryptSecret } = await import("~/lib/crypto")
    const { encryptionKey } = await import("~/lib/env")
    const secret = decryptSecret(user.totpSecret!, encryptionKey, CryptoContext.totpSecret)
    const code = generateCurrentCode(secret)

    // First verify should succeed
    const verify1 = await app.request("/api/auth/totp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeToken: challengeToken1, code }),
    })
    expect(verify1.status).toBe(200)

    // Login again for a fresh challenge token
    const login2Res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "totp-admin@test.com", password: "testpass123" }),
    })
    const login2Body = (await login2Res.json()) as any
    const challengeToken2 = login2Body.data.challengeToken

    // Same code, second verify — should be rejected as replay
    const verify2 = await app.request("/api/auth/totp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeToken: challengeToken2, code }),
    })
    expect(verify2.status).toBe(401)

    // Clean up brute-force counters
    await redis.del(`bruteforce:email:totp:${adminUserId}`)
    await redis.del("bruteforce:ip:unknown")
  })

  it("rejects regular access token as challenge token", async () => {
    const verifyRes = await app.request("/api/auth/totp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeToken: adminToken, code: "123456" }),
    })
    expect(verifyRes.status).toBe(401)
  })

  it("TOTP setup with reset=true aborts in-progress setup and returns fresh recovery codes", async () => {
    const authHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    }
    // First setup call — starts setup
    await app.request("/api/auth/totp/setup", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ currentPassword: "testpass123" }),
    })
    // Reset=true — should clear existing setup and return fresh codes
    const res = await app.request("/api/auth/totp/setup?reset=true", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ currentPassword: "testpass123" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.recoveryCodes).toBeDefined()
    expect(body.data.recoveryCodes.length).toBeGreaterThan(0)
  })

  it("malformed TOTP verify (no code, no recoveryCode) returns 400", async () => {
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "totp-admin@test.com", password: "testpass123" }),
    })
    const loginBody = (await loginRes.json()) as any
    const res = await app.request("/api/auth/totp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeToken: loginBody.data.challengeToken }),
    })
    expect(res.status).toBe(400)
  })
})
