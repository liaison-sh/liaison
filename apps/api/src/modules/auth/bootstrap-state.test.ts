// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { app } from "~/app"
import { bootstrapRegister } from "~/modules/auth/auth"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("GET /api/auth/bootstrap-state", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  test("returns bootstrapped:false on a fresh instance", async () => {
    const res = await app.request("/api/auth/bootstrap-state")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { bootstrapped: false, setupTokenRequired: false } })
  })

  test("returns bootstrapped:true after an org exists", async () => {
    await bootstrapRegister("x@t.co", "Passw0rd!", "X")
    const res = await app.request("/api/auth/bootstrap-state")
    expect(await res.json()).toEqual({ data: { bootstrapped: true, setupTokenRequired: false } })
  })
})
