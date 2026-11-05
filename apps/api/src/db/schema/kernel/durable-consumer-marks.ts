// SPDX-License-Identifier: FSL-1.1-ALv2
import { index, primaryKey, text, timestamp } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

/**
 * "This durable consumer has already handled this outbox event."
 *
 * The outbox is at-least-once, so a consumer sees an event again whenever
 * another consumer throws or the process dies before `processed_at`. An
 * in-process set answers that until a restart, and a replay decided against
 * the world as it is then is a decision the event never asked for: the push
 * fanout would notify a recipient who gained the scope in between (A18). This
 * row is the durable answer, and nothing more: a consumer name and an event
 * id. Worker bookkeeping, never org data, so it is read and written through
 * the privileged connection only.
 */
export const durableConsumerMarks = kernel.table(
  "durable_consumer_marks",
  {
    consumer: text("consumer").notNull(),
    eventId: text("event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.consumer, table.eventId] }),
    index("durable_consumer_marks_created_idx").on(table.createdAt),
  ],
)

export type DurableConsumerMark = typeof durableConsumerMarks.$inferSelect
