// SPDX-License-Identifier: FSL-1.1-ALv2
// Tasks held by a live billing claim. A task on a reconciliation's draft or issued invoice cannot
// move to another project or be merged away: its claim would then bill work the other project or
// the surviving task never had. A left-off or released claim holds nothing.
//
// A system read: the person moving a task may hold no reconcile scope, and the claim must still
// refuse the move. It reads only the claim's state, the invoice number or the draft's project and
// period, and the task's title, for the refusal's words.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { ProjectsServiceError } from "./statuses"

interface Hold {
  task_id: string
  task_title: string | null
  document_number: string | null
  project_name: string | null
  period_start: string | null
  period_end: string | null
}

/** The first live claim on any of `taskIds`, or null when none is held. */
async function liveHold(orgId: string, taskIds: string[]): Promise<Hold | null> {
  if (taskIds.length === 0) return null
  return withSystemDb("projects-claim-holds", async (tx) => {
    const rows = extractRows<Hold>(
      await tx.execute(drizzleSql`
        SELECT c.source_ref AS task_id, t.title AS task_title, c.document_number,
               p.name AS project_name, r.period_start::text AS period_start,
               r.period_end::text AS period_end
          FROM ${projectsRel("billing_claims")} c
          LEFT JOIN ${projectsRel("tasks")} t ON t.org_id = c.org_id AND t.id::text = c.source_ref
          LEFT JOIN ${projectsRel("reconciliations")} r
            ON r.id = c.reconciliation_id AND r.org_id = c.org_id
          LEFT JOIN ${projectsRel("projects")} p ON p.id = c.project_id AND p.org_id = c.org_id
         WHERE c.org_id = ${orgId}::uuid AND c.source_kind = 'task'
           AND c.state IN ('reserved', 'billed')
           AND c.source_ref IN (${drizzleSql.join(
             taskIds.map((id) => drizzleSql`${id}`),
             drizzleSql`, `,
           )})
         ORDER BY c.state DESC, c.created_at
         LIMIT 1`),
    )
    return rows[0] ?? null
  })
}

/**
 * Refuse with `already_on` when a task of `taskIds` is on a live claim, naming the invoice or the
 * draft that holds it. `what` says what was asked ("moved to another project", "merged").
 */
export async function refuseClaimedTasks(
  orgId: string,
  taskIds: string[],
  what: "moved to another project" | "merged",
): Promise<void> {
  const hold = await liveHold(orgId, taskIds)
  if (!hold) return
  const on = hold.document_number
    ? `invoice ${hold.document_number}`
    : `the draft invoice for ${hold.project_name ?? "its project"}${
        hold.period_start ? `, ${hold.period_start} to ${hold.period_end}` : ""
      }`
  const task = hold.task_title ? `"${hold.task_title}"` : "This task"
  throw new ProjectsServiceError(
    409,
    "already_on",
    `${task} is on ${on}, so it was not ${what}. Nothing changed. ${
      hold.document_number
        ? `Correct ${on} with a credit note first, or leave the task where it is.`
        : `Undo the card's invoice first, or leave the task where it is.`
    }`,
    {
      taskId: hold.task_id,
      documentNumber: hold.document_number,
      draft: hold.document_number ? null : on,
    },
  )
}
