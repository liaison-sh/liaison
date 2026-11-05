// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { check, index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

export const disabledAppSkills = kernel.table(
  "disabled_app_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    appName: text("app_name").notNull(),
    skillName: text("skill_name").notNull(),
    disabledBy: text("disabled_by").notNull().default("user"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("disabled_app_skills_unique_idx").on(
      t.orgId,
      sql`COALESCE(${t.userId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.appName,
      t.skillName,
    ),
    index("disabled_app_skills_org_app_idx").on(t.orgId, t.appName, t.skillName),
    check("disabled_app_skills_disabled_by_chk", sql`${t.disabledBy} IN ('seed','user')`),
  ],
)

export type DisabledAppSkill = typeof disabledAppSkills.$inferSelect
export type NewDisabledAppSkill = typeof disabledAppSkills.$inferInsert
