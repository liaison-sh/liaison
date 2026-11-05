// SPDX-License-Identifier: FSL-1.1-ALv2
import { primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { appProjects } from "./projects"
import { tasks } from "./tasks"

/**
 * Directed task dependencies. A row `(task_id, depends_on_task_id, type)` means
 * `task_id` depends on `depends_on_task_id`. For `type='blocks'`, `task_id` is
 * BLOCKED while `depends_on_task_id` is still open. Org-scoped; cycles are
 * rejected at the service layer before insert. `id` (0208) names a row for the
 * import ledger (modules/imports), which records and undoes rows by id.
 */
export const taskDependencies = appProjects.table(
  "task_dependencies",
  {
    id: uuid("id").notNull().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: uuid("depends_on_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("blocks"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
    uniqueIndex("app_projects_task_dependencies_id_key").on(t.id),
  ],
)
