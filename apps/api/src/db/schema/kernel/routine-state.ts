// SPDX-License-Identifier: FSL-1.1-ALv2
import { jsonb, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { routines } from "./routines"

// Per-routine cross-tick scratch state. A market-intelligence watcher persists
// its last-seen value here under a routine-scoped key, then compares the next
// tick against it (web_watch). Org-scoped RLS + composite (routine_id, key) PK
// keep one routine's state invisible to another. CASCADE on routine delete so
// no orphan state survives.
export const routineState = kernel.table(
  "routine_state",
  {
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value"),
    contentHash: text("content_hash"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.routineId, t.key] })],
)

export type RoutineState = typeof routineState.$inferSelect
export type NewRoutineState = typeof routineState.$inferInsert
