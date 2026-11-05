// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { redis } from "~/lib/redis"
import { checkBruteForce, recordFailedAttempt, resetAttempts } from "~/middleware/brute-force"
import { clearRedisPatterns } from "~/tests/route-test-setup"

describe("brute-force protection", () => {
  const email = "test-brute@test.com"
  const ip = "192.168.1.1"

  beforeEach(async () => {
    await clearRedisPatterns(["bruteforce:*"])
  })

  afterAll(async () => {
    await clearRedisPatterns(["bruteforce:*"])
  })

  it("checkBruteForce does NOT increment counters (read-only)", async () => {
    const result = await checkBruteForce(redis, email, ip)
    expect(result.allowed).toBe(true)

    // Counter should still be 0 (no key created)
    const emailCount = await redis.get(`bruteforce:email:${email}`)
    expect(emailCount).toBeNull()
  })

  it("recordFailedAttempt increments counters", async () => {
    await recordFailedAttempt(redis, email, ip)
    const emailCount = await redis.get(`bruteforce:email:${email}`)
    expect(Number(emailCount)).toBe(1)
    const ipCount = await redis.get(`bruteforce:ip:${ip}`)
    expect(Number(ipCount)).toBe(1)
  })

  it("blocks after MAX_EMAIL_ATTEMPTS failed attempts from same IP", async () => {
    for (let i = 0; i < 5; i++) {
      await recordFailedAttempt(redis, email, ip)
    }
    const result = await checkBruteForce(redis, email, ip)
    expect(result.allowed).toBe(false)
    expect(result.retryAfter).toBeGreaterThan(0)
  })

  it("does NOT block when email limit exceeded but IP is clean (anti-lockout)", async () => {
    const attackerIp = "10.0.0.99"
    const victimIp = "10.0.0.1"
    const victimEmail = "victim@test.com"

    // Attacker sends 6 failures from their IP
    for (let i = 0; i < 6; i++) {
      await recordFailedAttempt(redis, victimEmail, attackerIp)
    }

    // Legitimate user from a different IP should still get through
    const result = await checkBruteForce(redis, victimEmail, victimIp)
    expect(result.allowed).toBe(true)
  })

  it("blocks when per-IP limit exceeded regardless of email", async () => {
    const bruteIp = "10.0.0.50"

    // Burn through IP limit with various emails
    for (let i = 0; i < 21; i++) {
      await recordFailedAttempt(redis, `brute-${i}@test.com`, bruteIp)
    }

    // Next attempt from this IP with a fresh email should still be blocked
    const freshEmail = "fresh-target@test.com"
    const result = await checkBruteForce(redis, freshEmail, bruteIp)
    expect(result.allowed).toBe(false)
    expect(result.retryAfter).toBeGreaterThan(0)
  })

  it("boundary: N-1 attempts allowed, Nth blocked (>= threshold)", async () => {
    const boundEmail = `boundary-${Date.now()}@test.com`
    const boundIp = `192.168.20.${Math.floor(Math.random() * 250) + 1}`

    // MAX_EMAIL_ATTEMPTS=5, threshold is >= 5
    // 4 failures → still allowed
    for (let i = 0; i < 4; i++) {
      await recordFailedAttempt(redis, boundEmail, boundIp)
    }
    const r1 = await checkBruteForce(redis, boundEmail, boundIp)
    expect(r1.allowed).toBe(true)

    // 5th failure → now blocked (5 >= 5)
    await recordFailedAttempt(redis, boundEmail, boundIp)
    const r2 = await checkBruteForce(redis, boundEmail, boundIp)
    expect(r2.allowed).toBe(false)
    expect(r2.retryAfter).toBeGreaterThan(0)
  })

  it("blocked retryAfter reports the key's remaining TTL, not a fictitious backoff", async () => {
    const ttlEmail = `retry-ttl-${Date.now()}@test.com`
    const ttlIp = `192.168.30.${Math.floor(Math.random() * 250) + 1}`

    // Reach exactly the email threshold (5) from the same IP so the block fires.
    for (let i = 0; i < 5; i++) {
      await recordFailedAttempt(redis, ttlEmail, ttlIp)
    }
    const result = await checkBruteForce(redis, ttlEmail, ttlIp)
    expect(result.allowed).toBe(false)

    // The block persists until the counter key EXPIRES (the counter never
    // decays), so the honest Retry-After is the key TTL (~3600s window here),
    // never the old 2^(count - max) formula which claimed 1 second at the
    // first block while the user stayed locked out for up to an hour.
    const keyTtl = await redis.ttl(`bruteforce:email:${ttlEmail}`)
    expect(result.retryAfter).toBeGreaterThan(60)
    expect(result.retryAfter).toBeLessThanOrEqual(3600)
    // Same clock, read moments apart — allow a small skew.
    expect(Math.abs((result.retryAfter ?? 0) - keyTtl)).toBeLessThanOrEqual(5)
  })

  it("resetAttempts clears BOTH email AND IP counters", async () => {
    for (let i = 0; i < 3; i++) {
      await recordFailedAttempt(redis, email, ip)
    }

    await resetAttempts(redis, email, ip)

    const emailCount = await redis.get(`bruteforce:email:${email}`)
    const ipCount = await redis.get(`bruteforce:ip:${ip}`)
    expect(emailCount).toBeNull()
    expect(ipCount).toBeNull()
  })

  it("counter keys have positive TTL after recording failed attempt", async () => {
    const ttlEmail = `ttl-test-${Date.now()}@test.com`
    const ttlIp = `192.168.99.${Math.floor(Math.random() * 250) + 1}`
    await recordFailedAttempt(redis, ttlEmail, ttlIp)

    const emailTtl = await redis.ttl(`bruteforce:email:${ttlEmail}`)
    const ipTtl = await redis.ttl(`bruteforce:ip:${ttlIp}`)

    // TTL should be positive (key exists with expiry) — 3600s window
    expect(emailTtl).toBeGreaterThan(0)
    expect(ipTtl).toBeGreaterThan(0)
    // TTL should not exceed the configured window (3600s)
    expect(emailTtl).toBeLessThanOrEqual(3600)
    expect(ipTtl).toBeLessThanOrEqual(3600)
  })

  it("resets counter on success: verifies blocking then unblocking", async () => {
    const resetEmail = "reset-flow@test.com"
    const resetIp = "192.168.10.1"

    // Exhaust limits to trigger a block
    for (let i = 0; i < 6; i++) {
      await recordFailedAttempt(redis, resetEmail, resetIp)
    }
    const blocked = await checkBruteForce(redis, resetEmail, resetIp)
    expect(blocked.allowed).toBe(false)

    // Reset both counters
    await resetAttempts(redis, resetEmail, resetIp)

    const unblocked = await checkBruteForce(redis, resetEmail, resetIp)
    expect(unblocked.allowed).toBe(true)
  })

  it("retryAfter stays the honest time-to-expiry even as failures accumulate", async () => {
    // The counter never decays, so the block lasts until the key expires:
    // retryAfter is the remaining TTL, and MORE failures must not inflate it
    // beyond the window (the old exponential formula both under-reported at
    // the first block, claiming 1 second, and over-reported after many).
    const email2 = "test-exp@test.com"
    const ip2 = "192.168.2.1"

    for (let i = 0; i < 6; i++) await recordFailedAttempt(redis, email2, ip2)
    const r1 = await checkBruteForce(redis, email2, ip2)
    expect(r1.allowed).toBe(false)
    expect(r1.retryAfter!).toBeGreaterThan(0)
    expect(r1.retryAfter!).toBeLessThanOrEqual(3600)

    for (let i = 0; i < 5; i++) await recordFailedAttempt(redis, email2, ip2)
    const r2 = await checkBruteForce(redis, email2, ip2)
    expect(r2.allowed).toBe(false)
    // Still bounded by the same window; TTL only counts DOWN.
    expect(r2.retryAfter!).toBeLessThanOrEqual(r1.retryAfter!)
    expect(r2.retryAfter!).toBeGreaterThan(0)
  })

  it("retryAfter never exceeds the counter window (3600s)", async () => {
    const email3 = "test-cap@test.com"
    const ip3 = "192.168.3.1"

    for (let i = 0; i < 20; i++) await recordFailedAttempt(redis, email3, ip3)
    const result = await checkBruteForce(redis, email3, ip3)
    expect(result.retryAfter).toBeGreaterThan(0)
    expect(result.retryAfter).toBeLessThanOrEqual(3600)
  })

  it("successful login from different IP does not lock out legitimate user", async () => {
    // Attacker sends 6 attempts from different IP
    for (let i = 0; i < 6; i++) {
      await recordFailedAttempt(redis, "victim@example.com", "attacker-ip")
    }

    // Legitimate user from their own IP — should still be allowed
    const result = await checkBruteForce(redis, "victim@example.com", "legit-ip")
    expect(result.allowed).toBe(true)
  })
})
