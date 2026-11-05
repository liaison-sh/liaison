// SPDX-License-Identifier: FSL-1.1-ALv2
import { index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "~/db/schema/kernel/users"
import { appProjects } from "./projects"

/**
 * Reusable project templates — a stored task tree (`structure` jsonb) that
 * `instantiateTemplate` materializes into a fresh project. Org-scoped.
 */
export const projectTemplates = appProjects.table(
  "project_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    structure: jsonb("structure").notNull().default("[]"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_project_templates_org").on(t.orgId)],
)
