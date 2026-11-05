// SPDX-License-Identifier: FSL-1.1-ALv2
import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"
import { users } from "./users"

export const passwordResets = kernel.table(
  "password_resets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("password_resets_token_hash_idx").on(table.tokenHash)],
)
