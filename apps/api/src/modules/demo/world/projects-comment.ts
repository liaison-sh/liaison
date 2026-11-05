// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `projects-comment`: the projects scenario's live event. A teammate comments
// on the visitor's seeded task ("Prepare the trade-show demo") through the
// ordinary task-comment path, so the comment lands in the task's discussion
// and the visitor is notified like any other. Fixed content, once per run of
// the scenario (starting it again posts the comment again on the same task).
import { and, sql as drizzleSql, eq, gte } from "drizzle-orm"
import { postTaskComment } from "~/apps/projects/service/task-comment"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { messages } from "~/db/schema/kernel"
import type { WorldInjector } from "~/modules/demo/world/registry"
import { worldActor, worldPersonId } from "~/seed/world/people"

export const PROJECTS_COMMENT_INJECTOR_ID = "projects-comment"

/** The visitor's seeded task (demo seed, projects part). */
export const PROJECTS_WORLD_TASK_REF = "demo:task:trade-show-demo"
export const PROJECTS_WORLD_COMMENTER = "Tobias Braun"
export const PROJECTS_WORLD_COMMENT =
  "The booth is confirmed for stand B14. Can you make sure we have four demo units charged " +
  "and the new preamp firmware on them? Happy to help pack on Wednesday."

export const projectsCommentInjector: WorldInjector = {
  id: PROJECTS_COMMENT_INJECTOR_ID,
  async injectWorldEvent({ orgId, runStartedAt }) {
    const commenterId = await worldPersonId(orgId, PROJECTS_WORLD_COMMENTER)
    const task = await withPrivilegedDb(orgId, "demo-world-projects-read", async (tx) => {
      const row = extractRows<{ id: string; thread_id: string | null }>(
        await tx.execute(
          drizzleSql`SELECT id::text AS id, thread_id::text AS thread_id FROM app_projects.tasks
            WHERE org_id = ${orgId}::uuid AND external_ref = ${PROJECTS_WORLD_TASK_REF} LIMIT 1`,
        ),
      )[0]
      if (!row) return null
      if (row.thread_id) {
        const [posted] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.threadId, row.thread_id),
              eq(messages.authorId, commenterId),
              gte(messages.createdAt, runStartedAt),
            ),
          )
          .limit(1)
        if (posted) return { id: row.id, posted: true }
      }
      return { id: row.id, posted: false }
    })
    if (!task) throw new Error("demo world: the visitor's task is not seeded")
    if (task.posted) return
    const commenter = await worldActor(orgId, commenterId)
    await withRlsContext(commenter, (tx) =>
      postTaskComment(tx, {
        orgId,
        userId: commenterId,
        taskId: task.id,
        body: PROJECTS_WORLD_COMMENT,
        requiredScopes: [],
      }),
    )
  },
  // The visitor's task: the beats after the comment open it.
  async entityOf({ orgId }) {
    return withPrivilegedDb(orgId, "demo-world-projects-task", async (tx) => {
      const row = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`SELECT id::text AS id FROM app_projects.tasks
            WHERE org_id = ${orgId}::uuid AND external_ref = ${PROJECTS_WORLD_TASK_REF} LIMIT 1`,
        ),
      )[0]
      return row?.id ?? null
    })
  },
}
