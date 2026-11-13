// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task status transitions: every status change (a create into a status, an update, a move, a
// cross-project move of a whole subtree, the bulk move a status delete makes) goes through
// `recordTransitions`, which appends the rows to `task_transitions`, restarts the tasks' time in
// status (`status_entered_at`) and queues one `projects:task:status_changed` event per task.
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import type { UserContext } from "~/db/rls"
import { currentRunContext } from "~/modules/agent/runtime/run-context"

type Db = RlsClient | RlsTx

/** Who changed the status: a person, an agent acting for them, a routine, or the system. */
export interface TransitionActor {
  type: "user" | "agent" | "routine" | "system"
  /** The person the write ran as (the RLS actor); null for the system. */
  userId: string | null
  agentId: string | null
  routineId: string | null
}

/**
 * The actor of a write made in this process: the routine or agent of the run it belongs to, else
 * the person. A sandbox bridge, whose calls lose the run frame, passes its own (bridge/projects.ts).
 */
export function transitionActorFor(actor: UserContext): TransitionActor {
  const run = currentRunContext()
  const routineId = run?.routineId ?? null
  const agentId = run?.agentId ?? null
  return {
    type: routineId ? "routine" : agentId ? "agent" : "user",
    userId: actor.userId,
    agentId,
    routineId,
  }
}

export interface TransitionInput {
  taskId: string
  projectId: string
  /** The status left; null when the task was created into `toStatusId`. */
  fromStatusId: string | null
  toStatusId: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidOrNull = (v: string | null) =>
  v && UUID_RE.test(v) ? drizzleSql`${v}::uuid` : drizzleSql`NULL`

/**
 * Records status changes (rows whose from equals to are skipped): one statement for the rows, one
 * for the tasks' `status_entered_at`, one status lookup, then one compact `task:status_changed`
 * event per task {id, projectId, fromStatusId, toStatusId, labels, terminal, actor}.
 * `opts.at` (an ISO instant) dates the changes, for an import that backdates a task's creation;
 * by default they happen now.
 */
export async function recordTransitions(
  tx: Db,
  orgId: string,
  rows: readonly TransitionInput[],
  actor: TransitionActor,
  opts: { at?: string | null } = {},
): Promise<void> {
  const changes = rows.filter((r) => r.fromStatusId !== r.toStatusId)
  if (changes.length === 0) return
  const at = opts.at ? drizzleSql`${opts.at}::timestamptz` : drizzleSql`now()`
  await tx.execute(drizzleSql`
    INSERT INTO ${projectsRel("task_transitions")}
      (org_id, project_id, task_id, from_status_id, to_status_id, actor_type, actor_id, agent_id,
       routine_id, "at")
    VALUES ${drizzleSql.join(
      changes.map(
        (r) => drizzleSql`(
          ${orgId}::uuid, ${r.projectId}::uuid, ${r.taskId}::uuid, ${uuidOrNull(r.fromStatusId)},
          ${r.toStatusId}::uuid, ${actor.type}, ${uuidOrNull(actor.userId)},
          ${uuidOrNull(actor.agentId)}, ${uuidOrNull(actor.routineId)}, ${at}
        )`,
      ),
      drizzleSql`, `,
    )}
  `)
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("tasks")} SET status_entered_at = ${at}
    WHERE org_id = ${orgId}::uuid AND id IN (${drizzleSql.join(
      changes.map((r) => drizzleSql`${r.taskId}::uuid`),
      drizzleSql`, `,
    )})
  `)
  const statusIds = [
    ...new Set(changes.flatMap((r) => [r.fromStatusId, r.toStatusId]).filter((s) => s !== null)),
  ]
  const statuses = new Map(
    extractRows<{ id: string; label: string; terminal: boolean }>(
      await tx.execute(drizzleSql`
        SELECT id, label, terminal FROM ${projectsRel("project_statuses")}
        WHERE org_id = ${orgId}::uuid AND id IN (${drizzleSql.join(
          statusIds.map((id) => drizzleSql`${id}::uuid`),
          drizzleSql`, `,
        )})
      `),
    ).map((s) => [s.id, s]),
  )
  for (const r of changes) {
    const to = statuses.get(r.toStatusId)
    await tx.queueEvent({
      app: "projects",
      entity: "task",
      action: "status_changed",
      entityId: r.taskId,
      data: {
        id: r.taskId,
        projectId: r.projectId,
        fromStatusId: r.fromStatusId,
        toStatusId: r.toStatusId,
        fromStatusLabel: r.fromStatusId ? (statuses.get(r.fromStatusId)?.label ?? null) : null,
        toStatusLabel: to?.label ?? null,
        terminal: to?.terminal === true,
        actor: { type: actor.type, agentId: actor.agentId, routineId: actor.routineId },
      },
      actorId: actor.userId ?? undefined,
      actorType: actor.type === "system" ? "system" : "user",
      orgId,
    })
  }
}

export interface TaskTransition {
  id: string
  fromStatusId: string | null
  fromStatusLabel: string | null
  toStatusId: string
  toStatusLabel: string | null
  actorType: TransitionActor["type"]
  actorId: string | null
  actorName: string | null
  agentId: string | null
  routineId: string | null
  at: string
}

/**
 * A task's transitions, newest first (at most `limit`, default 50), labels and names joined. Rows
 * of one transaction share `at`; `seq` (insert order) keeps them in the order they were made.
 */
export async function listTaskTransitions(
  tx: Db,
  orgId: string,
  taskId: string,
  limit = 50,
): Promise<TaskTransition[]> {
  const rows = extractRows<{
    id: string
    from_status_id: string | null
    from_label: string | null
    to_status_id: string
    to_label: string | null
    actor_type: TransitionActor["type"]
    actor_id: string | null
    actor_name: string | null
    agent_id: string | null
    routine_id: string | null
    at: Date | string
  }>(
    await tx.execute(drizzleSql`
      SELECT x.id, x.from_status_id, fs.label AS from_label, x.to_status_id, ts.label AS to_label,
             x.actor_type, x.actor_id, u.name AS actor_name, x.agent_id, x.routine_id, x."at"
      FROM ${projectsRel("task_transitions")} x
      LEFT JOIN ${projectsRel("project_statuses")} fs ON fs.id = x.from_status_id AND fs.org_id = x.org_id
      LEFT JOIN ${projectsRel("project_statuses")} ts ON ts.id = x.to_status_id AND ts.org_id = x.org_id
      LEFT JOIN ${kernelRel("users")} u ON u.id = x.actor_id AND u.org_id = x.org_id
      WHERE x.task_id = ${taskId}::uuid AND x.org_id = ${orgId}::uuid
      ORDER BY x."at" DESC, x.seq DESC
      LIMIT ${Math.max(1, Math.min(limit, 200))}
    `),
  )
  return rows.map((r) => ({
    id: r.id,
    fromStatusId: r.from_status_id,
    fromStatusLabel: r.from_label,
    toStatusId: r.to_status_id,
    toStatusLabel: r.to_label,
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorName: r.actor_name,
    agentId: r.agent_id,
    routineId: r.routine_id,
    at: r.at instanceof Date ? r.at.toISOString() : new Date(r.at).toISOString(),
  }))
}
