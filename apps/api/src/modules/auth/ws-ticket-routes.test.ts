// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { redis } from "~/lib/redis"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("ws-ticket route", () => {
  let accessToken: string

  beforeAll(async () => {
    await acquireTestLock()

    // Bootstrap to get an authenticated session
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "ws-ticket-test@test.com",
        password: "testpass123",
        name: "WS Test User",
      }),
    })
    const body = (await res.json()) as any
    accessToken = body.data.accessToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("returns a hex ticket for authenticated requests", async () => {
    const res = await app.request("/api/auth/ws-ticket", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.ticket).toBeDefined()
    expect(body.data.ticket).toMatch(/^[0-9a-f]{64}$/)

    // Verify Redis key exists with TTL
    const key = `ws-ticket:${body.data.ticket}`
    const stored = await redis.get(key)
    expect(stored).not.toBeNull()
    const payload = JSON.parse(stored!)
    expect(payload.userId).toBeDefined()
    expect(payload.orgId).toBeDefined()
    expect(payload.scopes).toBeArray()
    expect(payload.dimensionGrants).toBeDefined()
    expect(payload.authVersion).toBeNumber()
    expect(payload.permissionVersion).toBeNumber()

    const ttl = await redis.ttl(key)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(30)
  })

  it("rejects unauthenticated requests with 401", async () => {
    const res = await app.request("/api/auth/ws-ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
    expect(res.status).toBe(401)
  })

  it("ticket is consumed after first use (single-use via GETDEL)", async () => {
    // Issue a ticket via POST
    const res = await app.request("/api/auth/ws-ticket", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const ticket = body.data.ticket

    // Verify the ticket exists in Redis
    const key = `ws-ticket:${ticket}`
    const stored = await redis.get(key)
    expect(stored).not.toBeNull()

    // Simulate consumption via GETDEL (what the WS upgrade handler does)
    const consumed = await redis.getdel(key)
    expect(consumed).not.toBeNull()
    const payload = JSON.parse(consumed!)
    expect(payload.userId).toBeDefined()

    // Second GETDEL returns null — ticket is single-use
    const second = await redis.getdel(key)
    expect(second).toBeNull()
  })
})
