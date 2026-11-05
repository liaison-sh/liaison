// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withRequestRls } from "~/lib/request-rls"
import { paginated } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { queryAuditLogPage } from "~/modules/audit/service"

export const auditRoutes = new Hono<AppEnv>()

const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  actor: z.string().uuid().optional(),
  /** Filter by actor category: "user" | "agent" | "system" | "mcp". */
  actor_type: z.enum(["user", "agent", "system", "mcp"]).optional(),
  /**
   * Filter by ACTING AGENT (`audit_log.agent_id`), independent of `actor` (the
   * human) and of `actor_type`: an agent turn stamps it on every row it
   * produces, so "what did the logistics agent do" is answerable here and not
   * only through the agent tool (A11). Authorization is unchanged: the whole
   * surface sits behind `requireScope("kernel:audit:read")` in app.ts.
   */
  agent_id: z.string().uuid().optional(),
  app: z.string().optional(),
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
  /** Compound format: "entity.action" (e.g., "thread.create", "user.deactivate", "auth.login") */
  action: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
})

auditRoutes.get("/", zValidator("query", auditQuerySchema), async (c) => {
  const orgId = c.get("orgId")
  const params = c.req.valid("query")

  const { entries, total } = await withRequestRls(c, (tx) =>
    queryAuditLogPage(tx, orgId, {
      actor: params.actor,
      actorType: params.actor_type,
      agentId: params.agent_id,
      app: params.app,
      entityType: params.entity_type,
      entityId: params.entity_id,
      action: params.action,
      from: params.from,
      to: params.to,
      page: params.page,
      limit: params.limit,
    }),
  )

  return paginated(c, entries, { page: params.page, limit: params.limit, total })
})
