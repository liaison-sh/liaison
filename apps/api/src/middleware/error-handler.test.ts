// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { redactSecretShapes } from "@liaison/shared"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { QueueBackpressureError } from "~/infra/jobs/backpressure"
import { ErrorTrackerTestAccess, getDiagErrorState } from "~/lib/error-tracker"
import { errorHandler } from "~/middleware/error-handler"

function createTestApp() {
  const app = new Hono()
  app.get("/http-error", () => {
    throw new HTTPException(400, { message: "Bad input" })
  })
  app.get("/unexpected", () => {
    throw new Error("kaboom")
  })
  app.get("/busy", () => {
    throw new QueueBackpressureError("kernel-bulk", "redis-memory", "Redis at 95.0% of maxmemory")
  })
  app.get("/busy-wrapped", () => {
    throw new Error("enqueue failed", {
      cause: new QueueBackpressureError("app-mail", "queue-depth", "250000 jobs queued"),
    })
  })
  app.get("/ok", (c) => c.json({ data: "ok" }))
  app.onError(errorHandler)
  return app
}

describe("error handler", () => {
  const app = createTestApp()

  it("catches HTTPException and returns structured error", async () => {
    const res = await app.request("/http-error")
    expect(res.status).toBe(400)
    const body = (await res.json()) as any as any
    expect(body).toEqual({ error: { message: "Bad input", code: "BAD_REQUEST" } })
  })

  // Design audit 2026-09-30, finding 17: a refused enqueue is overload, not a
  // bug. It must reach the client as 503 + Retry-After, without internals.
  it("maps queue backpressure (direct or as a cause) to 503 SERVER_BUSY with Retry-After", async () => {
    for (const path of ["/busy", "/busy-wrapped"]) {
      const res = await app.request(path)
      expect(res.status).toBe(503)
      expect(res.headers.get("Retry-After")).toBe("30")
      const body = (await res.json()) as any
      expect(body.error.code).toBe("SERVER_BUSY")
      expect(JSON.stringify(body)).not.toContain("maxmemory")
      expect(JSON.stringify(body)).not.toContain("jobs queued")
    }
  })

  it("catches unexpected errors and returns generic 500", async () => {
    const res = await app.request("/unexpected")
    expect(res.status).toBe(500)
    const body = (await res.json()) as any as any
    expect(body.error.message).toBe("Internal server error")
    expect(body.error.code).toBe("INTERNAL_ERROR")
  })

  // A bare 500 left the operator with "Something went wrong" and nothing to
  // quote; the log line could only be found by timestamp.
  it("gives every unhandled 500 a fresh reference the client can quote", async () => {
    const a = (await (await app.request("/unexpected")).json()) as any
    const b = (await (await app.request("/unexpected")).json()) as any
    expect(a.error.ref).toMatch(/^[0-9a-f]{8}$/)
    expect(b.error.ref).toMatch(/^[0-9a-f]{8}$/)
    expect(a.error.ref).not.toBe(b.error.ref)
  })

  it("does not interfere with successful responses", async () => {
    const res = await app.request("/ok")
    expect(res.status).toBe(200)
    const body = (await res.json()) as any as any
    expect(body).toEqual({ data: "ok" })
  })

  it("B4/C1: an unhandled error is tracked (unhandled branch only, not HTTPException)", async () => {
    ErrorTrackerTestAccess.reset()
    await app.request("/unexpected")
    const state = getDiagErrorState()
    expect(state.errorSignatures.length).toBe(1)
    expect(state.errorSignatures[0]?.lastSample).toContain("kaboom")

    ErrorTrackerTestAccess.reset()
    await app.request("/http-error")
    const afterHttpException = getDiagErrorState()
    expect(afterHttpException.errorSignatures.length).toBe(0)
  })
})

describe("error handler: provider SDK errors (U-1)", () => {
  it("masks a quoted API key in a typed error's message before it reaches the client", async () => {
    const app = new Hono()
    app.get("/sdk", () => {
      throw Object.assign(
        new Error("401 Incorrect API key provided: sk-proj-****abcd1234. See docs."),
        {
          status: 401,
          code: "invalid_api_key",
        },
      )
    })
    app.onError(errorHandler)
    const res = await app.request("/sdk")
    // The provider refused ITS key: never this session's 401 (the web signs out on that).
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { message: string; code: string } }
    expect(body.error.code).toBe("invalid_api_key")
    expect(body.error.message).not.toContain("sk-proj")
    expect(body.error.message).toContain("[redacted]")
  })

  it("a provider's 401 (a Gmail send refused) answers 502, other typed statuses pass through", async () => {
    const app = new Hono()
    app.get("/gmail", () => {
      throw Object.assign(new Error("Gmail send failed with status 401"), {
        status: 401,
        code: "GMAIL_SEND_FAILED",
      })
    })
    app.get("/conflict", () => {
      throw Object.assign(new Error("Revision conflict"), {
        status: 409,
        code: "REVISION_CONFLICT",
      })
    })
    app.onError(errorHandler)
    const gmail = await app.request("/gmail")
    expect(gmail.status).toBe(502)
    expect(((await gmail.json()) as { error: { code: string } }).error.code).toBe(
      "GMAIL_SEND_FAILED",
    )
    expect((await app.request("/conflict")).status).toBe(409)
  })

  it("leaves an ordinary typed message alone", () => {
    expect(redactSecretShapes("File exceeds the 50 MB limit")).toBe("File exceeds the 50 MB limit")
    expect(redactSecretShapes("key AIzaSyA1234567890abcdef rejected")).toBe(
      "key [redacted] rejected",
    )
  })
})
