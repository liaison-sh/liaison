// SPDX-License-Identifier: FSL-1.1-ALv2

import { bigint, index, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { appProjects } from "./projects"
import { tasks } from "./tasks"

/**
 * Every status change of a task (migration 0302), append-only: the status it left (null when the
 * task was created into it), the one it entered, who moved it and when; `seq` orders the rows
 * that share one `at` (one transaction's changes). RLS (restrictive, so app-wide scopes cannot
 * widen it): read and written only with the task, written with `projects:tasks:write`, never
 * updated or deleted.
 */
export const taskTransitions = appProjects.table(
  "task_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id").notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    fromStatusId: uuid("from_status_id"),
    toStatusId: uuid("to_status_id").notNull(),
    actorType: text("actor_type").$type<"user" | "agent" | "routine" | "system">().notNull(),
    actorId: uuid("actor_id"),
    agentId: uuid("agent_id"),
    routineId: uuid("routine_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_task_transitions_task_at").on(t.taskId, t.at.desc(), t.seq.desc()),
    index("idx_task_transitions_project_to_at").on(t.projectId, t.toStatusId, t.at),
  ],
)
