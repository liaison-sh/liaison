// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A node chat turn's steps, as the node runs them (S24; turn-live.ts).
 *
 *   POST /jobs/:id/turn-progress   node (credential + lease generation):
 *                                  { leaseGeneration, events: [...] } -> 204
 *
 * Fenced like a permission request: only the node holding the job's current
 * lease, only for an interactive job (a chat turn). Nothing is stored: each
 * step goes out on the turn's live stream, redacted, to the job's owner.
 */
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { nodeJobs } from "~/db/schema/kernel"
import { zValidator } from "~/lib/validate"
import { requireNodeCredential } from "./credentials"
import { heldBy } from "./jobs"
import { nodeTurnProgress } from "./turn-live"

export const nodeTurnProgressRoutes = new Hono<AppEnv>()

const idParam = z.object({ id: z.string().uuid() })

const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_call"),
    id: z.string().min(1).max(200),
    toolName: z.string().min(1).max(200),
    summary: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    id: z.string().min(1).max(200),
    isError: z.boolean().optional(),
  }),
])

const progressSchema = z.object({
  leaseGeneration: z.number().int().positive(),
  events: z.array(eventSchema).min(1).max(50),
})

nodeTurnProgressRoutes.post(
  "/jobs/:id/turn-progress",
  zValidator("param", idParam),
  zValidator("json", progressSchema),
  async (c) => {
    const node = await requireNodeCredential(c)
    const jobId = c.req.valid("param").id
    const body = c.req.valid("json")
    const [job] = await withPrivilegedDb(node.orgId, "nodes:turn-progress-job", (tx) =>
      tx
        .select()
        .from(nodeJobs)
        .where(heldBy(node, jobId, body.leaseGeneration))
        .limit(1),
    )
    if (!job) {
      return c.json(
        { error: { code: "stale_lease", message: "this lease is no longer yours: stop the run" } },
        409,
      )
    }
    if (job.kind !== "interactive") {
      return c.json(
        { error: { code: "not_a_chat_turn", message: "only a chat turn reports its steps" } },
        409,
      )
    }
    nodeTurnProgress(job, body.events)
    return c.body(null, 204)
  },
)
