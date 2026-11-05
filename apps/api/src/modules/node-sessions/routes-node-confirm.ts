// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The node uses up a level confirmation (D24, D41), mounted at
 * `/api/node/level-confirmations`:
 *
 *   POST /:id/consume   { agentId, level } | { sessionId, level } -> { purpose, level }
 *
 * Node credential required; the row must be this node's (403), unused (409
 * `confirmation_consumed`), unexpired (409 `confirmation_expired`: only an
 * unattached row expires by age) and bound to what the node admits at exactly
 * that level (409 `confirmation_mismatch`).
 */
import { NODE_LEVELS } from "@liaison/shared"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { requireNodeCredential } from "~/modules/nodes/credentials"
import { type ConsumeTarget, consumeConfirmation } from "./confirmations"

export const nodeLevelConfirmationRoutes = new Hono<AppEnv>()

const idParam = z.object({ id: z.string().uuid() })
const level = z.enum(NODE_LEVELS)
const consumeSchema = z.union([
  z.object({ agentId: z.string().uuid(), level }).strict(),
  z.object({ sessionId: z.string().uuid(), level }).strict(),
])

const MESSAGES = {
  confirmation_consumed: "This confirmation was already used.",
  confirmation_expired: "This confirmation expired. Confirm the level again in the app.",
  confirmation_mismatch: "This confirmation is for another agent, session or level.",
} as const

nodeLevelConfirmationRoutes.post("/:id/consume", zValidator("param", idParam), async (c) => {
  const node = await requireNodeCredential(c)
  const raw = await c.req.json().catch(() => null)
  const parsed = consumeSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json(
      { error: { code: "invalid_body", message: "send {agentId, level} or {sessionId, level}" } },
      400,
    )
  }
  const outcome = await consumeConfirmation(
    node,
    c.req.valid("param").id,
    parsed.data as ConsumeTarget,
  )
  switch (outcome.kind) {
    case "consumed":
      return success(c, { purpose: outcome.purpose, level: outcome.level })
    case "not_found":
      return c.json({ error: { code: "not_found", message: "No such confirmation." } }, 404)
    case "not_your_node":
      return c.json(
        { error: { code: "not_your_node", message: "This confirmation is for another node." } },
        403,
      )
    case "refused":
      return c.json({ error: { code: outcome.code, message: MESSAGES[outcome.code] } }, 409)
  }
})
