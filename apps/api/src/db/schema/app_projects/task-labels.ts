// SPDX-License-Identifier: FSL-1.1-ALv2

import { index, timestamp, unique, uuid } from "drizzle-orm/pg-core"
import { labels } from "./labels"
import { appProjects } from "./projects"
import { tasks } from "./tasks"

/**
 * A task's own label value per group (migration 0242): at most one row per
 * (org, task, group). The composite FK (value_id, group_id, org_id) ->
 * labels (id, parent_id, org_id), which proves the value belongs to the group
 * and the org, lives in the migration only. RLS: read with
 * `projects:projects:read`, written with `projects:tasks:write`, both also
 * requiring the task in the same org.
 */
export const taskLabels = appProjects.table(
  "task_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => labels.id, { onDelete: "restrict" }),
    valueId: uuid("value_id").notNull(),
  },
  (t) => [
    unique().on(t.orgId, t.taskId, t.groupId),
    index("idx_app_projects_task_labels_group_id_value_id").on(t.orgId, t.groupId, t.valueId),
  ],
)
