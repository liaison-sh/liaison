// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a client is shown on a milestone's approval link, for the kernel's client
// action page: the milestone's title, its project and due day, and the hash of
// exactly that. No assignee, time, activity or comment: a client approves the
// step, never anyone's work on it.

import { createHash } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { UUID_RE } from "~/lib/uuid"
import { ProjectsServiceError } from "./statuses"

export async function milestoneClientActionView(input: {
  tx: RlsClient
  orgId: string
  targetType: string
  targetId: string
}) {
  if (input.targetType !== "milestone" || !UUID_RE.test(input.targetId))
    throw new ProjectsServiceError(404, "not_found", `No milestone ${input.targetId}.`)
  const [row] = extractRows<{
    title: string
    description: string | null
    due_on: string | null
    project_name: string
  }>(
    await input.tx.execute(drizzleSql`
      SELECT t.title, t.description, t.due_date::text AS due_on, p.name AS project_name
        FROM ${projectsRel("tasks")} t
        JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
       WHERE t.id = ${input.targetId}::uuid AND t.org_id = ${input.orgId}::uuid
         AND t.is_milestone AND t.archived_at IS NULL
       LIMIT 1`),
  )
  if (!row) throw new ProjectsServiceError(404, "not_found", `No milestone ${input.targetId}.`)
  const summary = [
    { k: "Project", v: row.project_name },
    ...(row.due_on ? [{ k: "Due", v: row.due_on }] : []),
  ]
  const text = row.description ?? null
  const sha256 = createHash("sha256")
    .update(JSON.stringify({ title: row.title, summary, text }))
    .digest("hex")
  return { title: row.title, summary, text, sha256 }
}
