// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { errorHandler } from "~/middleware/error-handler"
import { requireScope } from "~/middleware/require-scope"

type ErrorBody = {
  error: {
    code?: string
    message?: string
    details?: { missingScope?: string; requestable?: boolean }
  }
}

function mockScopes(scopes: string[]) {
  return async (c: any, next: any) => {
    c.set("scopes", scopes)
    await next()
  }
}

describe("requireScope middleware", () => {
  function createTestApp(scope: string) {
    const app = new Hono()
    app.use(async (c, next) => {
      // Mock auth context
      ;(c as any).set("scopes", c.req.header("X-Scopes")?.split(",") ?? [])
      await next()
    })
    app.use(requireScope(scope))
    app.get("/", (c) => c.json({ ok: true }))
    app.onError(errorHandler)
    return app
  }

  it("allows request when user has exact scope", async () => {
    const app = createTestApp("kernel:audit:read")
    const res = await app.request("/", {
      headers: { "X-Scopes": "kernel:audit:read" },
    })
    expect(res.status).toBe(200)
  })

  it("allows request when user has parent scope", async () => {
    const app = createTestApp("kernel:audit:read")
    const res = await app.request("/", {
      headers: { "X-Scopes": "kernel:audit" },
    })
    expect(res.status).toBe(200)
  })

  it("returns 403 when user lacks scope", async () => {
    const app = createTestApp("kernel:audit:read")
    const res = await app.request("/", {
      headers: { "X-Scopes": "kernel:users:admin" },
    })
    expect(res.status).toBe(403)
  })

  it("returns 403 when user has no scopes", async () => {
    const app = createTestApp("kernel:audit:read")
    const res = await app.request("/", { headers: {} })
    expect(res.status).toBe(403)
  })

  it("returns 403 when user has child scope but not parent", async () => {
    const app = createTestApp("kernel:audit")
    const res = await app.request("/", {
      headers: { "X-Scopes": "kernel:audit:read" },
    })
    // Child scope does NOT grant parent
    expect(res.status).toBe(403)
  })

  it("403 body names the missing scope and marks it requestable", async () => {
    const app = createTestApp("kernel:contacts:write")
    const res = await app.request("/", {
      headers: { "X-Scopes": "kernel:contacts:read" },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe("PERMISSION_DENIED")
    expect(body.error.details).toEqual({
      missingScope: "kernel:contacts:write",
      requestable: true,
    })
    expect(body.error.message).toMatch(/kernel:contacts:write/)
  })
})

describe("requireScope with method-conditional map", () => {
  function createMethodApp(spec: Record<string, string>) {
    const app = new Hono()
    app.use(mockScopes(["kernel:contacts:read"]))
    app.use(requireScope(spec))
    app.get("/", (c) => c.json({ ok: true }))
    app.post("/", (c) => c.json({ ok: true }))
    app.onError(errorHandler)
    return app
  }

  it("allows GET when user has the read scope", async () => {
    const app = createMethodApp({ GET: "kernel:contacts:read", "*": "kernel:contacts:write" })
    const res = await app.request("/", { method: "GET" })
    expect(res.status).toBe(200)
  })

  it("rejects POST when user lacks the write scope", async () => {
    const app = createMethodApp({ GET: "kernel:contacts:read", "*": "kernel:contacts:write" })
    const res = await app.request("/", { method: "POST" })
    expect(res.status).toBe(403)
  })

  it("denies unlisted methods (default-deny) when using object form", async () => {
    const app = createMethodApp({ PATCH: "kernel:org:admin" })
    const res = await app.request("/", { method: "GET" })
    expect(res.status).toBe(403)
  })

  it("default-deny (unlisted method) is PERMISSION_DENIED without a missingScope", async () => {
    const app = createMethodApp({ PATCH: "kernel:org:admin" }) // GET unlisted → default-deny
    const res = await app.request("/", { method: "GET" })
    expect(res.status).toBe(403)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe("PERMISSION_DENIED")
    expect(body.error.details?.missingScope).toBeUndefined()
    // Nothing concrete to request → must not be advertised as requestable.
    expect(body.error.details?.requestable).toBe(false)
  })
})
