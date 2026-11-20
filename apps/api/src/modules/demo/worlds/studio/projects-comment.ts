// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `studio-projects-comment`: the services world's projects scenario event. The
// project lead comments on a task of the fixed-price client's project through the
// ordinary task-comment path, so the comment lands in the task's discussion and
// its people are notified like for any other. Fixed content, once per run.
import { STUDIO_PROJECTS_COMMENT_INJECTOR } from "@liaison/shared"
import { and, sql as drizzleSql, eq, gte } from "drizzle-orm"
import { postTaskComment } from "~/apps/projects/service/task-comment"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { messages } from "~/db/schema/kernel"
import type { WorldInjector } from "~/modules/demo/world/registry"
import { worldActor, worldPersonId } from "~/seed/world/people"
import { studioTaskRef } from "~/seed/worlds/studio/refs"

/** The task the lead asks about: the pack seeds it (`seed/worlds/studio/plan.ts`), with no subtask. */
export const STUDIO_PROJECTS_TASK_REF = studioTaskRef("MARLIN-41")
export const STUDIO_PROJECTS_TASK_TITLE = "Beta sign-off checklist"
export const STUDIO_PROJECTS_COMMENTER = "Bastien Morel"
export const STUDIO_PROJECTS_COMMENT =
  "The partners start testing the beta on Monday and the client signs it off at the end of " +
  "the week. Can you break this checklist down: what the partners test, what we fix before " +
  "sign-off and what the client signs? I'll take the partner briefing."

export const studioProjectsCommentInjector: WorldInjector = {
  id: STUDIO_PROJECTS_COMMENT_INJECTOR,
  world: "studio",
  async injectWorldEvent({ orgId, runStartedAt }) {
    const commenterId = await worldPersonId(orgId, STUDIO_PROJECTS_COMMENTER)
    const task = await withPrivilegedDb(orgId, "demo-world-studio-projects-read", async (tx) => {
      const row = extractRows<{ id: string; thread_id: string | null }>(
        await tx.execute(
          drizzleSql`SELECT id::text AS id, thread_id::text AS thread_id FROM app_projects.tasks
            WHERE org_id = ${orgId}::uuid AND external_ref = ${STUDIO_PROJECTS_TASK_REF} LIMIT 1`,
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
    if (!task) throw new Error("demo world: the checklist task is not seeded")
    if (task.posted) return
    const commenter = await worldActor(orgId, commenterId)
    await withRlsContext(commenter, (tx) =>
      postTaskComment(tx, {
        orgId,
        userId: commenterId,
        taskId: task.id,
        body: STUDIO_PROJECTS_COMMENT,
        requiredScopes: [],
      }),
    )
  },
  // The checklist task: the beats after the comment open it.
  async entityOf({ orgId }) {
    return withPrivilegedDb(orgId, "demo-world-studio-projects-task", async (tx) => {
      const row = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`SELECT id::text AS id FROM app_projects.tasks
            WHERE org_id = ${orgId}::uuid AND external_ref = ${STUDIO_PROJECTS_TASK_REF} LIMIT 1`,
        ),
      )[0]
      return row?.id ?? null
    })
  },
}
