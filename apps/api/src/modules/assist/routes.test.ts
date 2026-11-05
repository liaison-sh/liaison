// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("POST /api/assist/proofread", () => {
  let token: string
  beforeAll(async () => {
    await acquireTestLock()
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "wand@test.com", password: "testpass123", name: "Wand" }),
    })
    token = ((await res.json()) as { data: { accessToken: string } }).data.accessToken
  })
  afterAll(async () => releaseTestLock())

  const auth = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` })

  it("requires auth", async () => {
    const res = await app.request("/api/assist/proofread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi", format: "text" }),
    })
    expect(res.status).toBe(401)
  })

  it("400s on a bad format", async () => {
    const res = await app.request("/api/assist/proofread", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ text: "hi", format: "markdown" }),
    })
    expect(res.status).toBe(400)
  })

  it("returns whitespace text unchanged without invoking a model", async () => {
    const res = await app.request("/api/assist/proofread", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ text: "   ", format: "text" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { text: string } }
    expect(body.data.text).toBe("   ")
  })
})
