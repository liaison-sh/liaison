# Middleware

All middleware exports factory functions returning `MiddlewareHandler`.

## Available middleware

| Middleware | Factory | Purpose |
|-----------|---------|---------|
| **auth** | `authMiddleware(secret)` | JWT verification, sets `userId`/`orgId`/`roles`/`scopes`/`dimensionGrants` on context |
| **require-scope** | `requireScope(scope)` | Gate routes by scope string — throws 403 |
| **rate-limiter** | `rateLimiter(redis, { getLimit?, failOpen? })` | Sliding window (60s) via Redis sorted set — skips in non-production |
| **brute-force** | `bruteForce(redis)` | Login attempt throttling |
| **error-handler** | `errorHandler()` | Global `app.onError()` — catches `HTTPException` + unexpected errors |

## Pattern

```typescript
import { createMiddleware } from "hono/factory"
import type { AppEnv } from "~/app"

export function myMiddleware(config: Config) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // pre-processing
    await next()
    // post-processing
  })
}
```

## Brute-force middleware

`checkBruteForce(redis, email, ip)` — dual-axis login throttling. Tracks per-email and per-IP attempt counters in Redis using atomic Lua scripts. Returns `{ allowed, retryAfter? }`.

- Per-IP block: triggers after `MAX_IP_ATTEMPTS` (20) from a single IP, regardless of target email.
- Per-email block: triggers after `MAX_EMAIL_ATTEMPTS` (5) only when the requesting IP has also accumulated ≥ `MIN_IP_FOR_EMAIL_BLOCK` (3) failures. This prevents a remote attacker from locking out a legitimate user without the IP sharing blame.
- Backoff: exponential, capped at 15 minutes. Keys expire after 1 hour.
- `resetAttempts(redis, email)` — call on successful login to clear the per-email counter.

```typescript
const result = await checkBruteForce(redis, email, clientIp)
if (!result.allowed) {
  c.header("Retry-After", String(result.retryAfter))
  throw new HTTPException(429, { message: "Too many attempts" })
}
```

## Rate-limiter middleware

`rateLimiter(redis, { getLimit?, failOpen? })` — sliding-window rate limiter scoped per client IP. `failOpen` lets a request through when the limiter itself cannot reach Redis; `app.ts` mounts a fail-open instance for `isCredentialRecoveryPath` and the fail-closed one for everything else, because this layer runs BEFORE the per-user limiter and would otherwise 503 the credential routes during the outage their fail-open exists for.

- Window: 60 seconds via Redis sorted set.
- Default limit: `RATE_LIMIT_DEFAULT` env var (fallback 1200 req/min, per client IP, pre-auth). Override globally via `ratelimit:config:limit` Redis key.
- `userRateLimiter` runs after auth on the same Redis Lua path, bucketed `user:<orgId>:<userId>`, default `RATE_LIMIT_PER_USER` (600 req/min). It is composed onto the auth middleware in `app.ts` (a standalone `/api/*` mount would run before auth and have no user to bucket by), skips the agent-chat SSE stream and the file-relay routes, and lets unauthenticated requests through to the IP limiter alone. A path matching two mounts is charged once (`userRateLimitChecked`). Under `NODE_ENV=test` it is off, like the IP limiter; `RATE_LIMIT_FORCE_ENABLED=1` turns it back on so a test can exercise the real `app.ts` wiring (`rate-limiter-routing.test.ts`).
- `app.ts` composes two variants. `authMw` is the demo-aware auth plus the limiter, paired with `orgLimiter` at each mount. `authPlusLimit` covers the auth-plumbing routes (TOTP, password change, device-flow approve/deny, ws-ticket, MCP OAuth consent): it composes the RAW `authMiddleware` (not the demo-aware one) and carries no org limiter, both pre-existing, and its limiter is `failOpen` so a Redis outage cannot also close the routes people use to recover access.
- `getLimit?: () => number` — optional override function injected at mount time (useful in tests).
- Responds with HTTP 429 + `Retry-After: 60` when the limit is exceeded.

```typescript
app.use("/api/*", rateLimiter(redis))             // default limit
app.use("/api/*", rateLimiter(redis, { getLimit: () => 60 }))  // custom limit
```

## `getClientIp` utility

Exported from `~/lib/request-context`. Extracts the real client IP from `X-Forwarded-For` or `X-Real-IP`, honouring `TRUSTED_PROXY_HOPS` (default 0 = direct socket IP) via the rightmost-minus-N algorithm. Set `TRUSTED_PROXY_HOPS=1` when behind a reverse proxy. Falls back to `"unknown"` when no header is present.

```typescript
import { getClientIp } from "~/lib/request-context"
const ip = getClientIp(c) // "203.0.113.42" or "unknown"
```

## Logging

Middleware logs security-relevant rejections at `warn` level using `rootLogger` from `~/lib/logger`.

- **auth** — logs every 401 with `{ method, path, reason }`.
- **brute-force** — logs every blocked key with `{ key, ip }`.
- **rate-limiter** — logs every 429 with `{ ip }`.

Use structured context objects (not string interpolation) so the fields are queryable in log aggregators.

## Composition in `app.ts`

Middleware stacks per route group — auth first, then scope/rate limiting, then mount routes.
