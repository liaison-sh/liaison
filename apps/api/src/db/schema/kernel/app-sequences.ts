// SPDX-License-Identifier: FSL-1.1-ALv2
import { bigint, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

/**
 * kernel.app_sequences — gapless monotonic-integer allocator per
 * (org_id, app_id, key). See K3 design notes in spec §K3 and migration
 * comment in `0000_initial.sql`. The allocator runs INSIDE the calling
 * tool-handler's transaction so a rolled-back tx releases its advisory
 * lock without consuming a value.
 */
export const appSequences = kernel.table(
  "app_sequences",
  {
    // I-DB-4 — org referential integrity + cascade.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appId: text("app_id").notNull(),
    key: text("key").notNull(),
    value: bigint("value", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.appId, table.key] })],
)
