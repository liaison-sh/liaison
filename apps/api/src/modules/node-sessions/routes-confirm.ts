// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Level confirmations minted by the owner's own session (D24, D38, D41),
 * mounted at `/api/me/node-level-confirmations`:
 *
 *   POST /    { nodeId, agentId? | sessionId?, level, purpose } -> { confirmationId, expiresAt }
 *
 * The one owner gesture that raises a level. Refused to a node credential
 * (403 `node_credential_refused`) and to a restricted device session; MCP
 * connection tokens never pass the REST session middleware (auth.ts). It is
 * exposed as no agent tool and no MCP tool (confirmations.test.ts proves the
 * import graph).
 */
import { NODE_LEVELS } from "@liaison/shared"
import { and, eq, isNull } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { nodeSessions, nodes } from "~/db/schema/kernel"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { isMentionableAgent } from "~/modules/agent/directory/listing"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import { NODE_CREDENTIAL_HEADER } from "~/modules/nodes/credentials"
import { insertLevelConfirmation } from "./confirmations"

export const meLevelConfirmationRoutes = new Hono<AppEnv>()

const confirmSchema = z
  .object({
    nodeId: z.string().uuid(),
    agentId: z.string().uuid().optional(),
    sessionId: z.string().uuid().optional(),
    level: z.enum(NODE_LEVELS),
    purpose: z.enum(["profile_raise", "session_start", "session_raise"]),
  })
  .strict()
  .refine((b) => (b.agentId === undefined) !== (b.sessionId === undefined), {
    message: "exactly one of agentId and sessionId",
  })
  .refine((b) => (b.purpose === "session_raise") === (b.sessionId !== undefined), {
    message: "session_raise takes a sessionId; profile_raise and session_start take an agentId",
  })

const refuse = (code: string, message: string) => ({ error: { code, message } })

meLevelConfirmationRoutes.post("/", async (c) => {
  // A node never confirms its own raise (D24): refused before anything else.
  if (c.req.header(NODE_CREDENTIAL_HEADER) !== undefined) {
    return c.json(
      refuse("node_credential_refused", "A level is confirmed by its owner in the app."),
      403,
    )
  }
  assertUnrestrictedSession(c, "raise a node level")
  const raw = await c.req.json().catch(() => null)
  const parsed = confirmSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json(refuse("invalid_body", parsed.error.issues[0]?.message ?? "invalid body"), 400)
  }
  const body = parsed.data
  const orgId = c.get("orgId")
  const userId = c.get("userId")

  // The node and the session are read through the caller's own RLS.
  const [node] = await withRequestRls(c, (tx) =>
    tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.id, body.nodeId),
          eq(nodes.orgId, orgId),
          eq(nodes.ownerUserId, userId),
          eq(nodes.enabled, true),
          isNull(nodes.revokedAt),
        ),
      )
      .limit(1),
  )
  if (!node) return c.json(refuse("node_not_found", "No such node of yours."), 404)

  if (body.agentId) {
    if (!(await isMentionableAgent(orgId, userId, body.agentId))) {
      return c.json(refuse("agent_not_found", "No such agent for you."), 404)
    }
  } else if (body.sessionId) {
    const [session] = await withRequestRls(c, (tx) =>
      tx
        .select({ id: nodeSessions.id, nodeId: nodeSessions.nodeId })
        .from(nodeSessions)
        .where(
          and(
            eq(nodeSessions.id, body.sessionId as string),
            eq(nodeSessions.orgId, orgId),
            eq(nodeSessions.ownerUserId, userId),
          ),
        )
        .limit(1),
    )
    if (!session) return c.json(refuse("session_not_found", "No such session."), 404)
    if (session.nodeId !== null && session.nodeId !== body.nodeId) {
      return c.json(refuse("node_mismatch", "That session runs on another computer."), 422)
    }
  }

  const row = await insertLevelConfirmation({
    orgId,
    ownerUserId: userId,
    nodeId: body.nodeId,
    agentId: body.agentId ?? null,
    sessionId: body.sessionId ?? null,
    level: body.level,
    purpose: body.purpose,
  })
  return success(
    c,
    { confirmationId: row.id, expiresAt: row.expiresAt.toISOString() },
    undefined,
    201,
  )
})
