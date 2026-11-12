// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
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

/**
 * The time range one person last chose on one dashboard (migration 0287), so it opens on it
 * next time. FORCE RLS: a person reads and writes their own rows only, and only for a
 * dashboard they can see.
 */
export const dashboardViewerStates = kernel.table(
  "dashboard_viewer_states",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** NULL: the person never chose a range (migration 0290). */
    timeRange: jsonb("time_range").$type<Record<string, unknown>>(),
    compare: text("compare"),
    /** The filter values the person last chose: {filterId: [values]}. */
    filters: jsonb("filters").$type<Record<string, string[]>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.dashboardId, table.userId] }),
    index("dashboard_viewer_states_user_fk_idx").on(table.userId),
    index("dashboard_viewer_states_org_idx").on(table.orgId),
  ],
)

export type DashboardViewerStateRow = typeof dashboardViewerStates.$inferSelect

/**
 * The title and spec of each saved version of a dashboard (migration 0291), the last 20 kept,
 * for history and revert. FORCE RLS: readable, addable and prunable with the dashboard itself.
 */
export const dashboardVersions = kernel.table(
  "dashboard_versions",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    /** The dashboard's visibility when this was saved (null: saved before it was recorded). */
    visibility: text("visibility").$type<DashboardVisibility>(),
    savedBy: uuid("saved_by").references(() => users.id, { onDelete: "set null" }),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.dashboardId, table.version] }),
    index("dashboard_versions_org_idx").on(table.orgId),
    index("dashboard_versions_saved_by_fk_idx")
      .on(table.savedBy)
      .where(sql`${table.savedBy} IS NOT NULL`),
  ],
)

export type DashboardVersionRow = typeof dashboardVersions.$inferSelect
