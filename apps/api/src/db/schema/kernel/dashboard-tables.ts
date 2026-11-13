// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import type { DashboardOrgAccess } from "./dashboards"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * A dashboard table (migration 0298): typed columns people and agents write rows into. Its rows
 * live in kernel.app_documents (app `dashboards`, collection `t_<id hex>`), whose restrictive
 * policies follow this row's sharing. Shared as dashboards are: its owner, `orgAccess` and
 * kernel.resource_grants rows of type `kernel.dashboard_table`.
 */
export const dashboardTables = kernel.table(
  "dashboard_tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    columns: jsonb("columns").$type<Record<string, unknown>[]>().notNull().default([]),
    /** Dropped columns (their labels for history); a dropped key is never reused. */
    droppedColumns: jsonb("dropped_columns")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    /** A project's tasks as the rows (migration 0304, tables/backing.ts); null = a plain table. */
    backing: jsonb("backing").$type<Record<string, unknown> | null>(),
    agentWritesNeedApproval: boolean("agent_writes_need_approval").notNull().default(false),
    orgAccess: text("org_access").$type<DashboardOrgAccess>().notNull().default("none"),
    aclUserIds: jsonb("acl_user_ids").$type<string[]>().notNull().default([]),
    aclRoleIds: jsonb("acl_role_ids").$type<string[]>().notNull().default([]),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    version: integer("version").notNull().default(1),
    /** Moves with every row write, in its transaction: cached block reads key on it. */
    rowsGeneration: bigint("rows_generation", { mode: "number" }).notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "dashboard_tables_org_access_check",
      sql`${table.orgAccess} IN ('none', 'viewer', 'editor')`,
    ),
    uniqueIndex("dashboard_tables_org_name_uidx").on(table.orgId, sql`lower(${table.name})`),
    index("dashboard_tables_owner_user_fk_idx")
      .on(table.ownerUserId)
      .where(sql`${table.ownerUserId} IS NOT NULL`),
    index("dashboard_tables_created_by_fk_idx")
      .on(table.createdBy)
      .where(sql`${table.createdBy} IS NOT NULL`),
    index("dashboard_tables_updated_by_fk_idx")
      .on(table.updatedBy)
      .where(sql`${table.updatedBy} IS NOT NULL`),
  ],
)

export type DashboardTableRow = typeof dashboardTables.$inferSelect

export type DashboardTableChangeOp = "create" | "update" | "delete" | "undo"

/**
 * One row write of a dashboard table (migration 0298): the cells before and after (the changed
 * cells only, for an update), who made it and when. No foreign key to the table: the history
 * outlives a deleted table for retention and export, and no RLS reader sees it then.
 */
export const dashboardTableChanges = kernel.table(
  "dashboard_table_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tableId: uuid("table_id").notNull(),
    rowId: text("row_id").notNull(),
    op: text("op").$type<DashboardTableChangeOp>().notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    rowVersion: integer("row_version"),
    undoes: uuid("undoes"),
    actorType: text("actor_type").$type<"user" | "agent" | "system">().notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    agentId: uuid("agent_id"),
    routineId: uuid("routine_id"),
    approvalId: uuid("approval_id"),
    actorLabel: text("actor_label"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("dashboard_table_changes_row_idx").on(
      table.orgId,
      table.tableId,
      table.rowId,
      table.at.desc(),
    ),
    index("dashboard_table_changes_table_idx").on(table.orgId, table.tableId, table.at.desc()),
    index("dashboard_table_changes_actor_fk_idx")
      .on(table.actorId)
      .where(sql`${table.actorId} IS NOT NULL`),
    index("dashboard_table_changes_at_idx").on(table.at),
  ],
)

export type DashboardTableChangeRow = typeof dashboardTableChanges.$inferSelect
