// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The portal's bearer check. A portal token (audience `portal`) and nothing else
// opens /api/portal/*: a member's access token, an MCP token or a tampered token
// gets the one 401. The token names a person, never a company: every data route
// then runs under withPortalContext, where portal.me (an active external row)
// decides, so a member row never reads anything even if it held a portal token.
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { portalAvailable } from "~/db/portal-rls"
import { rootLogger } from "~/lib/logger"
import { hostAllowsOrg } from "~/lib/org-host"
import { getUserAuthState } from "~/modules/auth/auth-state"
import { verifyPortalToken } from "~/modules/auth/jwt"
import { isSessionRevoked } from "~/modules/auth/session-revocation"
import { PORTAL_PREFIX } from "~/modules/portal/routes-list"

/** The only routes an enrolment-only token opens. */
const ENROLMENT_PATHS = new Set([
  `${PORTAL_PREFIX}/me/totp/setup`,
  `${PORTAL_PREFIX}/me/totp/confirm`,
])

function refuse(path: string, reason: string): never {
  rootLogger.warn({ path, reason }, "portal auth failure")
  throw new HTTPException(401, { message: "Unauthorized" })
}

/** With no portal login in this process (logins not split), every portal route answers 503. */
export const portalAvailableGate = createMiddleware<AppEnv>(async (c, next) => {
  if (!portalAvailable()) {
    return c.json({ error: { message: "The client portal is not available" } }, 503)
  }
  await next()
})

export function portalAuthMiddleware(secret: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("Authorization")
    if (!header?.startsWith("Bearer ")) refuse(c.req.path, "missing_bearer")
    let payload: Awaited<ReturnType<typeof verifyPortalToken>>
    try {
      payload = await verifyPortalToken(header.slice(7), secret)
    } catch {
      refuse(c.req.path, "invalid_token")
    }
    if (payload.sid && isSessionRevoked(payload.sid)) refuse(c.req.path, "session_revoked")
    // Host binding (lib/org-host.ts): with org hosts, a portal token of org A works only on
    // A's host. A no-op without LIAISON_ORG_HOST_TEMPLATE.
    if (!(await hostAllowsOrg(c, payload.orgId))) refuse(c.req.path, "foreign_host")
    // Status and auth version, from the cached auth state (a deactivation or an
    // ended access bumps the version, so the token dies within the cache TTL at
    // most, and at once through the revocation above).
    const state = await getUserAuthState(payload.userId, payload.orgId, {
      expectedAuthVersion: payload.authVersion,
    })
    if (!state || state.status !== "active" || state.authVersion !== payload.authVersion) {
      refuse(c.req.path, "auth_state")
    }
    // An enrolment-only token opens the second-factor setup and nothing else.
    if (payload.enrol && !ENROLMENT_PATHS.has(c.req.path)) {
      rootLogger.warn({ path: c.req.path }, "portal enrolment token outside its routes")
      return c.json(
        {
          error: {
            message: "Set up your second factor first",
            code: "SECOND_FACTOR_SETUP_REQUIRED",
          },
        },
        403,
      )
    }
    c.set("portal", { orgId: payload.orgId, userId: payload.userId })
    await next()
  })
}
