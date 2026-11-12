// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scheduled job handlers. `assign-refs` is the backfill and safety net for incident refs; it
// takes turns with creating webhooks through the numbering lease (`assignMissingRefs`).
import type { AppContext } from "@liaison/app-sdk"
import { assignMissingRefs } from "./lib/refs"

/**
 * Rows numbered per run. A run holds the numbering lease while it numbers, and a creating
 * webhook that finds it held leaves its row to the next run: 50 rows keep a run well under a
 * second. A backlog drains over successive runs (every 5 minutes).
 */
export const JOB_REF_BATCH = 50

export async function assignRefsJobHandler(
  _payload: unknown,
  ctx: AppContext,
): Promise<{ assigned: number; remaining: boolean }> {
  const result = await assignMissingRefs(ctx, { limit: JOB_REF_BATCH })
  // Visible progress: a backfill that stops draining shows up as the same `remaining` run after run.
  if (result.assigned > 0) ctx.logger.info("monitoring: assign-refs numbered incidents", result)
  return result
}
