// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The task a conversation is the discussion of. Every task owns a hidden
 * discussion thread (`tasks.thread_id`, `created_from` = the task). An agent
 * asked there to "break this task into subtasks" needs the task's id or key as
 * `parentTaskId`; without it, it called `projects:create` with neither a
 * parent nor a project and was refused as ambiguous. Two readers use this: the
 * turn's context (it names the task the discussion is about) and the
 * ambiguous-project refusal (it names that task as the parent to pass). Neither
 * creates anything: a call that names no parent is still refused.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import { UUID_RE } from "~/lib/uuid"

type SqlClient = RlsClient | RlsTx

export interface DiscussionTask {
  id: string
  /** `<project key>-<number>`, the form `parentTaskId` also accepts. */
  key: string
  title: string
  projectId: string
  projectName: string
}

/** The task by its own id, or the task whose discussion thread is `threadId`. */
export async function loadDiscussionTask(
  tx: SqlClient,
  orgId: string,
  by: { taskId: string } | { threadId: string },
): Promise<DiscussionTask | null> {
  const id = "taskId" in by ? by.taskId : by.threadId
  if (!UUID_RE.test(id)) return null
  const match =
    "taskId" in by ? drizzleSql`t.id = ${id}::uuid` : drizzleSql`t.thread_id = ${id}::uuid`
  const rows = extractRows<{
    id: string
    number: number
    title: string
    project_id: string
    project_key: string
    project_name: string
  }>(
    await tx.execute(drizzleSql`
      SELECT t.id::text AS id, t.number, t.title, t.project_id::text AS project_id,
             p.key AS project_key, p.name AS project_name
      FROM ${projectsRel("tasks")} t
      JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
      WHERE t.org_id = ${orgId}::uuid AND ${match}
      LIMIT 1
    `),
  )
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    key: `${row.project_key}-${row.number}`,
    title: row.title,
    projectId: row.project_id,
    projectName: row.project_name,
  }
}

/** The context line naming the task a discussion is about. */
export function renderDiscussionTaskContext(task: DiscussionTask): string {
  return (
    `The task this discussion is about: ${task.key} "${task.title}" (id: ${task.id}), ` +
    `in project "${task.projectName}" (id: ${task.projectId}). ` +
    `A subtask of it is created with projects__create and parentTaskId "${task.key}" ` +
    "(or its id): it then goes in the same project."
  )
}
