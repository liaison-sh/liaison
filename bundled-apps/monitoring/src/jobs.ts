// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scheduled job handlers. `assign-refs` (manifest: `atomic: true`, so one run is one
// transaction, see `assignMissingRefs`) is the backfill and safety net for incident refs.
import type { AppContext } from "@liaison/app-sdk"
import { assignMissingRefs } from "./lib/refs"

/**
 * Rows numbered per run. A run holds the org's ref lock until it commits, and a creating
 * webhook (5 s sandbox budget in production) waits behind it: 50 rows keep a run well under a
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
