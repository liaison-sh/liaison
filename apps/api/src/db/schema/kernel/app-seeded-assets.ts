// SPDX-License-Identifier: FSL-1.1-ALv2
import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

/**
 * First-install marker for an app's Component-A asset seeding. One row per
 * `(orgId, appName)`, written the first time `reconcileDefaultDisabledSkills`
 * runs for that app in that org. Its existence makes default-disabled skill
 * seeding a strict first-install operation: once present, the reconciler never
 * re-seeds — so a user who *enabled* a default-disabled skill (by deleting its
 * `disabled_app_skills` seed row) keeps it enabled across every subsequent
 * reconcile/boot. (§3.4 / §9 #10 idempotency invariant.)
 */
export const appSeededAssets = kernel.table(
  "app_seeded_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appName: text("app_name").notNull(),
    seededAt: timestamp("seeded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("app_seeded_assets_unique_idx").on(t.orgId, t.appName)],
)

export type AppSeededAssets = typeof appSeededAssets.$inferSelect
export type NewAppSeededAssets = typeof appSeededAssets.$inferInsert
