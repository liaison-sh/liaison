// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("POST /api/auth/register (bootstrap)", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("first user creates org and admin role (bootstrap)", async () => {
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin@test.com",
        password: "testpass123",
        name: "Admin",
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any as any
    expect(body.data.accessToken).toBeDefined()
    // In non-production, refreshToken is still in body for test tooling
    expect(body.data.refreshToken).toBeDefined()
  })

  it("second registration without invite is rejected", async () => {
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "rogue@test.com",
        password: "testpass123",
        name: "Rogue",
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as any as any
    expect(body.error.message).toContain("Invitation required")
  })

  it("rejects registration with short password", async () => {
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test@test.com",
        password: "short",
        name: "Test",
      }),
    })
    expect(res.status).toBe(400)
  })
})
