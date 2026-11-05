// SPDX-License-Identifier: FSL-1.1-ALv2
import { fileTypeFromBuffer } from "file-type"
import sharp from "sharp"

/**
 * Raster image types accepted for profile pictures. SVG is deliberately absent:
 * it is a scriptable/XSS vector and is never a valid avatar. The decision is
 * made on magic bytes (see {@link validateAvatarBytes}), not the client-declared
 * MIME, so a `.png`-named script or a spoofed Content-Type is rejected.
 */
export const AVATAR_ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const
export type AvatarAllowedMime = (typeof AVATAR_ALLOWED_MIME_TYPES)[number]

/** Hard cap on the raw upload body, enforced before any decode work runs. */
export const MAX_AVATAR_UPLOAD_BYTES = 5 * 1024 * 1024

/** Largest stored dimension. Avatars render at <= 40px; 512 covers retina + zoom. */
export const AVATAR_MAX_DIMENSION = 512

/** Content type every normalized avatar is stored + served as. */
export const AVATAR_STORED_MIME = "image/webp"

export type AvatarValidation = { ok: true; mime: AvatarAllowedMime } | { ok: false; reason: string }

/**
 * Sniff the real content type by magic bytes and accept only the raster-image
 * allowlist. Returns a structured result (never throws) so the route can map a
 * rejection to a 4xx with a specific reason.
 */
export async function validateAvatarBytes(bytes: Uint8Array): Promise<AvatarValidation> {
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" }
  const sniffed = await fileTypeFromBuffer(bytes)
  // file-type returns undefined for text-based payloads (incl. SVG) and unknown
  // binaries — treat all of those as "not a supported image".
  if (!sniffed) return { ok: false, reason: "unrecognized" }
  if (!(AVATAR_ALLOWED_MIME_TYPES as readonly string[]).includes(sniffed.mime)) {
    return { ok: false, reason: `unsupported:${sniffed.mime}` }
  }
  return { ok: true, mime: sniffed.mime as AvatarAllowedMime }
}

/**
 * Re-encode the validated image to a bounded webp. Re-encoding is a security
 * measure as much as a size one: it strips EXIF/metadata and any embedded
 * exploit payload, auto-orients by the original EXIF orientation, and caps the
 * largest dimension to {@link AVATAR_MAX_DIMENSION} without ever enlarging a
 * smaller source. Always returns webp bytes.
 */
export async function normalizeAvatar(bytes: Uint8Array): Promise<Buffer> {
  return sharp(bytes, { failOn: "error" })
    .rotate()
    .resize(AVATAR_MAX_DIMENSION, AVATAR_MAX_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 82 })
    .toBuffer()
}
