// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { eq, isNull } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { passwordResets } from "~/db/schema/kernel"
import type { EmailProvider } from "~/infra/email"
import { ConsoleEmailProvider, getEmailProvider, setEmailProvider } from "~/infra/email"
import { hashToken } from "~/lib/crypto"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

describe("password reset flow", () => {
  let _adminToken: string

  beforeAll(async () => {
    await acquireTestLock()

    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "reset@test.com", password: "testpass123", name: "Admin" }),
    })
    const body = (await res.json()) as any as any
    _adminToken = body.data.accessToken
  })

  // Isolate each test from the reset throttles: the per-IP cap (5 requests/hour,
  // keyed on the shared "unknown-ip" bucket since app.request sets no socket IP)
  // and the per-email/per-IP brute-force counters are otherwise a single budget
  // spent across the whole file, making the suite brittle to how many requests
  // earlier tests happened to make. Clearing them per test removes that coupling.
  beforeEach(async () => {
    // Through the prefix-aware helper: under a namespaced test run a bare
    // `redis.keys("reset-rate:*")` matches nothing, the 5-per-hour per-IP cap
    // is never reset, and the sixth request in the file answers 429 without
    // ever invalidating the token the test is about to replay.
    await clearRedisPatterns(["reset-rate:*", "bruteforce:*"])
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("request always returns 200 (no enumeration)", async () => {
    const res = await app.request("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nonexistent@test.com" }),
    })
    expect(res.status).toBe(200)
  })

  it("request for existing user returns 200", async () => {
    const res = await app.request("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "reset@test.com" }),
    })
    expect(res.status).toBe(200)
  })

  it("reset email links to the set-password page and is Liaison-branded", async () => {
    // Capture the outbound email instead of sending it.
    const prev: EmailProvider = getEmailProvider()
    const capture = new ConsoleEmailProvider()
    setEmailProvider(capture)
    try {
      const res = await app.request("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "reset@test.com" }),
      })
      expect(res.status).toBe(200)

      const sent = capture.sent.at(-1)
      expect(sent).toBeDefined()
      if (!sent) throw new Error("no email captured")

      // The link must point at the CONFIRM (set-new-password) page, not the
      // request page -- this was the reset-link bug.
      expect(sent.html).toContain("/reset-password/confirm?token=")
      expect(sent.text).toContain("/reset-password/confirm?token=")
      expect(sent.html).not.toContain("/reset-password?token=")

      // ...and it must be the branded layout, not bare <p> tags.
      expect(sent.html).toStartWith("<!doctype html>")
      expect(sent.html).toContain(">Liaison<")
      expect(sent.html).toContain('class="cta"')
    } finally {
      setEmailProvider(prev)
    }
  })

  it("confirm with valid token resets password", async () => {
    // Request reset
    await app.request("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "reset@test.com" }),
    })

    // Get the latest unused token from DB (in real system this would be emailed)
    const resets = await db
      .select()
      .from(passwordResets)
      .where(isNull(passwordResets.usedAt))
      .limit(1)
    expect(resets.length).toBeGreaterThan(0)

    // We need the raw token — but we only have the hash.
    // For testing, insert a known token directly.
    const { generateToken } = await import("~/lib/crypto")
    const token = generateToken()
    const tokenHash = hashToken(token)
    await db.update(passwordResets).set({ tokenHash }).where(eq(passwordResets.id, resets[0].id))

    const confirmRes = await app.request("/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: "newpass12345" }),
    })
    expect(confirmRes.status).toBe(200)

    // Login with new password
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "reset@test.com", password: "newpass12345" }),
    })
    expect(loginRes.status).toBe(200)

    // Old password no longer works
    const oldRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "reset@test.com", password: "testpass123" }),
    })
    expect(oldRes.status).toBe(401)
  })

  it("requesting a new token invalidates the previous one", async () => {
    // Request token A
    await app.request("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "reset@test.com" }),
    })

    // Grab token A's row and replace with known token
    const { generateToken } = await import("~/lib/crypto")
    const tokenA = generateToken()
    const tokenAHash = hashToken(tokenA)
    const [rowA] = await db
      .select()
      .from(passwordResets)
      .where(isNull(passwordResets.usedAt))
      .limit(1)
    await db
      .update(passwordResets)
      .set({ tokenHash: tokenAHash })
      .where(eq(passwordResets.id, rowA.id))

    // Request token B (should invalidate A)
    await app.request("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "reset@test.com" }),
    })

    // Token A should now be rejected (marked used by the second request)
    const res = await app.request("/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokenA, newPassword: "shouldfail123" }),
    })
    expect(res.status).toBe(400)
  })

  it("confirm with fabricated token is rejected", async () => {
    const fabricatedToken = "totally-made-up-token-that-was-never-issued-aabbccdd1234"
    const res = await app.request("/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: fabricatedToken, newPassword: "doesntmatter" }),
    })
    expect(res.status).toBe(400)
  })

  it("confirm with used token is rejected", async () => {
    const { generateToken } = await import("~/lib/crypto")
    const token = generateToken()
    const tokenHash = hashToken(token)

    // Insert a used reset
    const users =
      await sql`SELECT id, org_id FROM kernel.users WHERE email = 'reset@test.com' LIMIT 1`
    await db.insert(passwordResets).values({
      userId: users[0].id,
      orgId: users[0].org_id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      usedAt: new Date(),
    })

    const res = await app.request("/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: "doesntmatter" }),
    })
    expect(res.status).toBe(400)
  })

  it("confirm with expired token is rejected", async () => {
    const { generateToken } = await import("~/lib/crypto")
    const token = generateToken()
    const tokenHash = hashToken(token)

    const users =
      await sql`SELECT id, org_id FROM kernel.users WHERE email = 'reset@test.com' LIMIT 1`
    await db.insert(passwordResets).values({
      userId: users[0].id,
      orgId: users[0].org_id,
      tokenHash,
      expiresAt: new Date(Date.now() - 1000), // Expired
    })

    const res = await app.request("/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: "doesntmatter" }),
    })
    expect(res.status).toBe(400)
  })

  it("all sessions invalidated after password reset", async () => {
    // Login to get session
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "reset@test.com", password: "newpass12345" }),
    })
    expect(loginRes.status).toBe(200)
    const loginBody = (await loginRes.json()) as any
    // The refresh token rides in the body here only because the test env keeps
    // EXPOSE_REFRESH_TOKEN_IN_BODY on; assert we really hold one, so a delivery
    // change turns this into a named failure rather than a refresh of nothing
    // that answers 401 for the wrong reason.
    const refreshToken = loginBody.data.refreshToken
    expect(typeof refreshToken).toBe("string")

    // Perform password reset
    const { generateToken } = await import("~/lib/crypto")
    const token = generateToken()
    const tokenHash = hashToken(token)

    const users =
      await sql`SELECT id, org_id FROM kernel.users WHERE email = 'reset@test.com' LIMIT 1`
    await db.insert(passwordResets).values({
      userId: users[0].id,
      orgId: users[0].org_id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })

    await app.request("/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: "yetanotherpass" }),
    })

    // Old refresh token should be invalid
    const refreshRes = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    })
    expect(refreshRes.status).toBe(401)
  })

  // ---- reset targets a unique, active account -------------------------------
  describe("reset resolves a unique, active account", () => {
    const ORG_X = "00000000-0000-0000-0000-a7000000000a"
    const ORG_Y = "00000000-0000-0000-0000-a7000000000b"
    const emailOf = "shared-reset@test.com"
    const send = async (body: Record<string, unknown>) => {
      const prev: EmailProvider = getEmailProvider()
      const capture = new ConsoleEmailProvider()
      setEmailProvider(capture)
      try {
        const res = await app.request("/api/auth/password-reset/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        return { status: res.status, sent: capture.sent.length }
      } finally {
        setEmailProvider(prev)
      }
    }

    beforeAll(async () => {
      for (const [id, slug] of [
        [ORG_X, "a7-org-x"],
        [ORG_Y, "a7-org-y"],
      ]) {
        await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${id}, ${slug}, ${slug}) ON CONFLICT (id) DO NOTHING`
        await sql`INSERT INTO kernel.users (org_id, email, name, status) VALUES (${id}, ${emailOf}, 'Shared', 'active') ON CONFLICT DO NOTHING`
      }
      await sql`INSERT INTO kernel.users (org_id, email, name, status) VALUES (${ORG_X}, 'deactivated-reset@test.com', 'Gone', 'deactivated') ON CONFLICT DO NOTHING`
    })

    afterAll(async () => {
      await sql`DELETE FROM kernel.password_resets WHERE org_id IN (${ORG_X}, ${ORG_Y})`
      await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG_X}, ${ORG_Y})`
      await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_X}, ${ORG_Y})`
    })

    it("an email present in two orgs sends nothing without an orgSlug, and answers uniformly", async () => {
      const r = await send({ email: emailOf })
      expect(r).toEqual({ status: 200, sent: 0 })
    })

    it("an orgSlug picks the right account", async () => {
      const r = await send({ email: emailOf, orgSlug: "a7-org-y" })
      expect(r).toEqual({ status: 200, sent: 1 })
      const rows =
        await sql`SELECT org_id FROM kernel.password_resets WHERE org_id IN (${ORG_X}, ${ORG_Y})`
      expect(rows.map((x) => x.org_id)).toEqual([ORG_Y])
    })

    it("a deactivated account gets no reset", async () => {
      const r = await send({ email: "deactivated-reset@test.com" })
      expect(r).toEqual({ status: 200, sent: 0 })
    })

    it("a token issued before deactivation cannot set a password", async () => {
      const { generateToken } = await import("~/lib/crypto")
      const token = generateToken()
      const [gone] =
        await sql`SELECT id FROM kernel.users WHERE email = 'deactivated-reset@test.com' AND org_id = ${ORG_X}`
      await sql`INSERT INTO kernel.password_resets (user_id, org_id, token_hash, expires_at)
        VALUES (${gone.id}, ${ORG_X}, ${hashToken(token)}, NOW() + INTERVAL '1 hour')`
      const res = await app.request("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: "newpass12345" }),
      })
      expect(res.status).toBe(400)
      const [after] = await sql`SELECT password_hash FROM kernel.users WHERE id = ${gone.id}`
      expect(after.password_hash).toBeNull()
    })
  })
})
