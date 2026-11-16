// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Budgets for the portal routes that write, in the manner of the public-surface
// limits (middleware/public-surface-limits.ts): counted before the route parses
// its body, 429 with Retry-After past the budget, 503 when Redis cannot count
// (fail closed), off under NODE_ENV=test unless RATE_LIMIT_FORCE_ENABLED. Each
// budget counts per portal person and, more loosely, per address, so one token
// cannot flood the org's tickets and many tokens from one place are bounded too.
import type { MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import type Redis from "ioredis"
import type { AppEnv } from "~/app"
import { env } from "~/lib/env"
import { envFlag } from "~/lib/env-boolean"
import { rootLogger } from "~/lib/logger"
import { getClientIp } from "~/lib/request-context"
import { checkRateLimit } from "~/middleware/rate-limiter"
import { PORTAL_PREFIX } from "~/modules/portal/routes-list"

export interface PortalBudget {
  name: string
  method: "POST"
  /** Matches the path under PORTAL_PREFIX. */
  path: RegExp
  /** Per portal person per window. */
  perPerson: number
  /** Per client address per window: an office behind one address holds several people. */
  perAddress: number
  windowSeconds: number
}

const ID = "[0-9a-fA-F-]{36}"

export const PORTAL_WRITE_BUDGETS: readonly PortalBudget[] = [
  // A new request is a ticket for the team: a person writes a few, not dozens.
  {
    name: "request",
    method: "POST",
    path: /^\/requests$/,
    perPerson: 10,
    perAddress: 50,
    windowSeconds: 60,
  },
  {
    name: "request-reply",
    method: "POST",
    path: new RegExp(`^/requests/${ID}/reply$`),
    perPerson: 20,
    perAddress: 100,
    windowSeconds: 60,
  },
  // Eight files wait at most; a few retries on top.
  {
    name: "request-attachment",
    method: "POST",
    path: /^\/requests\/attachments$/,
    perPerson: 20,
    perAddress: 100,
    windowSeconds: 60,
  },
  {
    name: "totp-setup",
    method: "POST",
    path: /^\/me\/totp\/setup$/,
    perPerson: 5,
    perAddress: 25,
    windowSeconds: 60,
  },
  // A wrong code also waits a second; this bounds guessing on top.
  {
    name: "totp-confirm",
    method: "POST",
    path: /^\/me\/totp\/confirm$/,
    perPerson: 5,
    perAddress: 25,
    windowSeconds: 60,
  },
  {
    name: "notice-ack",
    method: "POST",
    path: /^\/me\/notice-ack$/,
    perPerson: 10,
    perAddress: 50,
    windowSeconds: 60,
  },
]

/** The budget of a portal route (full path, under PORTAL_PREFIX), or undefined. */
export function portalBudgetFor(method: string, path: string): PortalBudget | undefined {
  if (!path.startsWith(`${PORTAL_PREFIX}/`)) return undefined
  const rest = path.slice(PORTAL_PREFIX.length)
  return PORTAL_WRITE_BUDGETS.find((b) => b.method === method && b.path.test(rest))
}

/** Runs after portalAuthMiddleware, so the person is known. */
export function portalWriteRateLimit(redis: Redis): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (env.NODE_ENV === "test" && !envFlag("RATE_LIMIT_FORCE_ENABLED")) return next()
    const budget = portalBudgetFor(c.req.method, c.req.path)
    if (!budget) return next()
    const person = c.get("portal")?.userId ?? "anonymous"
    const ip = getClientIp(c)
    try {
      const result = await checkRateLimit(redis, [
        {
          identifier: `portal:${budget.name}:person:${person}`,
          limit: budget.perPerson,
          windowSeconds: budget.windowSeconds,
        },
        {
          identifier: `portal:${budget.name}:ip:${ip}`,
          limit: budget.perAddress,
          windowSeconds: budget.windowSeconds,
        },
      ])
      if (!result.allowed) {
        rootLogger.warn({ ip, person, budget: budget.name }, "portal write rate limit exceeded")
        c.header("Retry-After", String(result.failed.retryAfterSeconds))
        throw new HTTPException(429, { message: "Too many requests" })
      }
    } catch (err) {
      if (err instanceof HTTPException) throw err
      rootLogger.error({ err }, "portal write limiter failed — blocking request (fail-closed)")
      throw new HTTPException(503, { message: "Service temporarily unavailable" })
    }
    return next()
  }
}
