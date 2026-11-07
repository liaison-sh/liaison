// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Stale-run sweep (cron `imports-stale-sweep`): a run whose worker crashed
 * stays `running` (or `undoing`) for ever and can be neither undone nor
 * restarted. A run writes a heartbeat at least every minute; one whose
 * heartbeat is older than STALE_RUN_MS is failed (and its bundled ledger
 * recovered, so it can be undone), and a stuck undo goes back to the status it
 * had (its transaction rolled back with the worker, so nothing was deleted).
 */
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type ImportRunStatus, importRuns } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { recoverLedger } from "~/modules/imports/recover"
import { FINAL_STATUSES, importRunEvent } from "~/modules/imports/runs"
import { deleteRunStaging } from "~/modules/imports/staging"
import { movingOrgIds } from "~/modules/org/transfer-state/state"

const log = rootLogger.child({ module: "imports-sweep" })

export const STALE_RUN_MS = 10 * 60_000

interface StaleRow {
  id: string
  org_id: string
  status: "running" | "undoing"
  prior: string | null
}

/** Stale runs of every org (system pool): their own rows only, by id. */
async function staleRuns(staleMs: number): Promise<StaleRow[]> {
  const K = drizzleSql.raw(schemaRef("kernel"))
  return withSystemDb("imports-stale-list", async (tx) =>
    extractRows<StaleRow>(
      await tx.execute(drizzleSql`
        SELECT id, org_id, status, report->>'undoPriorStatus' AS prior
        FROM ${K}.import_runs
        WHERE status IN ('running', 'undoing')
          AND COALESCE(heartbeat_at, started_at, created_at)
              < now() - make_interval(secs => ${staleMs / 1000})
        LIMIT 500
      `),
    ),
  )
}

/** Fail one stalled run in its own org; true when this sweep moved it. */
async function failStalledRun(row: StaleRow, staleMs: number): Promise<boolean> {
  const orgId = row.org_id
  const prior: ImportRunStatus =
    row.prior && FINAL_STATUSES.has(row.prior as ImportRunStatus)
      ? (row.prior as ImportRunStatus)
      : "failed"
  const moved = await withPrivilegedDb(orgId, "imports-stale-fail", (tx) =>
    tx
      .update(importRuns)
      .set(
        row.status === "running"
          ? {
              status: "failed",
              finishedAt: drizzleSql`now()`,
              errors: drizzleSql`${importRuns.errors} || ${JSON.stringify([
                { error: "stalled: the worker stopped before the run finished" },
              ])}::jsonb`,
            }
          : { status: prior },
      )
      .where(
        and(
          eq(importRuns.orgId, orgId),
          eq(importRuns.id, row.id),
          eq(importRuns.status, row.status),
          // Re-checked: a heartbeat since the list keeps the run alive.
          drizzleSql`COALESCE(${importRuns.heartbeatAt}, ${importRuns.startedAt}, ${importRuns.createdAt})
            < now() - make_interval(secs => ${staleMs / 1000})`,
        ),
      )
      .returning({ id: importRuns.id })
      .then(async (rows) => {
        if (rows.length > 0) {
          await tx.queueEvent(
            importRunEvent(orgId, row.id, row.status === "running" ? "failed" : prior),
          )
        }
        return rows
      }),
  )
  if (moved.length === 0) return false
  if (row.status === "running") {
    // Rows a crash left unrecorded become undoable.
    await recoverLedger(orgId, row.id)
    // Files the run staged for its handlers, and the quota they held.
    await deleteRunStaging(orgId, row.id).catch((err) =>
      log.error({ err, orgId, runId: row.id }, "stalled run's staged files not deleted"),
    )
  }
  return true
}

export async function sweepStaleImportRuns(
  staleMs: number = STALE_RUN_MS,
): Promise<{ swept: number }> {
  let swept = 0
  // An org being moved keeps its rows as they are; the sweep takes it up again
  // when the move ends. An unreadable state fails the sweep (it retries).
  const moving = new Set(await movingOrgIds())
  for (const row of await staleRuns(staleMs)) {
    if (moving.has(row.org_id)) continue
    try {
      if (await failStalledRun(row, staleMs)) swept++
    } catch (err) {
      log.error({ err, orgId: row.org_id, runId: row.id }, "stale import run sweep failed")
    }
  }
  if (swept > 0) log.warn({ swept }, "stalled import runs failed")
  return { swept }
}
