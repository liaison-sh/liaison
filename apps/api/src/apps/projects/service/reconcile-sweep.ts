// SPDX-License-Identifier: FSL-1.1-ALv2
// The projects sweep. Once a day it heals what a lost after-commit write could
// leave behind: each org's time and budgets row is recomputed from its
// projects' switches (`syncTimeBudgetsFeature`), and time rows whose task moved
// follow it to its project. It reads only the projects' switch state and the
// task each time row belongs to, never anyone's activity, and tells no one.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import {
  SKIPPED_MOVING,
  sweepSkippingMoving,
  writeUnlessMoving,
} from "~/modules/org/transfer-state/skip-moving"
import { syncTimeBudgetsFeature, TIME_FEATURE } from "./time-feature"

const log = rootLogger.child({ module: "projects/reconcile-sweep" })

/** The UTC hour of the day the hourly sweep also heals. */
export const HEAL_HOUR_UTC = 4

/**
 * Recompute the time and budgets row of every org that has one or has a project with the
 * switch on, and re-point time rows to their task's project. Answers the orgs it corrected.
 */
export async function healTimeBudgets(): Promise<{
  checked: number
  corrected: string[]
  rowsRepointed: number
}> {
  const { orgIds, rowsRepointed } = await sweepSkippingMoving((notMoving) =>
    withSystemDb("projects-reconcile-sweep", async (tx) => {
      const orgs = extractRows<{ org_id: string }>(
        await tx.execute(drizzleSql`
          SELECT DISTINCT org_id::text AS org_id FROM (
            SELECT org_id FROM ${projectsRel("projects")} WHERE time_budgets_on
            UNION
            SELECT org_id FROM ${drizzleSql.raw(schemaRef("kernel"))}.org_app_features
             WHERE app_name = 'projects' AND feature = ${TIME_FEATURE}
          ) o WHERE ${notMoving(drizzleSql.raw("o.org_id"))}`),
      )
      const moved = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          UPDATE ${projectsRel("task_time")} tt SET project_id = t.project_id, updated_at = now()
            FROM ${projectsRel("tasks")} t
           WHERE t.id = tt.task_id AND t.org_id = tt.org_id AND tt.project_id <> t.project_id
             AND ${notMoving(drizzleSql.raw("tt.org_id"))}
          RETURNING tt.id::text AS id`),
      )
      return { orgIds: orgs.map((o) => o.org_id), rowsRepointed: moved.length }
    }),
  )
  const corrected: string[] = []
  for (const orgId of orgIds) {
    const result = await writeUnlessMoving(orgId, () =>
      syncTimeBudgetsFeature(orgId, null, { pool: "jobs" }),
    )
    if (result !== SKIPPED_MOVING && result.changed) {
      corrected.push(orgId)
      log.warn(
        { orgId, enabled: result.enabled },
        "time and budgets org row corrected by the sweep",
      )
    }
  }
  return { checked: orgIds.length, corrected, rowsRepointed }
}

/** One run of the hourly sweep: the heal runs at its hour of the day. */
export async function runReconcileSweep(now: Date = new Date()): Promise<void> {
  if (now.getUTCHours() !== HEAL_HOUR_UTC) return
  log.info(await healTimeBudgets(), "projects_reconcile_sweep_heal")
}
