// SPDX-License-Identifier: FSL-1.1-ALv2
// The writes on time rows that no one person's transaction may make, because
// they touch other people's own rows: a task moved to another project takes
// its time rows with it, a merged task's rows join the target's, and turning
// dated hours on tells everyone with entries on the project once on Home.
// Each runs after the person's transaction commits (it reads committed state),
// on the privileged handle. Nothing here reads activity on a schedule, and no
// row's minutes are ever shown to anyone but their author.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type PrivilegedDb } from "~/db"
import { afterCurrentCommit } from "~/db/commit-hooks"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "projects/time-rows" })

export const DATED_ON_KIND = "projects:time_budgets.dated_on"
const MAX_MINUTES = 44640

const inFlight = new Set<Promise<void>>()

/** Resolves once every time-row write queued so far has finished (tests). */
export async function awaitTimeRowWrites(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight])
}

/** Run `fn` once the caller's transaction ends, or at once outside one. */
function writeTimeRowsAfterCommit(
  orgId: string,
  reason: string,
  fn: (tx: PrivilegedDb) => Promise<void>,
): void {
  const start = () => {
    const p: Promise<void> = withPrivilegedDb(orgId, reason, fn)
      .catch((err) => log.error({ err, orgId, reason }, "time rows write failed"))
      .finally(() => inFlight.delete(p))
    inFlight.add(p)
  }
  if (!afterCurrentCommit(start)) start()
}

/** A moved task's time rows follow it to its project (the totals and the row policies read it). */
export function followTaskProject(orgId: string, taskId: string): void {
  writeTimeRowsAfterCommit(orgId, "projects-time-rows-move", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("task_time")} tt SET project_id = t.project_id, updated_at = now()
        FROM ${projectsRel("tasks")} t
       WHERE t.id = tt.task_id AND t.org_id = tt.org_id
         AND tt.org_id = ${orgId}::uuid AND tt.project_id <> t.project_id`)
    log.debug({ orgId, taskId }, "time rows followed a moved task (and its subtasks)")
  })
}

/**
 * A merge: each of the source's rows joins the target. Where the same person already has a row
 * on the target (the same day, when the target uses dated hours), the minutes are added to it;
 * otherwise the row moves to the target.
 */
export function mergeTaskTime(orgId: string, sourceId: string, targetId: string): void {
  writeTimeRowsAfterCommit(orgId, "projects-time-rows-merge", async (tx) => {
    const target = extractRows<{ project_id: string; dated: boolean }>(
      await tx.execute(drizzleSql`
        SELECT t.project_id::text AS project_id, COALESCE(p.dated_hours, false) AS dated
          FROM ${projectsRel("tasks")} t
          LEFT JOIN ${projectsRel("project_time_plan")} p ON p.project_id = t.project_id
         WHERE t.id = ${targetId}::uuid AND t.org_id = ${orgId}::uuid`),
    )[0]
    if (!target) return
    const rows = extractRows<{
      id: string
      user_id: string | null
      work_date: string
      minutes: number
    }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, user_id::text AS user_id, work_date::text AS work_date, minutes
          FROM ${projectsRel("task_time")}
         WHERE task_id = ${sourceId}::uuid AND org_id = ${orgId}::uuid`),
    )
    for (const r of rows) {
      const into = r.user_id
        ? extractRows<{ id: string }>(
            await tx.execute(drizzleSql`
              SELECT id::text AS id FROM ${projectsRel("task_time")}
               WHERE task_id = ${targetId}::uuid AND org_id = ${orgId}::uuid
                 AND user_id = ${r.user_id}::uuid
                 ${target.dated ? drizzleSql`AND work_date = ${r.work_date}::date` : drizzleSql``}
               ORDER BY work_date LIMIT 1`),
          )[0]
        : undefined
      if (into) {
        await tx.execute(drizzleSql`
          UPDATE ${projectsRel("task_time")}
             SET minutes = LEAST(minutes + ${r.minutes}, ${MAX_MINUTES}), updated_at = now()
           WHERE id = ${into.id}::uuid`)
        await tx.execute(
          drizzleSql`DELETE FROM ${projectsRel("task_time")} WHERE id = ${r.id}::uuid`,
        )
      } else {
        await tx.execute(drizzleSql`
          UPDATE ${projectsRel("task_time")}
             SET task_id = ${targetId}::uuid, project_id = ${target.project_id}::uuid,
                 updated_at = now()
           WHERE id = ${r.id}::uuid`)
      }
    }
  })
}

/** Dated hours turned on: one Home line to each person with entries on the project. */
export function tellEntrantsDatedOn(
  orgId: string,
  project: { id: string; name: string },
  actorId: string,
): void {
  writeTimeRowsAfterCommit(orgId, "projects-time-rows-dated-on", async (tx) => {
    const K = drizzleSql.raw(schemaRef("kernel"))
    const people = extractRows<{ user_id: string }>(
      await tx.execute(drizzleSql`
        SELECT DISTINCT user_id::text AS user_id FROM ${projectsRel("task_time")}
         WHERE org_id = ${orgId}::uuid AND project_id = ${project.id}::uuid
           AND user_id IS NOT NULL`),
    )
    const summary = `${project.name} now uses dated hours: from today its lead and finance see the days and hours you enter on it. What you entered before stays yours alone.`
    for (const { user_id } of people) {
      await tx.execute(drizzleSql`
        INSERT INTO ${K}.attention_events
          (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_id,
           actor_type, metadata, occurred_at, is_urgent, digest_state, digest_eligible_at, email_only)
        VALUES (${orgId}::uuid, ${user_id}::uuid, 'projects', 'project', ${project.id},
                ${DATED_ON_KIND}, 20, ${summary}, ${actorId}::uuid, 'user', '{}'::jsonb,
                now(), false, 'not_eligible', now(), false)
        ON CONFLICT (user_id, app, entity_type, entity_id, kind)
          WHERE read_at IS NULL AND email_only = false
          DO NOTHING`)
    }
  })
}
