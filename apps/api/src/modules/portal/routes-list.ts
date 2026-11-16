// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE client portal's routes, all of them. A route under /api/portal that is not
// on this list fails the door test that compares it with the mounted route table,
// and a portal token gets 401 on every route outside it (and the public ones).
// Adding a portal route is adding a line here, on purpose.

export type PortalRouteMethod = "GET" | "POST"

export interface PortalRoute {
  method: PortalRouteMethod
  /** Full path, Hono style (`:id`). */
  path: string
  /** Who may call it: anyone (rate limited), the portal's refresh cookie, or a portal token. */
  access: "public" | "cookie" | "token"
}

export const PORTAL_PREFIX = "/api/portal"
export const PORTAL_AUTH_PREFIX = `${PORTAL_PREFIX}/auth`

const r = (
  method: PortalRouteMethod,
  path: string,
  access: PortalRoute["access"],
): PortalRoute => ({
  method,
  path: `${PORTAL_PREFIX}${path}`,
  access,
})

export const PORTAL_ROUTES: readonly PortalRoute[] = [
  r("POST", "/auth/request", "public"),
  r("POST", "/auth/verify", "public"),
  r("POST", "/auth/totp", "public"),
  r("GET", "/auth/branding/:slug", "public"),
  r("POST", "/auth/refresh", "cookie"),
  r("POST", "/auth/logout", "cookie"),
  r("GET", "/me", "token"),
  r("POST", "/me/notice-ack", "token"),
  r("POST", "/me/totp/setup", "token"),
  r("POST", "/me/totp/confirm", "token"),
  r("GET", "/home", "token"),
  r("GET", "/projects", "token"),
  r("GET", "/projects/:id", "token"),
  r("GET", "/projects/:id/reports", "token"),
  r("GET", "/invoices", "token"),
  r("GET", "/invoices/:id/pdf", "token"),
  r("GET", "/documents", "token"),
  r("GET", "/documents/:id", "token"),
  r("GET", "/documents/:id/pages/:n", "token"),
  r("POST", "/actions/:id/code", "token"),
  r("POST", "/actions/:id/decide", "token"),
  r("GET", "/requests", "token"),
  r("POST", "/requests", "token"),
  r("POST", "/requests/:id/reply", "token"),
  r("POST", "/requests/attachments", "token"),
  r("GET", "/files/:id", "token"),
]

/** The routes a portal token opens, as `METHOD path`. */
export const PORTAL_TOKEN_ROUTES: readonly string[] = PORTAL_ROUTES.filter(
  (x) => x.access === "token",
).map((x) => `${x.method} ${x.path}`)

/** The path below /api/portal, as the portal router registers it. */
export function routerPath(route: PortalRoute): string {
  return route.path.slice(PORTAL_PREFIX.length)
}
