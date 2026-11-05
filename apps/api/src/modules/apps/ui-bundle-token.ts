// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHmac } from "node:crypto"
import * as jose from "jose"
import { env } from "~/lib/env"

/**
 * Capability token for the bundle URL of an installed (non-first-party) app.
 *
 * The browser loads `ui.js` with `import()`, which cannot send the bearer
 * header, so the route cannot see a session. The authenticated app-list
 * endpoint therefore hands out the URL with a short-lived token bound to ONE
 * app and version, and the route serves a non-first-party bundle only against
 * it. Anonymous callers can no longer probe which custom apps an instance runs,
 * nor read their client code.
 *
 * The token is deterministic inside a window (issued-at is the window start),
 * so repeated list calls in one window give the same URL and the browser's
 * module cache sees one module, not one per call.
 */
const AUDIENCE = "ui-bundle"
const WINDOW_SECONDS = 30 * 60

/** A key of its own, derived from JWT_SECRET: a bundle token can never verify
 *  as a session token (or anything else signed with the session key). */
function bundleTokenKey(): Uint8Array {
  return new Uint8Array(
    createHmac("sha256", env.JWT_SECRET).update("liaison:ui-bundle-token:v1").digest(),
  )
}

export async function signUiBundleToken(name: string, version: string): Promise<string> {
  const windowStart = Math.floor(Date.now() / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS
  return (
    new jose.SignJWT({ name, version })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(windowStart)
      // Valid for two windows so a URL handed out at the end of one still loads.
      .setExpirationTime(windowStart + 2 * WINDOW_SECONDS)
      .setAudience(AUDIENCE)
      .sign(bundleTokenKey())
  )
}

export async function verifyUiBundleToken(
  token: string | undefined,
  name: string,
  version: string,
): Promise<boolean> {
  if (!token) return false
  try {
    const { payload } = await jose.jwtVerify(token, bundleTokenKey(), {
      audience: AUDIENCE,
    })
    return payload.name === name && payload.version === version
  } catch {
    return false
  }
}
