// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
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
import { kernel, organizations } from "./organizations"
import { users } from "./users"

export const savedViews = kernel.table(
  "saved_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    app: text("app").notNull(),
    viewId: text("view_id").notNull(),
    manifestKey: text("manifest_key"),
    name: text("name").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    sharedWithOrg: boolean("shared_with_org").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "chk_owner_or_default",
      sql`(${table.ownerUserId} IS NOT NULL) OR (${table.isDefault} AND ${table.sharedWithOrg})`,
    ),
    index("saved_views_sidebar_idx").on(table.orgId, table.app, table.viewId, table.ownerUserId),
    uniqueIndex("saved_views_default_manifest_key_idx")
      .on(table.orgId, table.app, table.viewId, table.manifestKey)
      .where(sql`is_default = true AND manifest_key IS NOT NULL`),
  ],
)
