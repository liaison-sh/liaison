// SPDX-License-Identifier: FSL-1.1-ALv2
import { boolean, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

export const sessions = kernel.table(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    deviceInfo: jsonb("device_info"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    isGrace: boolean("is_grace").notNull().default(false),
    // The most this session's access tokens may carry (migration 0114). NULL
    // means no ceiling (every interactive login). Set by the device flow from
    // its declared scopes and inherited by every rotated session, so a refresh
    // can never widen a restricted token to the user's full permissions.
    scopeCeiling: text("scope_ceiling").array(),
    // Rotation lineage (migration 0224, auth.ts refreshSession). NULL on rows
    // that predate it: such a row is its own family.
    familyId: uuid("family_id"),
    successorId: uuid("successor_id"),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    successorIssuedAt: timestamp("successor_issued_at", { withTimezone: true }),
    rotatedUaHash: text("rotated_ua_hash"),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_family_idx").on(table.familyId),
    uniqueIndex("sessions_refresh_token_hash_idx").on(table.refreshTokenHash),
  ],
)
