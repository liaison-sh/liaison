// SPDX-License-Identifier: FSL-1.1-ALv2
import type { Context } from "hono"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"
import type { PermissionMutationContext } from "~/modules/permissions/types"
import { announceScopeDecision } from "~/modules/scope-requests/announce"
import {
  createScopeRequest,
  decideScopeRequest,
  getScopeRequest,
  listScopeRequests,
} from "~/modules/scope-requests/service"

const createSchema = z.object({
  scopes: z.array(z.string().min(1)).min(1).max(200),
  reason: z.string().max(2000).optional(),
})

const listSchema = z.object({
  status: z.enum(["pending", "approved", "denied", "expired", "cancelled"]).optional(),
})

const idParam = z.object({ id: z.string().uuid() })

const decideSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve") }),
  z.object({ decision: z.literal("deny"), reason: z.string().max(2000).optional() }),
])

function actorContext(c: Context<AppEnv>): PermissionMutationContext {
  return {
    actorId: c.get("userId"),
    actorScopes: c.get("scopes"),
    actorDimensionGrants: c.get("dimensionGrants"),
    orgId: c.get("orgId"),
  }
}

export const scopeRequests = new Hono<AppEnv>()

// Any authenticated org member can file a request via this route — no scope gate.
// (Agents don't hit this HTTP route; they file via the kernel `request_scope` tool.)
scopeRequests.post("/", zValidator("json", createSchema), async (c) => {
  const body = c.req.valid("json")
  const actor = extractRlsContext(c)
  const row = await withRequestRls(c, (tx) =>
    createScopeRequest(tx, {
      orgId: actor.orgId,
      requestedBy: actor.userId,
      requestedByType: "user",
      requestedScopes: body.scopes,
      reason: body.reason,
    }),
  )
  return success(c, row, undefined, 201)
})

scopeRequests.get("/", zValidator("query", listSchema), async (c) => {
  const { status } = c.req.valid("query")
  const data = await withRequestRls(c, (tx) => listScopeRequests(tx, { status }))
  return success(c, data)
})

scopeRequests.get("/:id", zValidator("param", idParam), async (c) => {
  const { id } = c.req.valid("param")
  const row = await withRequestRls(c, (tx) => getScopeRequest(tx, id))
  if (!row) throw new HTTPException(404, { message: "Scope request not found" })
  return success(c, row)
})

scopeRequests.post(
  "/:id/decide",
  requireScope("kernel:scope_requests:admin"),
  zValidator("param", idParam),
  zValidator("json", decideSchema),
  async (c) => {
    const { id } = c.req.valid("param")
    const body = c.req.valid("json")
    const result = await withRequestRls(c, (tx) =>
      decideScopeRequest(tx, {
        orgId: c.get("orgId"),
        requestId: id,
        actor: actorContext(c),
        decision: body.decision,
        reason: body.decision === "deny" ? body.reason : undefined,
      }),
    )
    // After the commit, never inside it: the conversation that asked hears the
    // decision, and the agent that asked takes its turn (announce.ts).
    await announceScopeDecision(c.get("orgId"), c.get("userId"), result)
    return success(c, result)
  },
)
