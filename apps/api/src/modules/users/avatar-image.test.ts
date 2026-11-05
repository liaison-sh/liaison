// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import sharp from "sharp"
import {
  AVATAR_MAX_DIMENSION,
  normalizeAvatar,
  validateAvatarBytes,
} from "~/modules/users/avatar-image"

// Real 1x1 transparent GIF89a (magic "GIF89a") — sharp cannot always encode GIF,
// so we embed a known-good sample for the sniff allowlist test.
const TINY_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")

async function makePng(width = 8, height = 8): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer()
}

async function makeJpeg(width = 8, height = 8): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 90 } },
  })
    .jpeg()
    .toBuffer()
}

async function makeWebp(width = 8, height = 8): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 200, b: 60 } },
  })
    .webp()
    .toBuffer()
}

describe("validateAvatarBytes", () => {
  it("accepts a real PNG (sniffed by magic bytes)", async () => {
    const res = await validateAvatarBytes(await makePng())
    expect(res).toEqual({ ok: true, mime: "image/png" })
  })

  it("accepts a real JPEG", async () => {
    const res = await validateAvatarBytes(await makeJpeg())
    expect(res).toEqual({ ok: true, mime: "image/jpeg" })
  })

  it("accepts a real WEBP", async () => {
    const res = await validateAvatarBytes(await makeWebp())
    expect(res).toEqual({ ok: true, mime: "image/webp" })
  })

  it("accepts a real GIF", async () => {
    const res = await validateAvatarBytes(TINY_GIF)
    expect(res).toEqual({ ok: true, mime: "image/gif" })
  })

  it("rejects an SVG (scriptable vector, not a raster image)", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    )
    const res = await validateAvatarBytes(svg)
    expect(res.ok).toBe(false)
  })

  it("rejects plain text even if it claims to be an image", async () => {
    const res = await validateAvatarBytes(Buffer.from("this is not an image"))
    expect(res.ok).toBe(false)
  })

  it("rejects an empty body", async () => {
    const res = await validateAvatarBytes(new Uint8Array(0))
    expect(res).toEqual({ ok: false, reason: "empty" })
  })
})

describe("normalizeAvatar", () => {
  it("re-encodes to webp and caps the largest dimension", async () => {
    const big = await makePng(1200, 900)
    const out = await normalizeAvatar(big)

    // Output must itself be a valid webp.
    const sniff = await validateAvatarBytes(out)
    expect(sniff).toEqual({ ok: true, mime: "image/webp" })

    const meta = await sharp(out).metadata()
    expect(meta.format).toBe("webp")
    expect(meta.width).toBeLessThanOrEqual(AVATAR_MAX_DIMENSION)
    expect(meta.height).toBeLessThanOrEqual(AVATAR_MAX_DIMENSION)
    // Aspect ratio preserved: 1200x900 -> 512x384.
    expect(meta.width).toBe(AVATAR_MAX_DIMENSION)
    expect(meta.height).toBe(384)
  })

  it("does not enlarge a small source", async () => {
    const small = await makeJpeg(64, 64)
    const out = await normalizeAvatar(small)
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(64)
    expect(meta.height).toBe(64)
    expect(meta.format).toBe("webp")
  })

  it("rejects garbage bytes (not a decodable image)", async () => {
    await expect(normalizeAvatar(Buffer.from("definitely not an image"))).rejects.toThrow()
  })
})
