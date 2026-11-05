// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The owner's steering of a session (P3, spec-protocol.md §Commands), mounted
 * at `/api/me/node-sessions` next to the reads:
 *
 *   POST /:id/commands         {type, payload} -> 201 {commandId, seq, applied?}
 *                              (409 node_outdated: the live node is too old for it)
 *   GET  /:id/commands?open=1  the owner's unacked commands, in seq order
 *
 * Owner only: another user (an org admin included) gets 404. Refused to a
 * node credential (a node never steers a session) and to a restricted device
 * session (the decisions act on the owner's stored grants, like approvals);
 * MCP connection tokens never pass the REST session middleware. The owner's
 * own agent steers through the same `submitCommand` (agent-tools.ts), never
 * with a confirmation id, and never from a session on the computer.
 */
import { nodeSessionCommandSchema } from "@liaison/shared"
import { and, asc, eq, isNull } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { nodeSessionCommands, nodeSessions } from "~/db/schema/kernel"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import { NODE_CREDENTIAL_HEADER } from "~/modules/nodes/credentials"
import { submitCommand } from "./commands"

export const meNodeSessionCommandRoutes = new Hono<AppEnv>()

const idParam = z.object({ id: z.string().uuid() })
const openQuery = z.object({ open: z.literal("1").optional() })
const notFound = { error: { code: "not_found", message: "No such session." } }

meNodeSessionCommandRoutes.post(
  "/:id/commands",
  requireScope("kernel:threads:write"),
  async (c, next) => {
    if (c.req.header(NODE_CREDENTIAL_HEADER) !== undefined) {
      return c.json(
        {
          error: {
            code: "node_credential_refused",
            message: "A session is steered by its owner in the app.",
          },
        },
        403,
      )
    }
    await next()
  },
  zValidator("param", idParam),
  zValidator("json", nodeSessionCommandSchema),
  async (c) => {
    assertUnrestrictedSession(c, "steer a session on your computer")
    const result = await submitCommand({
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      sessionId: c.req.valid("param").id,
      command: c.req.valid("json"),
    })
    if (!result.ok) {
      if (result.code === "not_found") return c.json(notFound, 404)
      if (result.code === "follow_read_only") {
        return c.json(
          {
            error: {
              code: "follow_read_only",
              message: "This session is followed read only. Take it over to send it messages.",
            },
          },
          409,
        )
      }
      if (result.code === "driven_elsewhere_confirm") {
        return c.json(
          {
            error: {
              code: "driven_elsewhere_confirm",
              message:
                "Another Claude Code is driving this session. Send again to confirm you want Liaison to continue it.",
            },
          },
          409,
        )
      }
      if (result.code === "node_outdated") {
        return c.json(
          {
            error: {
              code: "node_outdated",
              message:
                "The computer running this session needs a Liaison update before it can do this. Update the desktop app, or stop the session.",
            },
          },
          409,
        )
      }
      return c.json(
        {
          error: {
            code: "confirmation_required",
            message: "Confirm this level in the app before the session is raised.",
            ...(result.reason ? { reason: result.reason } : {}),
          },
        },
        403,
      )
    }
    return success(
      c,
      {
        commandId: result.commandId,
        seq: result.seq,
        ...(result.applied ? { applied: result.applied } : {}),
      },
      undefined,
      201,
    )
  },
)

meNodeSessionCommandRoutes.get(
  "/:id/commands",
  zValidator("param", idParam),
  zValidator("query", openQuery),
  async (c) => {
    const id = c.req.valid("param").id
    const onlyOpen = c.req.valid("query").open === "1"
    const found = await withRequestRls(c, async (tx) => {
      const [row] = await tx
        .select({ id: nodeSessions.id })
        .from(nodeSessions)
        .where(and(eq(nodeSessions.id, id), eq(nodeSessions.orgId, c.get("orgId"))))
        .limit(1)
      if (!row) return null
      return tx
        .select()
        .from(nodeSessionCommands)
        .where(
          and(
            eq(nodeSessionCommands.sessionId, id),
            onlyOpen ? isNull(nodeSessionCommands.ackedAt) : undefined,
          ),
        )
        .orderBy(asc(nodeSessionCommands.seq))
        .limit(500)
    })
    if (!found) return c.json(notFound, 404)
    return success(c, {
      commands: found.map((r) => ({
        commandId: r.id,
        seq: r.seq,
        type: r.type,
        payload: r.payload,
        createdAt: r.createdAt.toISOString(),
        ackedAt: r.ackedAt?.toISOString() ?? null,
        outcome: r.outcome,
      })),
    })
  },
)
