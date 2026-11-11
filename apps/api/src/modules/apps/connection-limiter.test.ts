// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shared per-connection limiter (connection-limiter.ts) on the real Redis:
// a concurrency gate, a token bucket and a pause that hold for every caller of
// one key, a bounded wait that fails typed, and fail-open when Redis fails.
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { redis } from "~/lib/redis"
import {
  acquireConnectionPermit,
  ConnectionLimiterTestAccess,
  ConnectionRateLimitedError,
  pauseConnection,
  retryAfterPauseMs,
} from "./connection-limiter"
import { connectionLimitsErrors, declaredConnectionLimits } from "./connection-limits"

let n = 0
const used: ReturnType<typeof ConnectionLimiterTestAccess.keysOf>[] = []
function freshKey(identifier = "acct-1") {
  const key = {
    orgId: `00000000-0000-4000-8000-${String(Date.now() % 1e9).padStart(9, "0")}${String(++n).padStart(3, "0")}`,
    app: "limtest",
    connection: "provider",
    identifier,
  }
  used.push(ConnectionLimiterTestAccess.keysOf(key))
  return key
}

afterEach(async () => {
  for (const k of used.splice(0)) await redis.del(k.leases, k.bucket, k.pause)
  ConnectionLimiterTestAccess.setRedis(null)
})
afterAll(() => ConnectionLimiterTestAccess.setRedis(null))

describe("connection limiter", () => {
  it("a concurrency gate admits N at once; the next waits for a release", async () => {
    const key = freshKey()
    const limits = { concurrency: 2 }
    const r1 = await acquireConnectionPermit(key, limits, { maxWaitMs: 100 })
    const r2 = await acquireConnectionPermit(key, limits, { maxWaitMs: 100 })
    const started = Date.now()
    const third = acquireConnectionPermit(key, limits, { maxWaitMs: 2_000 })
    setTimeout(() => void r1(), 150)
    const r3 = await third
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    await r2()
    await r3()
    // Releasing twice frees one slot only.
    await r3()
    expect(await redis.zcard(ConnectionLimiterTestAccess.keysOf(key).leases)).toBe(0)
  })

  it("a full gate past the bound fails typed (429, provider_rate_limited)", async () => {
    const key = freshKey()
    const release = await acquireConnectionPermit(key, { concurrency: 1 }, { maxWaitMs: 50 })
    const err = await acquireConnectionPermit(key, { concurrency: 1 }, { maxWaitMs: 120 }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ConnectionRateLimitedError)
    expect((err as ConnectionRateLimitedError).status).toBe(429)
    expect((err as ConnectionRateLimitedError).code).toBe("provider_rate_limited")
    await release()
  })

  it("the gate is per account: another identifier is not held back", async () => {
    const a = freshKey("acct-a")
    const b = { ...a, identifier: "acct-b" }
    used.push(ConnectionLimiterTestAccess.keysOf(b))
    const ra = await acquireConnectionPermit(a, { concurrency: 1 }, { maxWaitMs: 50 })
    const rb = await acquireConnectionPermit(b, { concurrency: 1 }, { maxWaitMs: 50 })
    await ra()
    await rb()
  })

  it("a token bucket spaces calls at perSecond once the burst is spent", async () => {
    const key = freshKey()
    const limits = { perSecond: 10, burst: 2 }
    const started = Date.now()
    for (let i = 0; i < 4; i++) {
      const release = await acquireConnectionPermit(key, limits, { maxWaitMs: 2_000 })
      await release()
    }
    // Two from the burst, then two more at 100 ms each.
    expect(Date.now() - started).toBeGreaterThanOrEqual(180)
  })

  it("a bucket wait longer than the bound fails at once rather than sleeping", async () => {
    const key = freshKey()
    const limits = { perSecond: 1, burst: 1 }
    await (await acquireConnectionPermit(key, limits, { maxWaitMs: 50 }))()
    const started = Date.now()
    const err = await acquireConnectionPermit(key, limits, { maxWaitMs: 200 }).catch((e) => e)
    expect(err).toBeInstanceOf(ConnectionRateLimitedError)
    expect(Date.now() - started).toBeLessThan(150)
  })

  it("a pause holds every caller of the key, is capped, and never shortens", async () => {
    const key = freshKey()
    expect(await pauseConnection(key, 300)).toBe(300)
    // A shorter pause leaves the longer one in force.
    expect(await pauseConnection(key, 10)).toBeGreaterThan(200)
    const started = Date.now()
    const release = await acquireConnectionPermit(key, {}, { maxWaitMs: 2_000 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    await release()
    expect(await pauseConnection(freshKey(), 10 * 60_000)).toBe(60_000)
  })

  it("fails open when Redis fails or does not answer", async () => {
    const key = freshKey()
    ConnectionLimiterTestAccess.setRedis({
      eval: () => Promise.reject(new Error("redis down")),
      zrem: () => Promise.reject(new Error("redis down")),
    } as never)
    const r1 = await acquireConnectionPermit(key, { concurrency: 1 }, { maxWaitMs: 50 })
    const r2 = await acquireConnectionPermit(key, { concurrency: 1 }, { maxWaitMs: 50 })
    await r1()
    await r2()
    expect(await pauseConnection(key, 1_000)).toBeNull()
    ConnectionLimiterTestAccess.setRedis({
      eval: () => new Promise(() => {}),
      zrem: () => new Promise(() => {}),
    } as never)
    const started = Date.now()
    await (await acquireConnectionPermit(key, { concurrency: 1 }, { maxWaitMs: 50 }))()
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("validates declared limits", () => {
    expect(connectionLimitsErrors({ concurrency: 4 })).toEqual([])
    expect(connectionLimitsErrors({ perSecond: 2, burst: 40 })).toEqual([])
    expect(connectionLimitsErrors({})).not.toEqual([])
    expect(connectionLimitsErrors({ concurrency: 0 })).not.toEqual([])
    expect(connectionLimitsErrors({ concurrency: 1.5 })).not.toEqual([])
    expect(connectionLimitsErrors({ burst: 3 })).not.toEqual([])
    expect(connectionLimitsErrors({ concurrency: 2, rps: 3 })).not.toEqual([])
    expect(
      declaredConnectionLimits({ connections: { c: { limits: { concurrency: 3 } } } }, "c"),
    ).toEqual({ concurrency: 3 })
    expect(declaredConnectionLimits({ connections: { c: {} } }, "c")).toBeNull()
  })

  it("reads Retry-After from a 429 or 503 only", () => {
    const h = (v: string | null) => ({ get: () => v })
    expect(retryAfterPauseMs(429, h("2"))).toBe(2_000)
    expect(retryAfterPauseMs(503, h("0.5"))).toBe(500)
    expect(retryAfterPauseMs(200, h("2"))).toBeNull()
    expect(retryAfterPauseMs(429, h(null))).toBeNull()
    const now = Date.parse("2026-01-01T00:00:00Z")
    expect(retryAfterPauseMs(429, h("Thu, 01 Jan 2026 00:00:03 GMT"), now)).toBe(3_000)
  })
})
