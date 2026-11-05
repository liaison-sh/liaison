// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The node's report of its live runs (P3, D36), mounted at `/api/node/sessions`:
 *
 *   POST /report  {sessions: [{id, jobId, leaseGeneration, alive}] ≤ 32}
 *                 -> {sessions: [{id, lastBatchNo, lastSeq}]}
 *
 * Sent on every (re)connect and after a page reload. A listed, fenced, alive
 * run keeps its lease and leaves `paused`; the answer tells the node where its
 * posting stands. Every other run the node holds is dead and resumes
 * (lifecycle.ts). Node credential only.
 */
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { requireNodeCredential } from "~/modules/nodes/credentials"
import { reportNodeSessions } from "./lifecycle"

export const nodeSessionReportRoutes = new Hono<AppEnv>()

const reportSchema = z.object({
  sessions: z
    .array(
      z.object({
        id: z.string().uuid(),
        jobId: z.string().uuid(),
        leaseGeneration: z.number().int().positive(),
        alive: z.boolean(),
      }),
    )
    .max(32),
})

nodeSessionReportRoutes.post("/report", zValidator("json", reportSchema), async (c) => {
  const node = await requireNodeCredential(c)
  return success(c, await reportNodeSessions(node, c.req.valid("json").sessions))
})
