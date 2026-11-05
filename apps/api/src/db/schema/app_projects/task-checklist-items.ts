// SPDX-License-Identifier: FSL-1.1-ALv2

import { boolean, doublePrecision, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import type { ValidationRecord } from "~/apps/projects/service/checklist-status"
import { users } from "~/db/schema/kernel/users"
import { appProjects } from "./projects"
import { tasks } from "./tasks"

/**
 * Checklist items of a task (migration 0106). `validations` maps a level id of
 * the task's project (`projects.validation_levels`) to its recorded state; a
 * missing key reads as `not_done`. `checked` is the plain-mode boolean used
 * when the project defines no levels. RLS: org predicate plus the item's task
 * in the same org; writes also need `projects:tasks:write`.
 */
export const taskChecklistItems = appProjects.table(
  "task_checklist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    position: doublePrecision("position").notNull().default(1000),
    title: text("title").notNull(),
    details: text("details"),
    checked: boolean("checked").notNull().default(false),
    validations: jsonb("validations")
      .$type<Record<string, ValidationRecord>>()
      .notNull()
      .default({}),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_task_checklist_items_task_position").on(t.taskId, t.position)],
)
