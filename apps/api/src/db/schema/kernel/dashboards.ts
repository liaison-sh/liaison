// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { check, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/** Who sees a dashboard: its owner only, or the whole org. */
export type DashboardVisibility = "personal" | "org"

/**
 * A dashboard (migration 0275): blocks in `spec`, each reading a read-only
 * tool or a store query as the viewer. A personal dashboard always has an
 * owner; an org one may lose it (erasure, ON DELETE SET NULL). FORCE RLS: org
 * dashboards to the org, personal ones to their owner.
 */
export const dashboards = kernel.table(
  "dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    visibility: text("visibility").$type<DashboardVisibility>().notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "dashboards_owner_check",
      sql`${table.ownerUserId} IS NOT NULL OR ${table.visibility} = 'org'`,
    ),
    index("dashboards_org_idx").on(table.orgId, table.visibility, table.updatedAt.desc()),
    index("dashboards_owner_user_fk_idx")
      .on(table.ownerUserId)
      .where(sql`${table.ownerUserId} IS NOT NULL`),
    index("dashboards_created_by_fk_idx")
      .on(table.createdBy)
      .where(sql`${table.createdBy} IS NOT NULL`),
    index("dashboards_updated_by_fk_idx")
      .on(table.updatedBy)
      .where(sql`${table.updatedBy} IS NOT NULL`),
  ],
)

export type DashboardRow = typeof dashboards.$inferSelect
