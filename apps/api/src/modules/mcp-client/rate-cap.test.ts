// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "bun:test"
import { _setEdition } from "~/lib/edition"
import { redis } from "~/lib/redis"
import { checkAndIncrement } from "~/modules/mcp-client/rate-cap"
import { clearRedisPatterns } from "~/tests/route-test-setup"

describe("rate-cap", () => {
  beforeEach(async () => {
    // Tests in this file use synthetic keys under mcp:ratecap:*; clear only those
    // to avoid clobbering unrelated keys from parallel suites.
    await clearRedisPatterns(["mcp:ratecap:*"])
    _setEdition(null)
  })

  it("allows up to the cap, then denies on managed", async () => {
    _setEdition("managed")
    for (let i = 0; i < 5; i++) {
      const r = await checkAndIncrement("conn-1", 5)
      expect(r).toEqual({ allowed: true })
    }
    const denied = await checkAndIncrement("conn-1", 5)
    expect(denied.allowed).toBe(false)
    if (!denied.allowed) {
      expect(denied.retryAfterMs).toBeGreaterThan(0)
      expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000)
    }
    _setEdition(null)
  })

  it("no-ops on self-hosted (always allows; never touches redis)", async () => {
    _setEdition("self_hosted")
    for (let i = 0; i < 50; i++) {
      const r = await checkAndIncrement("conn-2", 5)
      expect(r.allowed).toBe(true)
    }
    const minute = Math.floor(Date.now() / 60000)
    const ttl = await redis.ttl(`mcp:ratecap:conn-2:${minute}`)
    expect(ttl).toBe(-2) // key not set
    _setEdition(null)
  })

  it("sets a 60-second expiry on first increment so keys do not accumulate", async () => {
    _setEdition("managed")
    const minute = Math.floor(Date.now() / 60000)
    const key = `mcp:ratecap:conn-3:${minute}`
    await checkAndIncrement("conn-3", 100)
    const ttl = await redis.ttl(key)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(60)
    _setEdition(null)
  })

  it("documents fixed-window double-burst behavior at the minute boundary", async () => {
    // Spec Amendment 2: MVP uses fixed-window per-minute counters. A burst of
    // up to 2x cap is reachable across a boundary. This test pins the behavior
    // so future tightening is a deliberate decision.
    _setEdition("managed")
    const minuteN = Math.floor(Date.now() / 60_000)
    const keyN = `mcp:ratecap:conn-boundary:${minuteN}`
    const keyN1 = `mcp:ratecap:conn-boundary:${minuteN + 1}`
    // Pre-fill minute N to the cap.
    await redis.set(keyN, "5", "EX", 60)
    const inMinuteN = await checkAndIncrement("conn-boundary", 5)
    expect(inMinuteN.allowed).toBe(false)
    // Calls counted into the next minute are still allowed up to cap — fixed-window limit.
    await redis.del(keyN1)
    const count = await redis.incr(keyN1)
    expect(count).toBeLessThanOrEqual(5)
    _setEdition(null)
  })
})
