// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHmac } from "node:crypto"
import type { Context } from "hono"
import * as jose from "jose"
import { env } from "~/lib/env"
import { hostBindingEnabled } from "~/lib/org-host"
import { effectiveRequest } from "~/lib/request-context"

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

export async function signUiBundleToken(
  name: string,
  version: string,
  /** With org hosts: the host the URL is handed out on; the bundle loads there only. */
  host?: string | null,
): Promise<string> {
  const windowStart = Math.floor(Date.now() / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS
  return (
    new jose.SignJWT({ name, version, ...(host ? { host } : {}) })
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
  /** With org hosts: the request's host, which must be the one the token names. */
  host?: string | null,
): Promise<boolean> {
  if (!token) return false
  try {
    const { payload } = await jose.jwtVerify(token, bundleTokenKey(), {
      audience: AUDIENCE,
    })
    if (host !== undefined && (!host || payload.host !== host)) return false
    return payload.name === name && payload.version === version
  } catch {
    return false
  }
}

/** The host a bundle token is bound to on this request: undefined without org hosts. */
export function boundHost(c: Context): string | null | undefined {
  return hostBindingEnabled() ? effectiveRequest(c).host : undefined
}
