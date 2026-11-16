// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/portal/auth: the client portal's sign-in. Public routes, rate limited per
// address (public-surface-limits.ts), small bodies, and no member credential is
// read or accepted here. Secrets travel in POST bodies only (the mailed link
// carries them in its fragment), and the refresh cookie is the portal's own.

import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { parseOriginAllowlist } from "~/lib/app-origins"
import { env } from "~/lib/env"
import { authLogger as log } from "~/lib/logger"
import { requestHostBinding } from "~/lib/org-host"
import { effectiveRequest, getClientIp } from "~/lib/request-context"
import { readCookie, success } from "~/lib/response"
import { padToResponseFloor } from "~/lib/response-timing"
import { zValidator } from "~/lib/validate"
import {
  AuthServiceError,
  InvalidSessionError,
  logout,
  PORTAL_SESSION_IDLE_MS,
  RefreshRaceError,
  refreshSession,
  type TokenPair,
} from "~/modules/auth/auth"
import {
  portalBranding,
  requestPortalSignIn,
  sameString,
  verifyPortalSignIn,
  verifyPortalTotp,
} from "~/modules/portal/auth-service"

/** The portal's refresh cookie: never the member's, never readable by script. */
export const PORTAL_REFRESH_COOKIE = "__Host-liaison_portal_rt"

function setPortalCookie(c: Context, token: string): void {
  c.header(
    "Set-Cookie",
    `${PORTAL_REFRESH_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(PORTAL_SESSION_IDLE_MS / 1000)}`,
  )
}

function clearPortalCookie(c: Context): void {
  c.header(
    "Set-Cookie",
    `${PORTAL_REFRESH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  )
}

/** The answer of a sign-in that minted: the portal token, the refresh token in the cookie only. */
function signedIn(c: Context, tokens: TokenPair) {
  setPortalCookie(c, tokens.refreshToken)
  return success(c, { accessToken: tokens.accessToken })
}

/** The one refusal of every sign-in step: same status, same body, whatever went wrong. */
function refused(c: Context) {
  return c.json({ error: { message: "This link or code no longer works" } }, 401)
}

/**
 * A cookie route (refresh, logout) answers only a request from one of this
 * instance's own web origins: the Origin header must be present and listed.
 * SameSite=Strict already keeps the cookie off a cross-site request; this is the
 * second lock.
 */
export function portalOriginAllowed(c: Context): boolean {
  const origin = c.req.header("origin")
  if (!origin) return false
  const binding = requestHostBinding(c)
  const allowed = [
    ...env.ALLOWED_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter((o) => o && o !== "*"),
    ...parseOriginAllowlist(env.LIAISON_APP_ORIGINS),
    ...(binding.kind === "org" ? [binding.origin] : []),
  ]
  return allowed.some((o) => sameString(o, origin))
}

const requestSchema = z.object({
  orgSlug: z.string().min(1).max(100),
  email: z.string().email().max(320),
})
const verifySchema = z.object({
  challengeId: z.string().min(1).max(200),
  token: z.string().min(1).max(200),
})
const totpSchema = z.object({
  challengeToken: z.string().min(1).max(200),
  code: z.string().regex(/^\d{6}$/),
})

export const portalAuthRoutes = new Hono<AppEnv>()
  // Same reply for every address, padded to the same time; the mail is not awaited.
  .post("/request", zValidator("json", requestSchema), async (c) => {
    const startedAt = performance.now()
    const { orgSlug, email } = c.req.valid("json")
    try {
      await requestPortalSignIn(orgSlug, email)
    } catch (err) {
      log.error({ err }, "portal sign-in request failed")
    }
    await padToResponseFloor(startedAt)
    return success(c, { requested: true })
  })
  // The portal page posts the link's fragment here, on a click: a scanner's GET
  // of the page reaches no route, and opening the page uses nothing up.
  .post("/verify", zValidator("json", verifySchema), async (c) => {
    try {
      const result = await verifyPortalSignIn({
        ...c.req.valid("json"),
        host: effectiveRequest(c).host ?? undefined,
      })
      if ("totpRequired" in result) return success(c, result)
      return signedIn(c, result)
    } catch (err) {
      if (err instanceof AuthServiceError) return refused(c)
      throw err
    }
  })
  .post("/totp", zValidator("json", totpSchema), async (c) => {
    try {
      const tokens = await verifyPortalTotp({ ...c.req.valid("json"), ip: getClientIp(c) })
      return signedIn(c, tokens)
    } catch (err) {
      if (err instanceof AuthServiceError) {
        return err.status === 429
          ? c.json({ error: { message: "Too many attempts" } }, 429)
          : refused(c)
      }
      throw err
    }
  })
  .get("/branding/:slug", async (c) => success(c, await portalBranding(c.req.param("slug"))))
  .post("/refresh", async (c) => {
    if (!portalOriginAllowed(c)) {
      clearPortalCookie(c)
      return c.json({ error: { message: "Invalid session" } }, 401)
    }
    const token = readCookie(c.req.header("cookie"), PORTAL_REFRESH_COOKIE)
    if (!token) return c.json({ error: { message: "Invalid session" } }, 401)
    try {
      const tokens = await refreshSession(token, {
        userAgent: c.req.header("User-Agent"),
        kind: "portal",
      })
      return signedIn(c, tokens)
    } catch (err) {
      if (err instanceof RefreshRaceError) {
        return c.json(
          { error: { message: "Refreshed by another tab; retry", code: "REFRESH_RACE" } },
          409,
        )
      }
      if (!(err instanceof InvalidSessionError || err instanceof AuthServiceError)) throw err
      clearPortalCookie(c)
      return c.json({ error: { message: "Invalid session" } }, 401)
    }
  })
  .post("/logout", async (c) => {
    if (!portalOriginAllowed(c)) return c.json({ error: { message: "Invalid session" } }, 401)
    const token = readCookie(c.req.header("cookie"), PORTAL_REFRESH_COOKIE)
    if (token) await logout(token)
    clearPortalCookie(c)
    return success(c, { signedOut: true })
  })
