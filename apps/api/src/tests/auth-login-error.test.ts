// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { app } from "~/app"

describe("POST /api/auth/login error handling", () => {
  it("returns auth service errors without masking them", async () => {
    // Send wrong password to a non-existent user — should get 401
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nonexistent@test.com", password: "wrongpass123!" }),
    })

    expect(res.status).toBe(401)
    const body = (await res.json()) as any
    expect(body.error.message).toBe("Invalid credentials")
  })

  it("returns structured error envelope on bad request", async () => {
    // Missing required password field
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@test.com" }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error).toBeDefined()
    expect(body.error.message).toBeDefined()
  })

  it("returns 401 for wrong password on existing user", async () => {
    // Bootstrap creates admin@test.com — try wrong password
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "definitely-wrong-pwd!" }),
    })

    expect(res.status).toBe(401)
    const body = (await res.json()) as any
    expect(body.error.message).toBe("Invalid credentials")
  })
})
