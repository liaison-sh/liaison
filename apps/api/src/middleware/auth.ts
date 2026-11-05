// SPDX-License-Identifier: FSL-1.1-ALv2
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { rootLogger } from "~/lib/logger"
import { awaitOrgApps } from "~/modules/apps/init"
import { getUserAuthState, invalidateAuthCache } from "~/modules/auth/auth-state"
import { verifyAccessToken } from "~/modules/auth/jwt"
import { isSessionRevoked } from "~/modules/auth/session-revocation"
import { noteSessionUse } from "~/modules/auth/session-use"
import { assertDemoOrgActive } from "~/modules/demo/demo-expiry"
import { assertOrgNotDeleting } from "~/modules/org/purge/deleting"
import { createScope } from "~/modules/permissions/types"

export { invalidateAuthCache }

export function authMiddleware(secret: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("Authorization")
    if (!header?.startsWith("Bearer ")) {
      rootLogger.warn(
        { method: c.req.method, path: c.req.path, reason: "missing_bearer" },
        "auth failure",
      )
      throw new HTTPException(401, { message: "Unauthorized" })
    }

    const token = header.slice(7)
    try {
      const payload = await verifyAccessToken(token, secret)

      // Token-class isolation: MCP connection tokens (15-min, minted from an
      // mcp_connections row) carry `mcpConnectionId` and are ONLY valid on the
      // /mcp transport via mcpAuthMiddleware. They must never authenticate the
      // general REST surface — otherwise a leaked or post-revoke MCP token
      // would have full REST access until TTL expiry (the revoke→401 guarantee
      // is enforced at MCP mint/refresh, not on this path).
      if (payload.mcpConnectionId) {
        rootLogger.warn(
          { method: c.req.method, path: c.req.path, reason: "mcp_token_on_rest" },
          "auth failure",
        )
        throw new HTTPException(401, { message: "Unauthorized" })
      }

      // A token of a session that has ended (sign-out, password change,
      // revocation) is refused at once, not when it expires. A memory lookup
      // (session-revocation.ts); tokens without a session id are unaffected.
      if (payload.sid && isSessionRevoked(payload.sid)) {
        rootLogger.warn(
          { method: c.req.method, path: c.req.path, reason: "session_revoked" },
          "auth failure",
        )
        throw new HTTPException(401, { message: "Unauthorized" })
      }

      const authInfo = await getUserAuthState(payload.userId, payload.orgId, {
        expectedAuthVersion: payload.authVersion,
        expectedPermissionVersion: payload.permissionVersion,
      })

      if (!authInfo) {
        rootLogger.warn(
          { method: c.req.method, path: c.req.path, reason: "user_not_found" },
          "auth failure",
        )
        throw new HTTPException(401, { message: "Unauthorized" })
      }

      if (
        authInfo.status !== "active" ||
        authInfo.authVersion !== payload.authVersion ||
        authInfo.permissionVersion !== payload.permissionVersion
      ) {
        invalidateAuthCache(payload.userId)
        const reason =
          authInfo.status !== "active"
            ? `user_${authInfo.status}`
            : authInfo.authVersion !== payload.authVersion
              ? "auth_version_mismatch"
              : "permission_version_mismatch"
        rootLogger.warn({ method: c.req.method, path: c.req.path, reason }, "auth failure")
        throw new HTTPException(401, { message: "Unauthorized" })
      }

      // An expired demo visitor workspace refuses every token it ever issued,
      // on every route that authenticates through here (a no-op, with no query,
      // unless LIAISON_DEMO_MODE is on).
      await assertDemoOrgActive(payload.orgId)

      // The session this token came from has now been used: a later replay of
      // its rotated predecessor is no lost response (auth.ts refreshSession).
      // Never throws.
      if (payload.sid) await noteSessionUse(payload.sid)

      // Permissions are embedded in the JWT at token issuance/refresh.
      // permissionVersion ensures stale tokens are rejected within cache TTL (15s).
      c.set("userId", payload.userId)
      c.set("orgId", payload.orgId)
      c.set("roles", payload.roles ?? [])
      c.set("scopes", (payload.scopes ?? []).map(createScope))
      // Pass raw dimension grants. Per-app normalization (e.g., Knowledge's
      // sensitivity ladder) happens at the consumer (service-layer auth checks
      // and the app's RLS predicates), not in the kernel auth middleware.
      c.set("dimensionGrants", payload.dimensionGrants ?? {})
      c.set("authVersion", payload.authVersion)
      c.set("permissionVersion", payload.permissionVersion)
      // A restricted (device-flow) session: it may use its capped scopes, but
      // mints no further credential (modules/auth/session-ceiling.ts).
      c.set("sessionRestricted", payload.restricted === true)
      c.set("secondFactorRequired", payload.secondFactorRequired === true)
      if (payload.sid) c.set("sessionId", payload.sid)

      // Enrich request-scoped pino logger with user context
      const logger = c.get("logger")
      if (logger?.child) {
        const enriched = logger.child({ userId: payload.userId, orgId: payload.orgId })
        c.set("logger", enriched as typeof logger)
      }
    } catch (err) {
      if (err instanceof HTTPException) throw err
      rootLogger.warn(
        { method: c.req.method, path: c.req.path, reason: "invalid_token" },
        "auth failure",
      )
      throw new HTTPException(401, { message: "Unauthorized" })
    }

    // An org whose deletion has started (modules/org/purge/deleting.ts) serves
    // nothing more: 410 ORG_DELETED. Outside the try: it is not a 401.
    await assertOrgNotDeleting(c.get("orgId"))
    // The org's apps, when it is still registering after a restart (a no-op
    // otherwise). Outside the try: a registration failure is not a 401.
    await awaitOrgApps(c.get("orgId"))
    await next()
  })
}
