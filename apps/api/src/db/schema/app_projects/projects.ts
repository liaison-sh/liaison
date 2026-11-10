// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import type { ValidationLevel } from "~/apps/projects/service/checklist-status"
import { users } from "~/db/schema/kernel/users"

export const appProjects = pgSchema("app_projects")

export const projects = appProjects.table(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color"),
    icon: text("icon"),
    // Short uppercase Jira-style key (e.g. "ERB") used to display tasks as
    // "ERB-12" — see apps/projects/service/task-key.ts and migration 0043.
    key: text("key").notNull(),
    // Per-project counter for atomic task-number allocation (0043); never read
    // directly by app code, only incremented via the createTask allocation
    // statement in service/tasks.ts.
    nextTaskNumber: integer("next_task_number").notNull().default(1),
    // Ordered checklist validation levels (0106); empty = plain checkbox mode.
    validationLevels: jsonb("validation_levels").$type<ValidationLevel[]>().notNull().default([]),
    // Show the checklist summary on Kanban cards (0106); on by default.
    checklistOnCards: boolean("checklist_on_cards").notNull().default(true),
    // Sidebar group heading (0250): trimmed free text, NULL = ungrouped.
    group: text("group"),
    // A work project or a sales pipeline (0295). Migration-owned: written by
    // the projects service only.
    kind: text("kind", { enum: ["work", "pipeline"] })
      .notNull()
      .default("work"),
    // The client of this project (0295): a soft reference to kernel.companies.
    companyId: uuid("company_id"),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_projects_org_updated").on(t.orgId, t.updatedAt),
    uniqueIndex("app_projects_org_key_uidx").on(t.orgId, t.key),
  ],
)
