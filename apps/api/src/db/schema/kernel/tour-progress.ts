// SPDX-License-Identifier: FSL-1.1-ALv2
import type { TourBeatState, TourSource, TourStatus } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { index, integer, jsonb, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * kernel.tour_progress (migration 0174): a person's progress through one
 * guided tour. The current beat is stored by id (`beatId`); its index is
 * re-derived from the tour's effective beats on every read. RLS: the person's
 * own rows in their own org; the completion consumer and the CLI write
 * through the privileged connection.
 */
export const tourProgress = kernel.table(
  "tour_progress",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tourId: text("tour_id").notNull(),
    status: text("status").$type<TourStatus>().notNull(),
    beatId: text("beat_id"),
    beatIndex: integer("beat_index").notNull().default(0),
    beatStates: jsonb("beat_states")
      .$type<Record<string, TourBeatState>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    source: text("source").$type<TourSource>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId, table.tourId] }),
    index("tour_progress_active_idx").on(table.orgId).where(sql`status = 'active'`),
    index("tour_progress_user_idx").on(table.userId),
  ],
)

export type TourProgressRow = typeof tourProgress.$inferSelect
