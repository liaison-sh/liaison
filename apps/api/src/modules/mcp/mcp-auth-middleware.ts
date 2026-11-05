// SPDX-License-Identifier: FSL-1.1-ALv2
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { awaitOrgApps } from "~/modules/apps/init"
import { resolveConnectionFromToken } from "~/modules/mcp/connection-service"
import { assertOrgNotDeleting } from "~/modules/org/purge/deleting"
import { createScope } from "~/modules/permissions/types"

// Authenticates an MCP access token to a connection and populates the request
// actor context. On any failure → 401 with a WWW-Authenticate header carrying
// the protected-resource metadata URL so clients re-enter the OAuth flow.
export const mcpAuthMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const challenge = `Bearer resource_metadata="${env.BASE_URL}/.well-known/oauth-protected-resource"`
  const header = c.req.header("Authorization")
  if (!header?.startsWith("Bearer ")) {
    c.header("WWW-Authenticate", challenge)
    throw new HTTPException(401, { message: "Unauthorized" })
  }
  const token = header.slice(7)
  // Resolve the token inside the try; `next()` stays OUTSIDE it. A fault or HTTPException
  // raised downstream (the rate limiter's 429, the transport's own errors) is not an
  // authentication failure and must not be turned into a 401 challenge, which sends
  // clients back through re-authorisation instead of backing off.
  let resolved: Awaited<ReturnType<typeof resolveConnectionFromToken>>
  try {
    resolved = await resolveConnectionFromToken(token)
  } catch (err) {
    rootLogger.warn(
      { path: c.req.path, reason: err instanceof Error ? err.message : "mcp_auth_failure" },
      "mcp auth failure",
    )
    c.header("WWW-Authenticate", challenge)
    throw new HTTPException(401, { message: "Unauthorized" })
  }
  c.set("userId", resolved.userId)
  c.set("orgId", resolved.orgId)
  c.set("roles", [])
  c.set("scopes", resolved.scopes.map(createScope))
  c.set("dimensionGrants", resolved.dimensionGrants)
  c.set("mcpConnectionId", resolved.connectionId)
  // The agent binding, when the resolved connection has one. Absent for a
  // legacy connection, which is the honest answer there: no agent acts on it.
  if (resolved.agentId) c.set("mcpAgentId", resolved.agentId)
  // An org whose deletion has started serves nothing more: 410 ORG_DELETED.
  await assertOrgNotDeleting(c.get("orgId"))
  // The org's apps, when it is still registering after a restart: the org the
  // verified token just set as this request's.
  await awaitOrgApps(c.get("orgId"))
  await next()
})
