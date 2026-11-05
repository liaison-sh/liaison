// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DESKTOP APP'S AGENT CONNECTION, FROM THE SESSION IT IS ALREADY SIGNED IN WITH.
//
// A local session on the desktop needs an agent scoped MCP token. It used to
// get one through the device grant (`device-grant-routes.ts`): a code on
// screen, a browser tab, an Approve click. The user of the desktop app is
// already signed in to this server in that very window, so the grant asked
// them to prove, in a browser, an identity the app already holds, once per
// agent and again whenever the stored connection was lost. This route is the
// same outcome without the detour: the caller's own access token (behind the
// REST auth middleware, which refuses MCP tokens, so an agent cannot use its
// token to mint a connection for another agent) creates the agent bound
// connection the approved grant would have created, validated the same way.
//
// Nothing widens: the connection acts as the agent, and every mint narrows it
// to the agent's live ceiling intersected with the signed-in user's live
// grants (`connection-service.ts` mintAccessToken).

import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import {
  createMcpConnection,
  loadBindableAgent,
  mintAccessToken,
} from "~/modules/mcp/connection-service"
import { DESKTOP_DEVICE_CLIENT_ID } from "~/modules/mcp/device-client-policy"

export const DESKTOP_CONNECTION_LABEL = "Liaison desktop"

const connectSchema = z.object({ agentId: z.string().uuid() })

export const mcpDesktopConnection = new Hono<AppEnv>()

mcpDesktopConnection.post("/connection", zValidator("json", connectSchema), async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const { agentId } = c.req.valid("json")
  // A new MCP connection is a new credential: never from a restricted session.
  assertUnrestrictedSession(c, "open a desktop connection")
  if (!(await loadBindableAgent(orgId, userId, agentId))) {
    throw new HTTPException(400, { message: "unknown or foreign org agent" })
  }
  const { connection, refreshToken } = await createMcpConnection({
    orgId,
    userId,
    clientId: DESKTOP_DEVICE_CLIENT_ID,
    label: DESKTOP_CONNECTION_LABEL,
    agentId,
  })
  const { token } = await mintAccessToken(connection.id)
  return success(c, { accessToken: token, refreshToken })
})
