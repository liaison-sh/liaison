// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Restore drill markers (migration 0269): one row written when a restore drill
// starts, in the transaction that records the counts the restore must match.
// Instance-wide (no org column). Privileged pool only (RLS forced, no policy).

import { text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

export const restoreDrillMarkers = kernel.table("restore_drill_markers", {
  id: uuid("id").primaryKey().defaultRandom(),
  drillId: text("drill_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type RestoreDrillMarkerRow = typeof restoreDrillMarkers.$inferSelect
