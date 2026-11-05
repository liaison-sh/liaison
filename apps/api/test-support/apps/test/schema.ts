// SPDX-License-Identifier: FSL-1.1-ALv2
import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core"

const schemaPrefix = process.env.SCHEMA_PREFIX ?? ""
export const appTestSchema = pgSchema(`${schemaPrefix}app_test`)

export const items = appTestSchema.table("items", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("open"),
  team: text("team").notNull(),
  sensitivity: text("sensitivity").notNull().default("public"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})
