// SPDX-License-Identifier: FSL-1.1-ALv2
// Archive a project: it leaves the boards and the org's time tools, and keeps
// its tasks, time and every link to it. One writer for the REST archive route
// and the seed, so both refuse with the same codes.
//
// A retainer bills its project from the planned vs done card each month, so a
// project with a retainer month still to bill stays open.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { loadProjectDetail, type ProjectDetail } from "./create-project"
import { ProjectsServiceError } from "./statuses"
import { scheduleTimeBudgetsSync } from "./time-feature"

export interface ArchiveProjectArgs {
  tx: RlsClient
  orgId: string
  projectId: string
  actorId: string
  /** When it closed, for a project archived after the fact (the seed); otherwise now. */
  archivedAt?: Date
}

export async function archiveProject(args: ArchiveProjectArgs): Promise<ProjectDetail> {
  const { tx, orgId, projectId, actorId } = args
  const rows = extractRows<{ id: string; name: string }>(
    await tx.execute(drizzleSql`
      SELECT id, name FROM ${projectsRel("projects")}
      WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  if (rows.length === 0) {
    throw new ProjectsServiceError(404, "not_found", "project not found")
  }
  // A retainer bills this project from its card each month: archiving it would leave a month
  // no one can bill. Its months still to bill are timeboxes derived from the schedule.
  const held = extractRows<{ source_ref: string | null; period_end: string }>(
    await tx.execute(drizzleSql`
      SELECT source_ref, period_end::text AS period_end FROM ${projectsRel("project_timeboxes")}
       WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid
         AND source = 'retainer' AND period_end >= current_date
       ORDER BY period_end DESC LIMIT 1
    `),
  )[0]
  if (held) {
    throw new ProjectsServiceError(
      409,
      "retainer_live",
      `${rows[0]?.name ?? "This project"} stays open: a retainer bills it from its planned vs done card each month, through ${held.period_end}. Nothing was changed.`,
      {
        scheduleId: held.source_ref,
        next: `End the retainer's recurring schedule in Invoicing; the project can be archived once its last retainer month (to ${held.period_end}) has passed.`,
      },
    )
  }
  const at = args.archivedAt
    ? drizzleSql`${args.archivedAt.toISOString()}::timestamptz`
    : drizzleSql`now()`
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("projects")}
    SET archived_at = ${at}, updated_at = ${at}
    WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
  `)
  await tx.queueEvent({
    app: "projects",
    entity: "project",
    action: "archived",
    entityId: projectId,
    data: { id: projectId },
    actorId,
    actorType: "user",
    orgId,
  })
  // An archived project no longer counts for the org's time tools (time-feature.ts).
  scheduleTimeBudgetsSync(orgId, actorId)
  return loadProjectDetail(tx, orgId, projectId)
}
