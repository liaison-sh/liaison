// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The routine run factory: a routine's past runs (`kernel.routine_runs`), what
// its Runs list and the agent's activity show.
//
// Privileged raw insert, by category: history. The routine worker writes a run
// row as it ticks; a schedule that ran every morning for two weeks has no
// other writer. Rows take the worker's terminal shape under a deterministic
// id, so a re-run rewrites its own rows and nothing else.
import { withPrivilegedDb } from "~/db/privileged"
import { routineRuns } from "~/db/schema/kernel/routine-runs"
import type { SeedContext } from "~/seed/context"

export interface RoutineRunSeed {
  key: string
  routineId: string
  /** NULL: a run recorded before start times were kept (then `ranAt` says when it ended). */
  startedAt: Date | null
  /** When it ended; default `startedAt + durationMs`. */
  ranAt?: Date
  durationMs: number
  status: "succeeded" | "failed" | "skipped_overlap"
  /** NULL: a run recorded before triggers were kept. */
  trigger: "schedule" | "event" | "manual" | null
  triggerLabel?: string | null
  /** Default 1 for a success, 0 otherwise; NULL as on an older row. */
  turnsAdded?: number | null
  error?: string | null
}

export function routineRunId(ctx: SeedContext, key: string): string {
  return ctx.id("routine-run", key)
}

export async function seedRoutineRuns(
  ctx: SeedContext,
  runs: readonly RoutineRunSeed[],
): Promise<string[]> {
  if (runs.length === 0) return []
  const rows = runs.map((r) => {
    const ranAt = r.ranAt ?? (r.startedAt ? new Date(r.startedAt.getTime() + r.durationMs) : null)
    if (!ranAt) throw new Error(`routine run ${r.key}: a run with no start needs ranAt`)
    return {
      id: routineRunId(ctx, r.key),
      orgId: ctx.orgId,
      routineId: r.routineId,
      startedAt: r.startedAt,
      ranAt,
      status: r.status,
      durationMs: r.durationMs,
      error: r.error ?? null,
      turnsAdded: r.turnsAdded === undefined ? (r.status === "succeeded" ? 1 : 0) : r.turnsAdded,
      trigger: r.trigger,
      triggerLabel: r.triggerLabel ?? null,
    }
  })
  await withPrivilegedDb(ctx.orgId, "seed-routine-runs", (tx) =>
    tx.insert(routineRuns).values(rows).onConflictDoNothing({ target: routineRuns.id }),
  )
  return rows.map((r) => r.id)
}
