// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash } from "node:crypto"
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import type Redis from "ioredis"
import type { AppEnv } from "~/app"
import { env } from "~/lib/env"
import { envFlag } from "~/lib/env-boolean"
import { rootLogger } from "~/lib/logger"
import { REDIS_PREFIX } from "~/lib/redis"
import { getClientIp } from "~/lib/request-context"

export const RATE_LIMIT_DEFAULT = env.RATE_LIMIT_DEFAULT
export const RATE_LIMIT_PER_USER = env.RATE_LIMIT_PER_USER

const DEFAULT_WINDOW_SECONDS = 60

// Multi-bucket Lua script — single round-trip atomicity.
// ARGV: now_ms, JSON-encoded buckets [{key, windowMs, limit, ttl}]
// Iterates buckets twice: first to check + short-circuit on first failure;
// second to ZADD + EXPIRE atomically once all buckets pass.
const RATE_LIMIT_SCRIPT = `
local now = tonumber(ARGV[1])
local buckets = cjson.decode(ARGV[2])
for i, b in ipairs(buckets) do
  redis.call('ZREMRANGEBYSCORE', b.key, 0, now - b.windowMs)
  local count = redis.call('ZCARD', b.key)
  if count >= b.limit then
    local oldest = redis.call('ZRANGE', b.key, 0, 0, 'WITHSCORES')
    local retryAfter = b.windowSeconds
    if oldest[2] ~= nil then
      retryAfter = math.max(1, math.ceil((tonumber(oldest[2]) + b.windowMs - now) / 1000))
    end
    return { 0, i - 1, retryAfter }
  end
end
local remaining = {}
for i, b in ipairs(buckets) do
  redis.call('ZADD', b.key, now, now .. ':' .. b.member)
  redis.call('EXPIRE', b.key, b.ttl)
  remaining[i] = b.limit - redis.call('ZCARD', b.key)
end
return { 1, remaining }
`

export interface RateLimitBucket {
  identifier: string
  limit: number
  windowSeconds?: number
}

export type RateLimitResult =
  | { allowed: true; remaining: number[] }
  | {
      allowed: false
      failed: {
        identifier: string
        limit: number
        windowSeconds: number
        retryAfterSeconds: number
      }
    }

export function bucketKey(identifier: string, windowSeconds: number): string {
  // Identifiers >256 bytes are SHA-256 hashed to keep Redis keys bounded.
  const id =
    identifier.length > 256
      ? `h:${createHash("sha256").update(identifier).digest("hex")}`
      : identifier
  // REDIS_PREFIX must be applied here, not via ioredis keyPrefix. The Lua
  // script receives keys through ARGV (JSON-encoded buckets) and operates on
  // them with redis.call(...), so ioredis's KEYS-only prefixing never fires.
  // Without this, every worker shares one rate-limit bucket — e.g. the
  // anonymous webhook 5/min cap is hit cross-worker in the e2e-parallel suite.
  return `${REDIS_PREFIX}ratelimit:${id}:${windowSeconds}`
}

export async function checkRateLimit(
  redis: Redis,
  bucketsOrIdentifier: RateLimitBucket[] | string,
  legacyLimit?: number,
): Promise<RateLimitResult> {
  // Single-bucket back-compat: checkRateLimit(redis, "id", limit)
  let buckets: RateLimitBucket[]
  if (typeof bucketsOrIdentifier === "string") {
    if (typeof legacyLimit !== "number") throw new Error("limit required for single-bucket call")
    buckets = [
      {
        identifier: bucketsOrIdentifier,
        limit: legacyLimit,
        windowSeconds: DEFAULT_WINDOW_SECONDS,
      },
    ]
  } else {
    buckets = bucketsOrIdentifier
  }
  if (buckets.length === 0) throw new Error("no buckets")

  const now = Date.now()
  const member = crypto.randomUUID()
  const encoded = buckets.map((b) => {
    const windowSeconds = b.windowSeconds ?? DEFAULT_WINDOW_SECONDS
    return {
      key: bucketKey(b.identifier, windowSeconds),
      windowMs: windowSeconds * 1000,
      windowSeconds,
      limit: b.limit,
      ttl: windowSeconds + 5,
      member,
    }
  })

  const result = (await redis.eval(RATE_LIMIT_SCRIPT, 0, String(now), JSON.stringify(encoded))) as
    | [number, number, number]
    | [number, number[]]

  if (result[0] === 0) {
    const idx = result[1] as number
    const retryAfter = result[2] as number
    const failed = buckets[idx]
    const windowSeconds = failed.windowSeconds ?? DEFAULT_WINDOW_SECONDS
    return {
      allowed: false,
      failed: {
        identifier: failed.identifier,
        limit: failed.limit,
        windowSeconds,
        retryAfterSeconds: Math.max(1, retryAfter),
      },
    }
  }
  return { allowed: true, remaining: result[1] as number[] }
}

/**
 * Global baseline rate limiter. Runs before auth — uses RATE_LIMIT_DEFAULT for all traffic.
 */
export interface RateLimiterOptions {
  /** Override the RATE_LIMIT_DEFAULT ceiling. */
  getLimit?: () => number
  /**
   * Let the request through when the limiter ITSELF fails (Redis down) instead
   * of the default 503. Paired with the same option on `userRateLimiter` for
   * the credential-recovery routes: the IP limiter runs FIRST on /api/*, so a
   * fail-open per-user limiter behind a fail-closed IP limiter would never be
   * reached during an outage.
   */
  failOpen?: boolean
}

export function rateLimiter(redisClient: Redis, opts: RateLimiterOptions | (() => number) = {}) {
  // Back-compat: rateLimiter(redis, () => 60)
  const { getLimit, failOpen = false } = typeof opts === "function" ? { getLimit: opts } : opts
  return createMiddleware<AppEnv>(async (c, next) => {
    const identifier = getClientIp(c)
    const limit = getLimit?.() ?? (env.NODE_ENV === "development" ? 10_000 : RATE_LIMIT_DEFAULT)

    try {
      const result = await checkRateLimit(redisClient, [
        { identifier, limit, windowSeconds: DEFAULT_WINDOW_SECONDS },
      ])
      if (!result.allowed) {
        rootLogger.warn({ ip: identifier }, "rate limit exceeded")
        c.header("Retry-After", String(result.failed.retryAfterSeconds))
        throw new HTTPException(429, { message: "Too many requests" })
      }
    } catch (err) {
      if (err instanceof HTTPException) throw err
      if (failOpen) {
        rootLogger.warn(
          { err, ip: identifier, path: c.req.path },
          "IP rate limiter unavailable — allowing request (fail-open)",
        )
        return next()
      }
      rootLogger.error({ err }, "rate limiter failed — blocking request (fail-closed)")
      throw new HTTPException(503, { message: "Service temporarily unavailable" })
    }

    await next()
  })
}

/**
 * Per-org rate limiter. Runs after auth — reads per-org override from Redis.
 */
export function orgRateLimiter(redisClient: Redis) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const orgId = c.get("orgId")
    if (!orgId) return next()
    // Same reason as the user limiter: one request can match several mounts
    // (e.g. /api/apps/manifests/attention-axes), which would spend two tokens.
    if (c.get("orgRateLimitChecked")) return next()

    const orgLimitKey = `ratelimit:config:limit:${orgId}`
    let orgLimitStr: string | null = null
    try {
      orgLimitStr = await redisClient.get(orgLimitKey)
    } catch {
      /* fall through */
    }
    if (orgLimitStr === null) return next()
    const orgLimit = Number(orgLimitStr) || RATE_LIMIT_DEFAULT

    const identifier = `org:${orgId}:${c.get("userId") ?? getClientIp(c)}`

    try {
      const result = await checkRateLimit(redisClient, [
        { identifier, limit: orgLimit, windowSeconds: DEFAULT_WINDOW_SECONDS },
      ])
      if (!result.allowed) {
        rootLogger.warn({ ip: identifier, orgId }, "per-org rate limit exceeded")
        c.header("Retry-After", String(result.failed.retryAfterSeconds))
        throw new HTTPException(429, { message: "Too many requests" })
      }
      c.set("orgRateLimitChecked", true)
    } catch (err) {
      if (err instanceof HTTPException) throw err
      rootLogger.error({ err }, "rate limiter failed — blocking request (fail-closed)")
      throw new HTTPException(503, { message: "Service temporarily unavailable" })
    }

    await next()
  })
}

/**
 * Per-user rate limiter. Runs AFTER auth, so it only ever sees a request whose
 * acting user the auth middleware already resolved (a web session, an MCP
 * connection token, an API key). Unauthenticated requests carry no userId and
 * fall through: the pre-auth per-IP limiter is their only cap.
 *
 * Why this exists alongside the IP limiter: a whole office shares one egress
 * address, so the per-IP ceiling has to be generous enough for several people
 * navigating at once (RATE_LIMIT_DEFAULT). That generosity is exactly what a
 * single runaway client would spend on everyone else's behalf, so the real
 * containment is per acting user (RATE_LIMIT_PER_USER).
 */
export interface UserRateLimiterOptions {
  /** Override the RATE_LIMIT_PER_USER ceiling (tests, and future per-route tuning). */
  getLimit?: () => number
  /**
   * Let the request through when the limiter ITSELF fails (Redis down), instead
   * of the default 503. Used only for the auth-plumbing mounts: a password
   * change, a TOTP step-up, a WebSocket ticket or a device-flow approval is how
   * someone recovers access, and a Redis outage must not also lock them out of
   * the credential routes. A refusal the limiter actually computed is still a
   * 429 here; this only covers not being able to compute one.
   */
  failOpen?: boolean
}

export function userRateLimiter(redisClient: Redis, opts: UserRateLimiterOptions = {}) {
  const { getLimit, failOpen = false } = opts
  return createMiddleware<AppEnv>(async (c, next) => {
    // NODE_ENV=test disables the limiter, exactly like the pre-auth IP limiter,
    // so suites that replay hundreds of requests as one user are unaffected.
    // The decision lives here rather than at the mount because RATE_LIMIT_FORCE_ENABLED
    // lets a routing test exercise the REAL wiring: a mount-time branch would
    // leave the composition itself untested.
    if (env.NODE_ENV === "test" && !envFlag("RATE_LIMIT_FORCE_ENABLED")) return next()

    const userId = c.get("userId")
    if (!userId) return next()

    // One request can match several mounts (e.g. /api/apps/manifests/attention-axes
    // matches both the /api/apps/* group and its own line), which would spend two
    // tokens for one call. First check wins; later passes are a no-op.
    if (c.get("userRateLimitChecked")) return next()

    // Same exemptions the request timeout applies: the long-lived agent-chat SSE
    // stream is one request that lives for minutes, and the relay routes stream
    // whole files. /healthz and /diag never reach here (they are outside /api and
    // carry no auth), but skipping them explicitly keeps the probe path honest.
    const path = c.req.path
    if (
      path.startsWith("/api/agent/chat") ||
      path.startsWith("/api/file-relay/") ||
      path.startsWith("/api/file-relay-dl/") ||
      path.startsWith("/api/org-export-dl/") ||
      path.startsWith("/healthz") ||
      path.startsWith("/diag")
    ) {
      return next()
    }

    const orgId = c.get("orgId")
    const identifier = orgId ? `user:${orgId}:${userId}` : `user:${userId}`
    const limit = getLimit?.() ?? RATE_LIMIT_PER_USER

    try {
      const result = await checkRateLimit(redisClient, [
        { identifier, limit, windowSeconds: DEFAULT_WINDOW_SECONDS },
      ])
      if (!result.allowed) {
        // userId and orgId only: never the bearer token or any part of it.
        rootLogger.warn({ userId, orgId, limit }, "per-user rate limit exceeded")
        c.header("Retry-After", String(result.failed.retryAfterSeconds))
        throw new HTTPException(429, { message: "Too many requests" })
      }
      c.set("userRateLimitChecked", true)
    } catch (err) {
      if (err instanceof HTTPException) throw err
      if (failOpen) {
        rootLogger.warn(
          { err, userId, path },
          "per-user rate limiter unavailable — allowing request (fail-open)",
        )
        return next()
      }
      rootLogger.error({ err }, "rate limiter failed — blocking request (fail-closed)")
      throw new HTTPException(503, { message: "Service temporarily unavailable" })
    }

    await next()
  })
}
