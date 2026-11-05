// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash, timingSafeEqual } from "node:crypto"
import type { Context } from "hono"
import { env } from "~/lib/env"
import { readCookie } from "~/lib/response"

/**
 * Bind an OAuth connect flow to the browser that started it.
 *
 * The provider redirects back to an UNAUTHENTICATED callback carrying only
 * `state`. Without a binding, anyone who can get a colleague to open an
 * authorize link they started (and have that colleague consent) lands the
 * colleague's grant on a connection the initiator owns. The login flow has
 * always bound its state to a cookie for the same reason (`__oauth_state`);
 * connect flows now do too: the start request (which IS authenticated) sets an
 * HttpOnly cookie holding a hash of the state, and the callback refuses unless
 * the same browser presents it. A different browser, which is what the
 * colleague opening a forwarded link is, has no such cookie.
 *
 * The desktop and mobile shells cannot hold this cookie (their fetch is cross
 * site, so it is never stored): an app connection they start is bound to the
 * shell instead (modules/apps/connections/shell-connect.ts).
 * `OAUTH_CONNECT_BROWSER_BINDING=false` is the documented opt-out, for a client
 * that can do neither.
 *
 * ONE COOKIE PER FLOW. The cookie's name carries a short hash of its state, so
 * two connects running side by side in one browser (a card in a conversation
 * and Settings) each keep their own binding instead of the second overwriting
 * the first. The value is still the full hash of the state, compared in
 * constant time: the name only says which cookie to read.
 */

export function connectBindingEnabled(): boolean {
  return env.OAUTH_CONNECT_BROWSER_BINDING
}

function digest(state: string): string {
  return createHash("sha256").update(state).digest("hex")
}

/**
 * The cookie actually used for a binding. In production it is a `__Host-`
 * cookie (https only, this exact host, no Domain, Path=/), so a sibling
 * subdomain cannot plant a binding for a flow it started into a victim's
 * browser. Over development http the plain name, scoped to the callback path.
 */
export function bindingCookie(
  baseName: string,
  callbackPath: string,
  isProd: boolean = env.NODE_ENV === "production",
  /** The flow's state: the cookie is named per flow (see above). */
  state?: string,
): { name: string; path: string } {
  const flow = state === undefined ? baseName : `${baseName}_${digest(state).slice(0, 16)}`
  return isProd
    ? { name: `__Host-${flow.replace(/^_+/, "")}`, path: "/" }
    : { name: flow, path: callbackPath }
}

export function setConnectBindingCookie(
  c: Context,
  cookieName: string,
  callbackPath: string,
  state: string,
): void {
  const cookie = bindingCookie(cookieName, callbackPath, env.NODE_ENV === "production", state)
  const secure = env.NODE_ENV === "production" ? "; Secure" : ""
  c.header(
    "Set-Cookie",
    `${cookie.name}=${digest(state)}; HttpOnly; SameSite=Lax; Path=${cookie.path}; Max-Age=600${secure}`,
    { append: true },
  )
}

export function connectBindingMatches(
  cookieHeader: string | undefined,
  cookieName: string,
  state: string,
  isProd: boolean = env.NODE_ENV === "production",
): boolean {
  // The callback path does not matter for the name; only the name is read.
  const name = bindingCookie(cookieName, "/", isProd, state).name
  const presented = readCookie(cookieHeader, name)
  if (!presented || !/^[a-f0-9]{64}$/.test(presented)) return false
  return timingSafeEqual(Buffer.from(presented, "hex"), Buffer.from(digest(state), "hex"))
}
