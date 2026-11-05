// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-only route: run one tool call AS THE AGENT acting for the signed-in
// user, i.e. through the same executeTool gate with origin "in-app-agent".
//
// Approvals are for agents, not persons: a person's own REST call
// (`/api/apps/run-tool`, origin "human-ui") runs on their own permissions or is
// refused, and never parks an approval. A scenario that needs a PENDING
// approval to decide (the decision flow, approver routing, bundles) therefore
// stages it the way production does, from an agent's call. This route is the
// gate-level form of that call, without a model turn; scenarios that cover the
// agent loop itself script a real turn instead (`/api/_test/agent-script`).
//
// Mounted only when `qaSeedRoutesEnabled` (NODE_ENV=test or
// ENABLE_QA_SEED_ROUTES), like every `/api/_test` route; the env validator
// refuses the flag in production.
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { env, qaSeedRoutesEnabled } from "~/lib/env"
import { extractRlsContext } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { authMiddleware } from "~/middleware/auth"
import { executeTool } from "~/modules/apps/execute-tool"

export const agentToolCallTestRoutes = new Hono<AppEnv>()

agentToolCallTestRoutes.use("*", async (_c, next) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  await next()
})
agentToolCallTestRoutes.use("*", authMiddleware(env.JWT_SECRET))

const bodySchema = z.object({
  toolName: z.string().min(1),
  params: z.unknown().optional(),
  threadId: z.string().optional(),
  /**
   * The step's bundle id, as the agent stream loop passes it when the model
   * makes several gated calls in one step: each call parks in that bundle at
   * the next position (a parallel approval bundle).
   */
  stepBundleId: z.string().uuid().optional(),
})

/** POST /api/_test/agent-tool-call — the agent's call, same envelope as /api/apps/run-tool. */
agentToolCallTestRoutes.post("/", zValidator("json", bodySchema), async (c) => {
  const body = c.req.valid("json")
  const result = await executeTool({
    toolName: body.toolName,
    orgId: c.get("orgId"),
    actor: extractRlsContext(c),
    threadId: body.threadId,
    params: body.params ?? {},
    origin: "in-app-agent",
    stepBundleId: body.stepBundleId ?? null,
  })
  return success(c, result.blocked ? { blocked: result.blocked } : result.data)
})
