// SPDX-License-Identifier: FSL-1.1-ALv2
import { primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

/**
 * kernel.config_applied_fields (migration 0243): the last-applied record of
 * `liaison config apply` (cli/config/drift.ts), one row per org and config
 * path. `valueHash` is a sha256 of the stored value as read back after the
 * apply, never the value. Readable by the row's org for holders of
 * `kernel:org:admin`; written only through the privileged connection.
 */
export const configAppliedFields = kernel.table(
  "config_applied_fields",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    valueHash: text("value_hash").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    /** Who applied: the CLI's `--applied-by` label, else `cli:<user>@<host>`. */
    appliedBy: text("applied_by").notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.path] })],
)

export type ConfigAppliedFieldRow = typeof configAppliedFields.$inferSelect
