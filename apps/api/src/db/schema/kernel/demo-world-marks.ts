// SPDX-License-Identifier: FSL-1.1-ALv2
import { integer, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

/**
 * A demo scenario's world beat that ran, or is running, in a demo org
 * (migration 0182). `claimed` while its injector runs (stale after two
 * minutes), `succeeded` once it finished; a failed run makes its claim
 * stale, so a retry reclaims it. A mark belongs to one run of the scenario
 * (migration 0195): `runStartedAt` is that run's tour_progress.started_at, and
 * `generation` counts the runs (0 for the first), which keys each run's
 * injected entity. Reached only through the privileged connection.
 */
export const demoWorldMarks = kernel.table(
  "demo_world_marks",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tourId: text("tour_id").notNull(),
    beatId: text("beat_id").notNull(),
    state: text("state", { enum: ["claimed", "succeeded"] }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    runStartedAt: timestamp("run_started_at", { withTimezone: true }),
    generation: integer("generation").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.tourId, table.beatId] })],
)

export type DemoWorldMarkRow = typeof demoWorldMarks.$inferSelect
