// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { app } from "~/app"

describe("mail route mounting", () => {
  it("GET /api/mail/conversations returns 401 without auth", async () => {
    const res = await app.request("/api/mail/conversations")
    expect(res.status).toBe(401)
  })
})
