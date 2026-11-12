// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The data steps run once when an app that shipped in the server's source tree
// became a catalog app of the same name (migration 0293, modules/apps/moved-apps.ts).
// Instance-wide (no org column). Privileged pool only (RLS forced, no policy).

import { jsonb, primaryKey, text, timestamp } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

export const appAdoptions = kernel.table(
  "app_adoptions",
  {
    appName: text("app_name").notNull(),
    stepId: text("step_id").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    report: jsonb("report").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [primaryKey({ name: "app_adoptions_pk", columns: [table.appName, table.stepId] })],
)

export type AppAdoptionRow = typeof appAdoptions.$inferSelect
