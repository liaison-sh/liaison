// SPDX-License-Identifier: FSL-1.1-ALv2
import type { OrgCaps } from "@liaison/shared"
import { boolean, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core"

const schemaPrefix = process.env.SCHEMA_PREFIX ?? ""
if (schemaPrefix && !/^[a-z0-9_]+$/.test(schemaPrefix)) {
  throw new Error(`Invalid SCHEMA_PREFIX: "${schemaPrefix}" — must match /^[a-z0-9_]+$/`)
}
export const kernel = pgSchema(`${schemaPrefix}kernel`)

export const organizations = kernel.table("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timezone: text("timezone").notNull().default("UTC"),
  businessHours: jsonb("business_hours")
    .notNull()
    .default({ start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] }),
  defaultLocale: text("default_locale").notNull().default("en-US"),
  tier: text("tier").notNull().default("starter"),
  // No `rateLimitPerMinute` in the default: a per-org limit is an OVERRIDE of
  // the global RATE_LIMIT_DEFAULT baseline, not something every org carries.
  // Baking 100 in here meant the first unrelated org PATCH synced a phantom
  // 100 req/min limit to Redis (org/routes.ts) and silently throttled the
  // whole org — a limit the admin never set. Absent = no override.
  // No `storageQuotaGb`: the storage quota is a cap the operator sets
  // (`caps.storageGb`, migration 0237), not a setting an org admin can change.
  settings: jsonb("settings").notNull().default({
    fileSizeLimitMb: 50,
    auditRetentionDays: 90,
  }),
  /**
   * Per-org caps `{seats?, mailboxes?, storageGb?, jobsPerHour?}` (migration
   * 0237, `modules/org/caps.ts`). Set only by the operator (`liaison org caps`,
   * `limits` in `liaison config apply`); a missing key is unlimited.
   */
  caps: jsonb("caps").$type<OrgCaps>().notNull().default({}),
  updateChecksEnabled: boolean("update_checks_enabled").notNull().default(true),
  /** Setup stamp (migration 0223, `modules/apps/setup-stamp.ts`); null = never stamped. */
  appSetupStamp: text("app_setup_stamp"),
  /**
   * Set when the org's deletion starts (migration 0235, `modules/org/purge/`):
   * from then on its requests answer 410 and its jobs are dropped, and the
   * kernel immutability trigger lets the purge delete its legal records.
   * Null on every live org.
   */
  deletingAt: timestamp("deleting_at", { withTimezone: true }),
  /**
   * The org's move to another instance (migration 0269,
   * `modules/org/transfer-state/`): `draining`, `frozen`, `incoming` or
   * `moved`, with the move's id and when the state was entered. All three
   * null on an org that is not moving.
   */
  transferState: text("transfer_state"),
  transferId: uuid("transfer_id"),
  transferAt: timestamp("transfer_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})
