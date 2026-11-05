// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { fileTypeFromBuffer } from "file-type"
import sharp from "sharp"
import { app } from "~/app"
import { MAX_AVATAR_UPLOAD_BYTES } from "~/modules/users/avatar-image"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

async function makePng(width = 32, height = 32): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 150, b: 90 } },
  })
    .png()
    .toBuffer()
}

const keyOf = (avatarUrl: string) => avatarUrl.split("/").pop() ?? ""

describe("profile picture (avatar) endpoints", () => {
  let token: string

  beforeAll(async () => {
    await acquireTestLock()
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "avatar@test.com",
        password: "testpass123",
        name: "Ada Lovelace",
      }),
    })
    token = ((await res.json()) as any).data.accessToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  async function uploadAvatar(png: Buffer) {
    return app.request("/api/users/me/avatar", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" },
      body: png,
    })
  }

  it("a fresh user has no avatar (initials fallback)", async () => {
    const res = await app.request("/api/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = (await res.json()) as any
    expect(body.data.avatarUrl ?? null).toBeNull()
  })

  it("uploads a PNG, stores a webp, and serves it on the PUBLIC (no-auth) route", async () => {
    const res = await uploadAvatar(await makePng())
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const url: string = body.data.avatarUrl
    expect(url).toMatch(/^\/api\/avatars\/[A-Za-z0-9_-]{16,64}$/)

    // The serving route carries NO Authorization header — the key IS the
    // capability — and returns the normalized webp bytes.
    const served = await app.request(`/api/avatars/${keyOf(url)}`)
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toBe("image/webp")
    expect(served.headers.get("x-content-type-options")).toBe("nosniff")
    const bytes = Buffer.from(await served.arrayBuffer())
    const sniff = await fileTypeFromBuffer(bytes)
    expect(sniff?.mime).toBe("image/webp")
  })

  it("rejects a non-image body with 400", async () => {
    const res = await app.request("/api/users/me/avatar", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" },
      body: Buffer.from("this is definitely not an image"),
    })
    expect(res.status).toBe(400)
  })

  it("rejects an oversized body with 413", async () => {
    const res = await app.request("/api/users/me/avatar", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" },
      body: Buffer.alloc(MAX_AVATAR_UPLOAD_BYTES + 1024, 1),
    })
    expect(res.status).toBe(413)
  })

  it("requires authentication to upload", async () => {
    const res = await app.request("/api/users/me/avatar", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: await makePng(),
    })
    expect(res.status).toBe(401)
  })

  it("rotates the key on replace; the old capability URL stops resolving", async () => {
    const first = (await (await uploadAvatar(await makePng(40, 40))).json()) as any
    const firstKey = keyOf(first.data.avatarUrl)
    const second = (await (await uploadAvatar(await makePng(48, 48))).json()) as any
    const secondKey = keyOf(second.data.avatarUrl)

    expect(secondKey).not.toBe(firstKey)
    expect((await app.request(`/api/avatars/${firstKey}`)).status).toBe(404)
    expect((await app.request(`/api/avatars/${secondKey}`)).status).toBe(200)
  })

  it("removes the avatar, returning to the initials fallback", async () => {
    const up = (await (await uploadAvatar(await makePng())).json()) as any
    const key = keyOf(up.data.avatarUrl)

    const del = await app.request("/api/users/me/avatar", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(del.status).toBe(200)
    const body = (await del.json()) as any
    expect(body.data.avatarUrl ?? null).toBeNull()
    expect((await app.request(`/api/avatars/${key}`)).status).toBe(404)
  })

  it("404s a malformed avatar key without touching the DB", async () => {
    // Too short to be a capability key -> rejected by the format guard.
    expect((await app.request("/api/avatars/tooshort")).status).toBe(404)
  })
})
