// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The projects factory: project boards with their tasks, subtasks and
// dependencies, through `createProject` / `createTask` / `addDependency`, the
// projects app's own services, on an RLS transaction as the project's owner.
// A project's `key` is UNIQUE per org and a task's `externalRef` is too, which
// is what makes a re-run adopt instead of duplicate.
//
// No privileged write. Task STATUS is not an enum: a project owns its status
// rows and "done" means `terminal`; the default ladder is used throughout so a
// board reads the way a new project's would.
import { sql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { addDependency, createTask } from "~/apps/projects/service/tasks"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { seedClock } from "~/seed/clock"
import type { SeedContext } from "~/seed/context"
import { asUser, rowsOf } from "~/seed/factories/people/actors"

export interface TaskSpec {
  key: string
  title: string
  description?: string
  status: "backlog" | "todo" | "in_progress" | "done" | "cancelled"
  /** Person key. */
  assignee?: string
  priority?: "low" | "normal" | "high" | "urgent"
  /** Days from the base time. Negative is overdue. */
  dueInDays?: number
  /** Task key of the parent, for a subtask. */
  parent?: string
  /** Task keys this one is blocked by. */
  dependsOn?: string[]
}

export interface ProjectSpec {
  key: string
  name: string
  description: string
  icon: string
  /** Person key: the project's owner, who creates it and its tasks. */
  owner: string
  tasks: TaskSpec[]
}

type ExecTx = { execute: (q: unknown) => Promise<unknown> }

/** Whether a task counts as overdue: due before the base time and still open. */
export function isOverdue(task: TaskSpec): boolean {
  return (
    task.dueInDays !== undefined &&
    task.dueInDays < 0 &&
    task.status !== "done" &&
    task.status !== "cancelled"
  )
}

/**
 * Seed one project as `owner`, in one RLS transaction: the project, its tasks
 * (parents before subtasks, so a `parentTaskId` always resolves) and then the
 * dependencies, once every task id is known.
 */
export async function seedProject(
  ctx: SeedContext,
  owner: UserContext,
  input: {
    people: Record<string, { userId: string } | undefined>
    spec: ProjectSpec
    /** A task's idempotency key (UNIQUE per org), from its spec key. */
    externalRefOf: (taskKey: string) => string
  },
): Promise<{ projectId: string; taskIds: string[] }> {
  const { orgId } = ctx
  const { people, spec } = input
  const clock = seedClock(ctx.now)
  const taskIds: string[] = []
  let projectId = ""
  await asUser(owner, async (tx) => {
    const found = rowsOf<{ id: string }>(
      await (tx as ExecTx).execute(
        sql`SELECT id FROM ${sql.raw(schemaRef("app_projects"))}.projects
            WHERE org_id = ${orgId} AND key = ${spec.key} LIMIT 1`,
      ),
    )
    if (found[0]) {
      projectId = found[0].id
    } else {
      const created = await createProject({
        tx: tx as never,
        orgId,
        actor: owner,
        input: { name: spec.name, description: spec.description, icon: spec.icon, key: spec.key },
      })
      projectId = created.id
    }

    const taskIdByKey: Record<string, string> = {}
    const ordered = [...spec.tasks].sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0))
    for (const task of ordered) {
      const externalRef = input.externalRefOf(task.key)
      const existing = rowsOf<{ id: string }>(
        await (tx as ExecTx).execute(
          sql`SELECT id FROM ${sql.raw(schemaRef("app_projects"))}.tasks
              WHERE org_id = ${orgId} AND external_ref = ${externalRef} LIMIT 1`,
        ),
      )
      if (existing[0]) {
        taskIdByKey[task.key] = existing[0].id
        taskIds.push(existing[0].id)
        continue
      }
      const dueDate = task.dueInDays === undefined ? undefined : clock.daysAfter(task.dueInDays)
      const created = await createTask({
        tx: tx as never,
        orgId,
        actor: owner,
        input: {
          projectId,
          title: task.title,
          ...(task.description ? { description: task.description } : {}),
          statusLabel: task.status,
          ...(task.assignee ? { assigneeId: people[task.assignee]?.userId } : {}),
          priority: task.priority ?? "normal",
          ...(dueDate ? { dueDate: dueDate.toISOString() } : {}),
          ...(task.parent && taskIdByKey[task.parent]
            ? { parentTaskId: taskIdByKey[task.parent] }
            : {}),
          externalRef,
        } as never,
      })
      taskIdByKey[task.key] = created.id
      taskIds.push(created.id)
    }

    for (const task of spec.tasks) {
      const taskId = taskIdByKey[task.key]
      if (!taskId) continue
      for (const blockerKey of task.dependsOn ?? []) {
        const blockerId = taskIdByKey[blockerKey]
        if (!blockerId) continue
        const already = rowsOf<{ task_id: string }>(
          await (tx as ExecTx).execute(
            sql`SELECT task_id FROM ${sql.raw(schemaRef("app_projects"))}.task_dependencies
                WHERE task_id = ${taskId}::uuid AND depends_on_task_id = ${blockerId}::uuid`,
          ),
        )
        if (already.length > 0) continue
        await addDependency({
          tx: tx as never,
          orgId,
          actor: owner,
          taskId,
          dependsOnTaskId: blockerId,
          type: "blocks",
        } as never)
      }
    }
  })
  return { projectId, taskIds }
}

/**
 * One task in the project keyed `projectKey`, created by `creator` (found by
 * its external reference on a re-run). Null when the project is not there.
 */
export async function seedProjectTask(
  ctx: SeedContext,
  creator: UserContext,
  task: {
    projectKey: string
    externalRef: string
    title: string
    description: string
    statusLabel: TaskSpec["status"]
    assigneeId: string
    priority: NonNullable<TaskSpec["priority"]>
    dueInDays: number
  },
): Promise<string | null> {
  const { orgId } = ctx
  const clock = seedClock(ctx.now)
  return asUser(creator, async (tx) => {
    const existing = rowsOf<{ id: string }>(
      await tx.execute(
        sql`SELECT id FROM ${sql.raw(schemaRef("app_projects"))}.tasks
            WHERE org_id = ${orgId} AND external_ref = ${task.externalRef} LIMIT 1`,
      ),
    )
    if (existing[0]) return existing[0].id
    const project = rowsOf<{ id: string }>(
      await tx.execute(
        sql`SELECT id FROM ${sql.raw(schemaRef("app_projects"))}.projects
            WHERE org_id = ${orgId} AND key = ${task.projectKey} LIMIT 1`,
      ),
    )[0]
    if (!project) return null
    const created = await createTask({
      tx: tx as never,
      orgId,
      actor: creator,
      input: {
        projectId: project.id,
        title: task.title,
        description: task.description,
        statusLabel: task.statusLabel,
        assigneeId: task.assigneeId,
        priority: task.priority,
        dueDate: clock.daysAfter(task.dueInDays).toISOString(),
        externalRef: task.externalRef,
      } as never,
    })
    return created.id
  })
}
