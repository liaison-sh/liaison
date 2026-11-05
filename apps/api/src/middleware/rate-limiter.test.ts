// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { Hono } from "hono"
import type Redis from "ioredis"
import type { AppEnv } from "~/app"
import { rootLogger } from "~/lib/logger"
import { REDIS_PREFIX, redis } from "~/lib/redis"
import { errorHandler } from "~/middleware/error-handler"
import {
  bucketKey,
  checkRateLimit,
  orgRateLimiter,
  RATE_LIMIT_DEFAULT,
  RATE_LIMIT_PER_USER,
  rateLimiter,
  userRateLimiter,
} from "~/middleware/rate-limiter"
import { clearRedisPatterns } from "~/tests/route-test-setup"

/**
 * A rate-limit bucket's key as the `redis` client names it. `bucketKey` is the
 * RAW key: the Lua script receives it through ARGV, so it carries REDIS_PREFIX
 * itself. The `redis` client prepends REDIS_PREFIX again through its keyPrefix,
 * so a test that reads or seeds the bucket through it passes the key minus that
 * prefix (under a namespaced run the prefix is never empty).
 */
function clientBucketKey(identifier: string, windowSeconds: number): string {
  return bucketKey(identifier, windowSeconds).slice(REDIS_PREFIX.length)
}

describe("rate limiter", () => {
  afterAll(async () => {
    await clearRedisPatterns(["ratelimit:test:*"])
  })

  it("allows requests under the limit", async () => {
    const result = await checkRateLimit(redis, "test:user1", RATE_LIMIT_DEFAULT)
    expect(result.allowed).toBe(true)
    if (result.allowed) expect(result.remaining[0]).toBeGreaterThan(0)
  })

  it("rejects requests over the limit", async () => {
    const key = `test:overlimit:${Date.now()}`
    for (let i = 0; i < 3; i++) {
      await checkRateLimit(redis, key, 3)
    }
    const result = await checkRateLimit(redis, key, 3)
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.failed.retryAfterSeconds).toBeGreaterThan(0)
  })

  it("boundary: exactly N requests allowed, N+1 rejected", async () => {
    const limit = 3
    const key = `test:boundary:${Date.now()}`
    for (let i = 0; i < limit; i++) {
      const r = await checkRateLimit(redis, key, limit)
      expect(r.allowed).toBe(true)
    }
    const r = await checkRateLimit(redis, key, limit)
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.failed.retryAfterSeconds).toBeGreaterThan(0)
  })
})

describe("multi-bucket checkRateLimit", () => {
  afterAll(async () => {
    await clearRedisPatterns(["ratelimit:test-mb:*"])
  })

  it("short-circuits on first failing bucket without incrementing later buckets", async () => {
    const ip = `test-mb:ip:${Date.now()}`
    const org = `test-mb:org:${Date.now()}`
    const r1 = await checkRateLimit(redis, [
      { identifier: ip, limit: 1, windowSeconds: 60 },
      { identifier: org, limit: 100, windowSeconds: 3600 },
    ])
    expect(r1.allowed).toBe(true)
    const r2 = await checkRateLimit(redis, [
      { identifier: ip, limit: 1, windowSeconds: 60 },
      { identifier: org, limit: 100, windowSeconds: 3600 },
    ])
    expect(r2.allowed).toBe(false)
    if (!r2.allowed) expect(r2.failed.identifier).toBe(ip)
    const orgCount = await redis.zcard(`ratelimit:${org}:3600`)
    expect(orgCount).toBe(1)
  })

  it("computes retryAfterSeconds from oldest entry + window", async () => {
    const k = `test-mb:retry:${Date.now()}`
    await redis.zadd(`ratelimit:${k}:60`, Date.now() - 10_000, `seed:${crypto.randomUUID()}`)
    const r = await checkRateLimit(redis, [{ identifier: k, limit: 1, windowSeconds: 60 }])
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.failed.retryAfterSeconds).toBeGreaterThanOrEqual(40)
  })

  it("single-bucket call mode preserves wrapper back-compat", async () => {
    const k = `test-mb:single:${Date.now()}`
    const r = await checkRateLimit(redis, [{ identifier: k, limit: 5, windowSeconds: 60 }])
    expect(r.allowed).toBe(true)
    if (r.allowed) expect(r.remaining[0]).toBe(4)
  })

  it("throws on empty bucket array", async () => {
    await expect(checkRateLimit(redis, [])).rejects.toThrow(/no buckets/)
  })
})

describe("rateLimiter middleware", () => {
  afterAll(async () => {
    await clearRedisPatterns(["ratelimit:test:mw:*"])
  })

  it("returns 429 with Retry-After when limit exceeded", async () => {
    const app = new Hono()
    app.onError(errorHandler)
    app.use(
      "/*",
      rateLimiter(redis, () => 2),
    )
    app.get("/test", (c) => c.text("ok"))

    const ip = `test:mw:${Date.now()}`
    const headers = { "x-forwarded-for": `${ip}, proxy` }

    const r1 = await app.request("/test", { headers })
    expect(r1.status).toBe(200)
    const r2 = await app.request("/test", { headers })
    expect(r2.status).toBe(200)

    const r3 = await app.request("/test", { headers })
    expect(r3.status).toBe(429)
    expect(r3.headers.get("Retry-After")).toBeTruthy()
  })

  it("keys on the x-forwarded-for entry the trusted proxy appended, never a client-supplied one", async () => {
    // TRUSTED_PROXY_HOPS=1 (.env.test): the one proxy appends the peer it saw, so
    // the real client is the rightmost entry and anything to its left is
    // whatever the client typed.
    const app = new Hono()
    app.onError(errorHandler)
    app.use(
      "/*",
      rateLimiter(redis, () => 1),
    )
    app.get("/test", (c) => c.text("ok"))

    const spoofed = `test:mw:spoofed:${Date.now()}`
    const clientIp = `test:mw:client:${Date.now()}`
    const headers = { "x-forwarded-for": `${spoofed}, ${clientIp}` }

    const r1 = await app.request("/test", { headers })
    expect(r1.status).toBe(200)

    const r2 = await app.request("/test", { headers })
    expect(r2.status).toBe(429)

    // Same client-typed prefix, different real client: its own bucket.
    const differentClient = `test:mw:different:${Date.now()}`
    const r3 = await app.request("/test", {
      headers: { "x-forwarded-for": `${spoofed}, ${differentClient}` },
    })
    expect(r3.status).toBe(200)
  })

  it("always enforces rate limiting regardless of NODE_ENV", async () => {
    process.env.NODE_ENV = "test"
    const app = new Hono()
    app.onError(errorHandler)
    app.use(
      "/*",
      rateLimiter(redis, () => 1),
    )
    app.get("/test", (c) => c.text("ok"))

    const ip = `test:mw:alwaysenforce:${Date.now()}`
    const r1 = await app.request("/test", { headers: { "x-forwarded-for": ip } })
    expect(r1.status).toBe(200)
    const r2 = await app.request("/test", { headers: { "x-forwarded-for": ip } })
    expect(r2.status).toBe(429)

    // Restore the suite NODE_ENV. `bun test` runs the whole suite in one
    // process, so leaving this as "production" leaked into every later test
    // file's shared process.env — notably the phase13 CLI smoke, which spawns
    // the real CLI with `{ ...process.env }` and would then trip the
    // production config guard (EXPOSE_REFRESH_TOKEN_IN_BODY) and exit 1.
    process.env.NODE_ENV = "test"
  })
})

describe("rate limit defaults", () => {
  // One web-app page load is 26-40 API calls and the whole office shares one
  // egress address, so the pre-auth per-IP ceiling cannot be 300: a handful of
  // colleagues navigating at once 429 together.
  it("pre-auth per-IP default is 1200 per minute", () => {
    expect(RATE_LIMIT_DEFAULT).toBe(1200)
  })

  it("post-auth per-user default is 600 per minute", () => {
    expect(RATE_LIMIT_PER_USER).toBe(600)
  })
})

describe("userRateLimiter middleware", () => {
  // The limiter is off under NODE_ENV=test, like the IP limiter; this is the
  // knob that turns it back on so the behaviour is actually exercised.
  beforeAll(() => {
    process.env.RATE_LIMIT_FORCE_ENABLED = "1"
  })

  afterAll(async () => {
    delete process.env.RATE_LIMIT_FORCE_ENABLED
    await clearRedisPatterns(["ratelimit:user:test-pu:*"])
  })

  function buildApp(identity?: { userId: string; orgId: string }, limit?: number) {
    const app = new Hono<AppEnv>()
    app.onError(errorHandler)
    app.use("/*", async (c, next) => {
      if (identity) {
        // Stand-in for authMiddleware: the only thing the limiter reads is the
        // acting identity the auth middleware resolved.
        c.set("userId", identity.userId)
        c.set("orgId", identity.orgId)
      }
      return next()
    })
    app.use("/*", userRateLimiter(redis, limit === undefined ? {} : { getLimit: () => limit }))
    app.get("/api/test", (c) => c.text("ok"))
    app.get("/api/agent/chat", (c) => c.text("stream"))
    return app
  }

  it("buckets per user: one user is refused while another on the same IP is not", async () => {
    const org = `test-pu:org:${Date.now()}`
    const headers = { "x-forwarded-for": "203.0.113.7, proxy" }
    const busy = buildApp({ userId: `test-pu:busy:${Date.now()}`, orgId: org }, 3)
    const quiet = buildApp({ userId: `test-pu:quiet:${Date.now()}`, orgId: org }, 3)

    for (let i = 0; i < 3; i++) {
      const r = await busy.request("/api/test", { headers })
      expect(r.status).toBe(200)
    }
    const refused = await busy.request("/api/test", { headers })
    expect(refused.status).toBe(429)
    expect(refused.headers.get("Retry-After")).toBeTruthy()

    // Same IP, different acting user: untouched.
    const other = await quiet.request("/api/test", { headers })
    expect(other.status).toBe(200)
  })

  it("refuses the 601st call in a minute at the RATE_LIMIT_PER_USER default", async () => {
    const identifier = `test-pu:default:${Date.now()}`
    const org = `test-pu:defaultorg:${Date.now()}`
    // Through clientBucketKey, not a literal: the same identifier hashing and
    // window suffix as the limiter, minus the prefix the client adds itself.
    const key = clientBucketKey(`user:${org}:${identifier}`, 60)
    // Pre-fill the bucket to one below the default rather than issuing 600 real
    // requests: the boundary under test is the 601st, and the Lua path is the
    // same one the middleware calls.
    const now = Date.now()
    const members: (string | number)[] = []
    for (let i = 0; i < RATE_LIMIT_PER_USER - 1; i++) {
      members.push(now - 1000, `seed:${i}`)
    }
    await redis.zadd(key, ...(members as [number, string]))

    const app = buildApp({ userId: identifier, orgId: org })
    const r600 = await app.request("/api/test")
    expect(r600.status).toBe(200)
    const r601 = await app.request("/api/test")
    expect(r601.status).toBe(429)
    expect(Number(r601.headers.get("Retry-After"))).toBeGreaterThan(0)
  })

  it("does not apply to an unauthenticated request", async () => {
    const app = buildApp(undefined, 1)
    const headers = { "x-forwarded-for": "203.0.113.9, proxy" }
    for (let i = 0; i < 5; i++) {
      const r = await app.request("/api/test", { headers })
      expect(r.status).toBe(200)
    }
  })

  it("skips the long-lived agent chat stream", async () => {
    const app = buildApp({ userId: `test-pu:sse:${Date.now()}`, orgId: `test-pu:sseorg` }, 1)
    for (let i = 0; i < 4; i++) {
      const r = await app.request("/api/agent/chat")
      expect(r.status).toBe(200)
    }
  })
})

describe("userRateLimiter fail-open (auth-plumbing mounts)", () => {
  // A Redis outage must not close the routes people use to recover access.
  const brokenRedis = {
    eval: async () => {
      throw new Error("redis down")
    },
  } as unknown as Redis

  const savedForceFlag = process.env.RATE_LIMIT_FORCE_ENABLED
  beforeAll(() => {
    process.env.RATE_LIMIT_FORCE_ENABLED = "1"
  })
  afterAll(() => {
    if (savedForceFlag === undefined) delete process.env.RATE_LIMIT_FORCE_ENABLED
    else process.env.RATE_LIMIT_FORCE_ENABLED = savedForceFlag
  })

  function buildApp(failOpen: boolean) {
    const app = new Hono<AppEnv>()
    app.onError(errorHandler)
    app.use("/*", async (c, next) => {
      c.set("userId", "test-fo:user")
      c.set("orgId", "test-fo:org")
      return next()
    })
    app.use("/*", userRateLimiter(brokenRedis, { failOpen }))
    app.get("/api/auth/ws-ticket", (c) => c.text("ok"))
    return app
  }

  it("lets the request through and warns when the limiter itself fails", async () => {
    const warnings: unknown[] = []
    const spy = spyOn(rootLogger, "warn").mockImplementation(((obj: unknown) => {
      warnings.push(obj)
    }) as typeof rootLogger.warn)
    try {
      const res = await buildApp(true).request("/api/auth/ws-ticket")
      expect(res.status).toBe(200)
    } finally {
      spy.mockRestore()
    }
    expect(
      warnings.some(
        (w) =>
          (w as { userId?: string })?.userId === "test-fo:user" && !!(w as { err?: unknown }).err,
      ),
    ).toBe(true)
  })

  it("still fails closed with 503 on the general groups", async () => {
    const res = await buildApp(false).request("/api/auth/ws-ticket")
    expect(res.status).toBe(503)
  })

  it("failOpen still refuses a limit the limiter DID compute", async () => {
    // failOpen covers "cannot compute a verdict", never "the verdict was no".
    const app = new Hono<AppEnv>()
    app.onError(errorHandler)
    const userId = `test-fo:full:${Date.now()}`
    app.use("/*", async (c, next) => {
      c.set("userId", userId)
      c.set("orgId", "test-fo:org")
      return next()
    })
    app.use("/*", userRateLimiter(redis, { failOpen: true, getLimit: () => 1 }))
    app.get("/api/auth/ws-ticket", (c) => c.text("ok"))

    const first = await app.request("/api/auth/ws-ticket")
    expect(first.status).toBe(200)
    const second = await app.request("/api/auth/ws-ticket")
    expect(second.status).toBe(429)
    expect(Number(second.headers.get("Retry-After"))).toBeGreaterThan(0)
    await redis.del(clientBucketKey(`user:test-fo:org:${userId}`, 60))
  })
})

describe("orgRateLimiter idempotency", () => {
  it("charges one token when a request matches two mounts", async () => {
    const orgId = `test-org-mb:${Date.now()}`
    await redis.set(`ratelimit:config:limit:${orgId}`, "100")
    const limiter = orgRateLimiter(redis)
    const app = new Hono<AppEnv>()
    app.onError(errorHandler)
    app.use("/*", async (c, next) => {
      c.set("orgId", orgId)
      c.set("userId", "test-org-mb:user")
      return next()
    })
    // The real app mounts the same limiter on /api/apps/* and on
    // /api/apps/manifests/attention-axes, so one request runs it twice.
    app.use("/*", limiter)
    app.use("/*", limiter)
    app.get("/api/test", (c) => c.text("ok"))

    const res = await app.request("/api/test")
    expect(res.status).toBe(200)
    expect(await redis.zcard(clientBucketKey(`org:${orgId}:test-org-mb:user`, 60))).toBe(1)
    await redis.del(`ratelimit:config:limit:${orgId}`)
    await redis.del(clientBucketKey(`org:${orgId}:test-org-mb:user`, 60))
  })
})
