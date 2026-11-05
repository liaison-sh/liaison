// SPDX-License-Identifier: FSL-1.1-ALv2
// POST /api/auth/password-reset/confirm is unauthenticated. A request whose
// token names no live reset must cost the server no password hash: argon2id
// runs on the shared thread pool, so a stream of junk confirms would otherwise
// buy an anonymous caller the CPU and memory of a full hash each.
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { app } from "~/app"
import * as crypto from "~/lib/crypto"

describe("password reset confirm with an unknown token", () => {
  const spy = spyOn(crypto, "hashPassword")
  afterEach(() => spy.mockClear())

  it("is refused without hashing the submitted password", async () => {
    const res = await app.request("/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "no-such-reset-token-0000000000000000",
        newPassword: "Correct-Horse-9",
      }),
    })
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("invite registration with an unknown invite token", () => {
  const spy = spyOn(crypto, "hashPassword")
  afterEach(() => spy.mockClear())

  it("is refused without hashing the submitted password (instance already bootstrapped)", async () => {
    const { createTestOrg } = await import("~/tests/helpers/org")
    const { acquireTestLock, releaseTestLock } = await import("~/tests/route-test-setup")
    await acquireTestLock()
    try {
      await createTestOrg()
      spy.mockClear()
      const res = await app.request("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inviteToken: "no-such-invite-token-000000000000",
          password: "Correct-Horse-9",
          name: "X",
        }),
      })
      expect(res.status).toBe(400)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      await releaseTestLock()
    }
  }, 60_000)
})
