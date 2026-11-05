// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { redis } from "~/lib/redis"
import { errorHandler } from "~/middleware/error-handler"
import {
  MCP_TRANSPORT_BODY_MAX_BYTES,
  PUBLIC_OAUTH_BODY_MAX_BYTES,
  publicSurfaceBodyLimit,
  publicSurfaceRateLimit,
} from "~/middleware/public-surface-limits"

function buildApp() {
  const app = new Hono<AppEnv>()
  for (const prefix of ["/.well-known/*", "/mcp/oauth/*", "/mcp/device/*"]) {
    app.use(prefix, publicSurfaceBodyLimit(), publicSurfaceRateLimit(redis))
  }
  app.use("/mcp", publicSurfaceBodyLimit())
  app.use("/api/auth/device-flow/initiate", publicSurfaceRateLimit(redis))
  app.all("*", async (c) => {
    const text = await c.req.text()
    return c.json({ bytes: text.length })
  })
  app.onError(errorHandler)
  return app
}

const octet = () => Math.floor(Math.random() * 250) + 1
const randomIp = () => `203.0.${octet()}.${octet()}`

describe("public surface body caps", () => {
  it("refuses an oversized body on every public OAuth / device route before the handler reads it", async () => {
    const big = "x".repeat(PUBLIC_OAUTH_BODY_MAX_BYTES + 1)
    for (const path of ["/mcp/oauth/register", "/mcp/oauth/token", "/mcp/device/initiate"]) {
      const res = await buildApp().request(path, { method: "POST", body: big })
      expect(res.status).toBe(413)
    }
  })

  it("refuses an oversized body that declares no length (chunked)", async () => {
    const chunk = new TextEncoder().encode("x".repeat(PUBLIC_OAUTH_BODY_MAX_BYTES))
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        controller.close()
      },
    })
    const res = await buildApp().request("/mcp/oauth/token", {
      method: "POST",
      body: stream,
      duplex: "half",
    })
    expect(res.status).toBe(413)
  })

  it("lets a normal OAuth body through, and caps the MCP transport at its own ceiling", async () => {
    const ok = await buildApp().request("/mcp/oauth/token", { method: "POST", body: "a=b" })
    expect(ok.status).toBe(200)
    const tooBigForTransport = "x".repeat(MCP_TRANSPORT_BODY_MAX_BYTES + 1)
    const res = await buildApp().request("/mcp", { method: "POST", body: tooBigForTransport })
    expect(res.status).toBe(413)
    const fine = await buildApp().request("/mcp", { method: "POST", body: "x".repeat(2_000_000) })
    expect(fine.status).toBe(200)
  })
})

describe("public surface per-IP budgets", () => {
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.RATE_LIMIT_FORCE_ENABLED
    process.env.RATE_LIMIT_FORCE_ENABLED = "true"
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.RATE_LIMIT_FORCE_ENABLED
    else process.env.RATE_LIMIT_FORCE_ENABLED = prev
  })

  async function hit(path: string, ip: string, n: number): Promise<number[]> {
    const app = buildApp()
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const res = await app.request(path, {
        method: "POST",
        body: "a=b",
        headers: { "x-forwarded-for": ip },
      })
      out.push(res.status)
    }
    return out
  }

  it("throttles client registration before its body is parsed", async () => {
    const ip = randomIp()
    const statuses = await hit("/mcp/oauth/register", ip, 12)
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true)
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true)
  })

  it("throttles device-grant initiation, which inserts a row per call", async () => {
    const statuses = await hit("/mcp/device/initiate", randomIp(), 22)
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true)
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true)
  })

  it("throttles the login device-flow initiate, which also inserts a row per call", async () => {
    const statuses = await hit("/api/auth/device-flow/initiate", randomIp(), 22)
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true)
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true)
  })

  it("throttles token exchange and discovery per IP, independently per route", async () => {
    const ip = randomIp()
    const tokens = await hit("/mcp/oauth/token", ip, 62)
    expect(tokens.slice(60).every((s) => s === 429)).toBe(true)
    // Discovery is a different budget: still open for the same address.
    const wk = await buildApp().request("/.well-known/oauth-protected-resource", {
      headers: { "x-forwarded-for": ip },
    })
    expect(wk.status).toBe(200)
  })
})
