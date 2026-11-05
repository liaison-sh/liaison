// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The first registration on a fresh instance needs the one-time setup token
// (otherwise the first stranger to arrive would become admin).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import {
  expectedSetupToken,
  SetupTokenTestAccess,
  setupTokenMatches,
} from "~/modules/auth/setup-token"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

function register(body: Record<string, unknown>) {
  return app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Owner", email: "owner@example.com", ...body }),
  })
}

describe("setup token", () => {
  it("is stable, secret-derived and matched in constant time", () => {
    const t = expectedSetupToken()
    expect(t).toMatch(/^[0-9a-f]{32}$/)
    expect(expectedSetupToken()).toBe(t)
    expect(setupTokenMatches(t)).toBe(true)
    expect(setupTokenMatches(`${t} `)).toBe(true)
    expect(setupTokenMatches("nope")).toBe(false)
    expect(setupTokenMatches(undefined)).toBe(false)
  })
})

describe("POST /api/auth/register on a fresh instance", () => {
  beforeAll(acquireTestLock, 60_000)
  afterAll(releaseTestLock)
  afterEach(() => SetupTokenTestAccess.setRequired(null))

  it("reports whether the token is required", async () => {
    SetupTokenTestAccess.setRequired(true)
    const res = await app.request("/api/auth/bootstrap-state")
    expect(await res.json()).toEqual({ data: { bootstrapped: false, setupTokenRequired: true } })
  })

  it("refuses the first registration without the token", async () => {
    SetupTokenTestAccess.setRequired(true)
    expect((await register({})).status).toBe(403)
    expect((await register({ setupToken: "wrong" })).status).toBe(403)
    const state = await app.request("/api/auth/bootstrap-state")
    expect(((await state.json()) as { data: { bootstrapped: boolean } }).data.bootstrapped).toBe(
      false,
    )
  })

  it("accepts it with the token, and the instance is then bootstrapped", async () => {
    SetupTokenTestAccess.setRequired(true)
    const res = await register({ setupToken: expectedSetupToken() })
    expect(res.status).toBe(200)
    const state = await app.request("/api/auth/bootstrap-state")
    expect(await state.json()).toEqual({ data: { bootstrapped: true, setupTokenRequired: false } })
  })
})
