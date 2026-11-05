// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Liaison team outbox (migration 0244): every message this instance sends
// to the Liaison team's control plane waits here until it is delivered,
// permanently refused, cancelled or expired (`modules/liaison-team/outbox.ts`).
// Instance-wide (no org column). Privileged pool only (RLS forced, no policy).

import { sql } from "drizzle-orm"
import { check, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

export const controlPlaneOutbox = kernel.table(
  "control_plane_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The contract message type (`register`, `heartbeat`, `bug-report`, ...). */
    type: text("type").notNull(),
    /** Fixed per row, so a retry after a lost reply is deduplicated by the control plane. */
    messageId: uuid("message_id").notNull().unique(),
    /** A row (`id`) that must be delivered first; this row is cancelled when it ends otherwise. */
    dependsOn: uuid("depends_on"),
    /** The message `data`; `{}` once purged. */
    data: jsonb("data").notNull().default({}),
    /** `pending` | `sending` | `delivered` | `refused` | `cancelled` | `expired`. */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** While `sending`: the claim holds the row until then, after which a drain may reclaim it. */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** The last status change; retention counts from it. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "control_plane_outbox_status_check",
      sql`${table.status} IN ('pending', 'sending', 'delivered', 'refused', 'cancelled', 'expired')`,
    ),
  ],
)

export type ControlPlaneOutboxRow = typeof controlPlaneOutbox.$inferSelect
