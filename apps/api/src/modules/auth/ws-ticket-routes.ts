// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomBytes } from "node:crypto"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { hostBindingEnabled } from "~/lib/org-host"
import { redis } from "~/lib/redis"
import { effectiveRequest } from "~/lib/request-context"
import { success } from "~/lib/response"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"

export const wsTicket = new Hono<AppEnv>()

wsTicket.post("/", async (c) => {
  // The ticket does not carry the session's restriction, so a WebSocket path
  // that authorises on the user's stored grants would act past the cap. A
  // restricted (device-flow) session mints no new credential (session-ceiling.ts).
  assertUnrestrictedSession(c, "open a WebSocket connection")
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const scopes = c.get("scopes")
  const roles = c.get("roles")
  const dimensionGrants = c.get("dimensionGrants")
  const authVersion = c.get("authVersion")
  const permissionVersion = c.get("permissionVersion")
  const sid = c.get("sessionId")

  const ticket = randomBytes(32).toString("hex")
  const key = `ws-ticket:${ticket}`

  // Store ticket in Redis with 30-second TTL, single-use (includes authVersion + permissionVersion)
  await redis.set(
    key,
    JSON.stringify({
      userId,
      orgId,
      scopes,
      roles,
      dimensionGrants,
      authVersion,
      permissionVersion,
      // The socket closes when this session ends (session-revocation.ts).
      ...(sid ? { sid } : {}),
      // With org hosts the ticket opens a socket on this host only (ws-ticket.ts).
      ...(hostBindingEnabled() ? { host: effectiveRequest(c).host ?? "" } : {}),
    }),
    "EX",
    30,
  )

  return success(c, { ticket })
})
