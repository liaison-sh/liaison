// SPDX-License-Identifier: FSL-1.1-ALv2
// Projects' routine flow record (0303): a task is the trigger record of a routine flow
// (`entities.task.routineFlow` in app.manifest.json). The kernel reads it only through these two
// exports (modules/agent/routines/flow-records.ts), as the actor whose RLS `tx` carries.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import type { FlowRecord } from "~/modules/agent/routines/flow-records"
import { projectsRel } from "./schema-refs"
import { loadTaskDetails } from "./service/task-detail"

/** The tasks as the actor reads them: a hidden task is absent. */
export async function routineFlowReadRecords(
  tx: RlsClient | RlsTx,
  orgId: string,
  ids: readonly string[],
  opts: { includeArchived?: boolean } = {},
): Promise<FlowRecord[]> {
  const tasks = await loadTaskDetails(tx, orgId, ids, { includeArchived: opts.includeArchived })
  return tasks.map((t) => ({
    id: t.id,
    containerId: t.projectId,
    statusId: t.statusId,
    assigneeId: t.assigneeId,
    assigneeName: t.assignee?.name ?? null,
    title: t.title,
    key: t.key ?? null,
    fields: t.fields ?? {},
    statusEnteredAt: t.statusEnteredAt,
  }))
}

/** How many open (non-terminal, not binned) tasks of the project each candidate holds. */
export async function routineFlowLeastLoaded(
  tx: RlsClient | RlsTx,
  orgId: string,
  projectId: string,
  candidates: readonly string[],
): Promise<Array<{ userId: string; open: number }>> {
  if (candidates.length === 0) return []
  const rows = extractRows<{ assignee_id: string; n: number }>(
    await tx.execute(drizzleSql`
      SELECT t.assignee_id::text AS assignee_id, count(*)::int AS n
        FROM ${projectsRel("tasks")} t
        JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id AND s.org_id = t.org_id
       WHERE t.org_id = ${orgId}::uuid AND t.project_id = ${projectId}::uuid
         AND NOT s.terminal AND t.archived_at IS NULL
         AND t.assignee_id IN (${drizzleSql.join(
           candidates.map((c) => drizzleSql`${c}::uuid`),
           drizzleSql`, `,
         )})
       GROUP BY t.assignee_id`),
  )
  return rows.map((r) => ({ userId: r.assignee_id, open: r.n }))
}
