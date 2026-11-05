// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression guard: the global request timeout applied to all /api/* routes
// MUST be skipped for /api/agent/chat, which streams AI responses indefinitely.
// Applying a hard timeout there would sever in-progress AI replies mid-stream.
//
// This file constructs a minimal, hermetic Hono app that mirrors the exact
// middleware configuration from app.ts (lines 180-183):
//
//   app.use("/api/*", async (c, next) => {
//     if (c.req.path.startsWith("/api/agent/chat")) return next()
//     return timeout(30_000)(c, next)
//   })
//
// We exercise it with a deliberately-slow handler and a very short timeout so
// the suite runs in milliseconds rather than tens of seconds.
// No DB/Redis/external services are required — fully hermetic.

import { describe, expect, it } from "bun:test"
import type { Context } from "hono"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { requestTimeout } from "~/middleware/request-timeout"

// ---------------------------------------------------------------------------
// Build a miniature app that faithfully replicates the middleware from app.ts.
// The timeout duration is parameterised so tests can use small values without
// changing production behaviour.
// ---------------------------------------------------------------------------

function buildApp(timeoutMs: number): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Mirror of app.ts ~lines 180-183:
  //   global timeout on /api/* except the streaming agent-chat path.
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/agent/chat")) return next()
    return requestTimeout(timeoutMs)(c, next)
  })

  // Slow handler shared by both routes — takes longer than the timeout.
  // We use a small absolute delay (50 ms) and keep the timeout even shorter
  // (20 ms) so the test stays fast while still demonstrating the race.
  const SLOW_DELAY_MS = 50
  const slowHandler = async (c: Context<AppEnv>) => {
    await new Promise<void>((resolve) => setTimeout(resolve, SLOW_DELAY_MS))
    return c.json({ data: "ok" })
  }

  // Exempt path: timeout middleware calls next() immediately without wrapping.
  app.get("/api/agent/chat", slowHandler)

  // Non-exempt path: timeout middleware wraps next() with a deadline.
  app.get("/api/users", slowHandler)

  return app
}

// The timeout must be shorter than the slow handler's delay so non-exempt
// routes time out, but the exempt route completes without a race.
const TIMEOUT_MS = 20

describe("timeout middleware — /api/agent/chat exemption", () => {
  it("exempt path /api/agent/chat completes despite slow handler", async () => {
    const app = buildApp(TIMEOUT_MS)
    const res = await app.request("/api/agent/chat")

    // The slow handler must have completed successfully — not timed out.
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: string }
    expect(body.data).toBe("ok")
  })

  it("non-exempt path /api/users is bounded by the timeout (504)", async () => {
    const app = buildApp(TIMEOUT_MS)
    const res = await app.request("/api/users")

    // requestTimeout rejects with HTTPException(504) when the timer fires first.
    // Hono's built-in error handler converts that to a 504 response.
    expect(res.status).toBe(504)
  })

  it("exempt path /api/agent/chat/stream also bypasses timeout", async () => {
    // The check uses startsWith so sub-paths are also exempt (e.g. the SSE
    // streaming endpoint /api/agent/chat/stream or similar future paths).
    const app = buildApp(TIMEOUT_MS)

    // Add a slow handler for the sub-path so the exemption is tested
    // (without a route registered, Hono would return 404 immediately — not
    // a meaningful test of the exemption).
    const SLOW_DELAY_MS = 50
    app.get("/api/agent/chat/stream", async (c) => {
      await new Promise<void>((resolve) => setTimeout(resolve, SLOW_DELAY_MS))
      return c.json({ data: "streaming" })
    })

    const res = await app.request("/api/agent/chat/stream")

    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: string }
    expect(body.data).toBe("streaming")
  })

  it("a second non-exempt /api/* route is also bounded", async () => {
    // Validates that the exemption is path-specific, not accidentally applied
    // to all /api/* routes.
    const app = buildApp(TIMEOUT_MS)

    const SLOW_DELAY_MS = 50
    app.get("/api/contacts", async (c) => {
      await new Promise<void>((resolve) => setTimeout(resolve, SLOW_DELAY_MS))
      return c.json({ data: "contacts" })
    })

    const res = await app.request("/api/contacts")
    expect(res.status).toBe(504)
  })
})

// ---------------------------------------------------------------------------
// The timeout must CANCEL, not just answer 504. hono/timeout only raced the
// handler against a timer: the work it abandoned kept running, so a sandboxed
// tool call held its worker for the rest of its own 62s kill timer after the
// operator already saw "Request failed" at 30s, and re-clicks compounded into a
// rolling outage. requestTimeout publishes an AbortSignal on the context and
// aborts it, which routes hand to executeTool -> the sandbox worker pool.
// ---------------------------------------------------------------------------
describe("timeout middleware - cancellation", () => {
  it("aborts the request signal when the budget expires", async () => {
    const app = new Hono<AppEnv>()
    let aborted = false
    let signalSeen = false
    app.use("/api/*", async (c, next) => requestTimeout(20)(c, next))
    app.get("/api/slow", async (c) => {
      const signal = c.get("requestSignal")
      signalSeen = signal instanceof AbortSignal
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => {
          aborted = true
          resolve()
        })
        setTimeout(resolve, 500)
      })
      return c.json({ data: "ok" })
    })

    const res = await app.request("/api/slow")
    expect(res.status).toBe(504)
    expect(signalSeen).toBe(true)
    // The handler's own view of the request was cancelled, not merely answered.
    expect(aborted).toBe(true)
  })

  it("aborts the request signal when the client disconnects", async () => {
    const app = new Hono<AppEnv>()
    let aborted = false
    app.use("/api/*", async (c, next) => requestTimeout(10_000)(c, next))
    app.get("/api/slow", async (c) => {
      const signal = c.get("requestSignal")
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => {
          aborted = true
          resolve()
        })
        setTimeout(resolve, 500)
      })
      return c.json({ data: "ok" })
    })

    const controller = new AbortController()
    const pending = Promise.resolve(app.request("/api/slow", { signal: controller.signal }))
    setTimeout(() => controller.abort(), 20)
    await pending.catch(() => undefined)
    expect(aborted).toBe(true)
  })
})
