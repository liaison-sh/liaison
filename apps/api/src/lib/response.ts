// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE REFRESH TOKEN'S DELIVERY, AND THE ONE TRADE IN IT.
//
// In a browser the refresh token never touches JavaScript: it lives in the
// HttpOnly refresh cookie, SameSite=Strict (`__Host-liaison_rt` in production,
// `liaison_rt` scoped to /api/auth elsewhere, see refreshCookieSpec). That is
// the right shape there and nothing below changes it.
//
// A wrapped shell is not a browser tab. apps/web inside Capacitor is served
// from `capacitor://localhost` and inside Tauri from `tauri://localhost`, so
// EVERY call it makes to the user's server is cross site: a SameSite=Strict
// cookie is never attached to any of them. The session therefore died at the
// first access-token expiry, and the push client could never mint the bearer
// its two token calls need. The cookie was not protecting anything in that
// build; it was simply never sent.
//
// So for a request whose `Origin` is on the APP allowlist (lib/app-origins.ts,
// `LIAISON_APP_ORIGINS`, whose entries are the shells' own fixed schemes) the
// auth routes answer with the refresh token IN THE BODY and set no cookie at
// all, and /api/auth/refresh accepts that token back in the `X-Liaison-Refresh`
// header. Rotation and revocation are untouched: it is the same token, through
// the same `refreshSession`.
//
// THE TRADE, STATED: on those origins the token leaves the httpOnly cookie and
// becomes readable by script in the page. What makes that acceptable here and
// nowhere else is WHOSE page it is: `capacitor://localhost`,
// `tauri://localhost` and, on Windows, `http://tauri.localhost` serve the
// shell's OWN bundle, from local files, with no third-party script and no
// attacker-navigable origin behind them (a host an attacker registers cannot
// be one of them: the allowlist match is exact, and `.localhost` is reserved
// for the machine itself). A browser origin never takes this path, whatever it claims: the
// decision reads the allowlist, never a header the caller chose freely beyond
// the origin the user agent itself stamps.
import type { Context } from "hono"
import type { StatusCode } from "hono/utils/http-status"
import { parseOriginAllowlist, resolveCorsOrigin } from "~/lib/app-origins"
import { env } from "~/lib/env"

const IS_PROD = env.NODE_ENV === "production"
const REFRESH_TOKEN_MAX_AGE = 30 * 24 * 60 * 60 // 30 days in seconds

/** The header a shell presents its stored refresh token in. */
export const REFRESH_TOKEN_HEADER = "X-Liaison-Refresh"

/** A refresh token is longer than this only if something built it wrong. */
const MAX_REFRESH_TOKEN_LENGTH = 512

/**
 * Name and path of the refresh cookie. In production it is a `__Host-` cookie:
 * the browser only accepts it from this exact host, over https, with no Domain
 * and Path=/, so a sibling subdomain cannot plant ("toss") a refresh token of
 * its own choosing into this origin and sign the browser into another account.
 * Development and tests run over plain http, where `__Host-` is refused, and
 * keep the plain name scoped to /api/auth.
 */
export function refreshCookieSpec(isProd: boolean): { name: string; path: string } {
  return isProd
    ? { name: "__Host-liaison_rt", path: "/" }
    : { name: "liaison_rt", path: "/api/auth" }
}
/**
 * Whether cookies are `__Host-` (Secure, Path=/, no Domain): in production, and
 * wherever orgs have their own hosts (LIAISON_ORG_HOST_TEMPLATE), so one org's
 * host can never plant or read a cookie of another's. Read per call.
 */
export function hostOnlyCookies(): boolean {
  return IS_PROD || Boolean(env.LIAISON_ORG_HOST_TEMPLATE)
}
const refreshCookie = () => refreshCookieSpec(hostOnlyCookies())
/** The pre-`__Host-` production cookie, cleared wherever the new one is written. */
const LEGACY_REFRESH_COOKIE =
  "liaison_rt=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0"

export function setRefreshTokenCookie(c: Context, refreshToken: string): void {
  c.header(
    "Set-Cookie",
    `${refreshCookie().name}=${refreshToken}; HttpOnly; ${hostOnlyCookies() ? "Secure; " : ""}SameSite=Strict; Path=${refreshCookie().path}; Max-Age=${REFRESH_TOKEN_MAX_AGE}`,
  )
  if (IS_PROD) c.header("Set-Cookie", LEGACY_REFRESH_COOKIE, { append: true })
}

export function clearRefreshTokenCookie(c: Context): void {
  c.header(
    "Set-Cookie",
    `${refreshCookie().name}=; HttpOnly; ${hostOnlyCookies() ? "Secure; " : ""}SameSite=Strict; Path=${refreshCookie().path}; Max-Age=0`,
  )
  if (IS_PROD) c.header("Set-Cookie", LEGACY_REFRESH_COOKIE, { append: true })
}

/** One cookie's value by exact name (no prefix or suffix match), or undefined. */
export function readCookie(cookie: string | undefined, name: string): string | undefined {
  if (!cookie || cookie.length > 4096) return undefined
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim()
      return value === "" ? undefined : value
    }
  }
  return undefined
}

/**
 * The refresh token from a Cookie header, read under `name` only (by default
 * this deployment's refresh cookie). In production a plain `liaison_rt` is
 * never read: anyone controlling a sibling subdomain can set that one.
 */
export function getRefreshTokenFromCookie(
  cookie: string | undefined,
  name: string = refreshCookie().name,
): string | undefined {
  return readCookie(cookie, name)
}

/** The token a shell presented in `X-Liaison-Refresh`, if it presented one. */
export function getRefreshTokenFromHeader(value: string | undefined): string | undefined {
  if (!value || value.length > MAX_REFRESH_TOKEN_LENGTH) return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** Where an answer's refresh token goes. Both false is never a valid session. */
export interface RefreshTokenDelivery {
  cookie: boolean
  body: boolean
}

/**
 * PURE, so the rule is provable without a request: an app origin is answered
 * in the body and gets no cookie; everything else keeps the cookie, and adds
 * the body copy only under the existing `EXPOSE_REFRESH_TOKEN_IN_BODY` escape
 * hatch for non-browser clients (refused in production by lib/env.ts).
 */
export function refreshTokenDelivery(
  origin: string | undefined,
  appOrigins: string[],
  exposeInBody: boolean,
): RefreshTokenDelivery {
  if (origin !== undefined && resolveCorsOrigin(origin, appOrigins) !== null) {
    return { cookie: false, body: true }
  }
  return { cookie: true, body: exposeInBody }
}

/**
 * Whether this request came from one of the shells' own origins. The refresh
 * HEADER and the OAuth exchange's body token are both answers to that question
 * alone, so it is asked once here rather than inferred from a delivery shape.
 */
export function isAppOriginRequest(c: Context): boolean {
  const origin = c.req.header("origin")
  if (origin === undefined) return false
  return resolveCorsOrigin(origin, parseOriginAllowlist(env.LIAISON_APP_ORIGINS)) !== null
}

/** The same decision for a live request, against the configured allowlist. */
export function requestRefreshTokenDelivery(c: Context): RefreshTokenDelivery {
  return refreshTokenDelivery(
    c.req.header("origin"),
    parseOriginAllowlist(env.LIAISON_APP_ORIGINS),
    env.EXPOSE_REFRESH_TOKEN_IN_BODY,
  )
}

export function success<T>(
  c: Context,
  data: T,
  meta?: Record<string, unknown>,
  status?: StatusCode,
) {
  return c.json(meta ? { data, meta } : { data }, (status ?? 200) as any)
}

export function paginated<T>(
  c: Context,
  data: T[],
  opts: { page?: number; limit: number; total: number; nextCursor?: string | null },
) {
  return c.json({ data, meta: opts })
}
