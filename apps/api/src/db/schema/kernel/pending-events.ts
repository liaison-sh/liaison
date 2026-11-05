// SPDX-License-Identifier: FSL-1.1-ALv2
import { bigserial, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

export const pendingEvents = kernel.table(
  "pending_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    // I-DB-2 — bigserial (int8): the outbox is on every mutation's write path;
    // a 32-bit serial wraps at ~2.1B inserts and then every INSERT fails.
    seq: bigserial("seq", { mode: "number" }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    failedAt: timestamp("failed_at", { withTimezone: true }),
  },
  (table) => [
    index("pending_events_unprocessed_idx")
      .on(table.seq)
      .where("processed_at IS NULL AND failed_at IS NULL" as any),
    index("pending_events_recovery_idx")
      .on(table.claimedAt, table.seq)
      .where("processed_at IS NULL AND claimed_at IS NOT NULL" as any),
  ],
)
