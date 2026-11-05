// SPDX-License-Identifier: FSL-1.1-ALv2
import { jsonb, text, timestamp } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

export const systemConfig = kernel.table("system_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})
