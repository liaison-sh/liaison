// SPDX-License-Identifier: FSL-1.1-ALv2
import { timingSafeEqual } from "node:crypto"
import { createMiddleware } from "hono/factory"

// Constant-time bearer compare. Different byte-lengths short-circuit (no
// timing channel because the result is deterministically false for any input
// of a different length than the configured key — comparing same-length buffers
// is the part timingSafeEqual protects).
function bearerEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8")
  const b = Buffer.from(expected, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function requireControlPlaneAuth(apiKey: string | undefined) {
  return createMiddleware(async (c, next) => {
    if (!apiKey) {
      return c.json({ error: { message: "not found", code: "not_found" } }, 404)
    }
    const auth = c.req.header("authorization") ?? ""
    const m = /^bearer\s+(.+)$/i.exec(auth)
    if (!m || !bearerEquals(m[1], apiKey)) {
      // Log presence + a short non-reversible fingerprint of the rejected
      // token, never any prefix of the secret material itself. The
      // fingerprint distinguishes repeated bad tokens for incident triage
      // without writing bytes from a shared symmetric secret into logs.
      const fingerprint = m ? hash8(m[1]) : "<missing>"
      console.warn(
        JSON.stringify({
          evt: "control_plane_auth_reject",
          tokenFingerprint: fingerprint,
        }),
      )
      return c.json({ error: { message: "unauthorized", code: "unauthorized" } }, 401)
    }
    await next()
  })
}

// 32-bit FNV-1a over the rejected token; not a cryptographic primitive but
// adequate for grouping repeated bad-token attempts without revealing bytes.
function hash8(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}
