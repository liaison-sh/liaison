// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"
import { roles } from "./roles"

export const invitations = kernel.table(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    email: text("email").notNull(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("invitations_token_hash_idx").on(table.tokenHash),
    uniqueIndex("invitations_pending_idx")
      .on(table.orgId, table.email)
      .where(sql`accepted_at IS NULL`),
  ],
)
