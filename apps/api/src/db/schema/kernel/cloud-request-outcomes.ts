// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Outcomes of the signed Control→cell requests (migration 0247,
// `modules/cloud/outcomes.ts`): one row per endpoint and idempotency key, so a
// repeat returns the first outcome. Instance-wide (no org column). Privileged
// pool only (RLS forced, no policy).

import { integer, primaryKey, text, timestamp } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

export const cloudRequestOutcomes = kernel.table(
  "cloud_request_outcomes",
  {
    endpoint: text("endpoint").notNull(),
    idemKey: text("idem_key").notNull(),
    /** sha256 hex of the request fields a repeat must match. */
    bindingHash: text("binding_hash").notNull(),
    /** The reply's HTTP status, null while the claim is in progress. */
    statusCode: integer("status_code"),
    /** encryptSecret(JSON reply), null while the claim is in progress. */
    outcomeSealed: text("outcome_sealed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the current attempt claimed the row; a stale claim may be taken over. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Deleted once past; null keeps the row. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.endpoint, table.idemKey] })],
)

export type CloudRequestOutcomeRow = typeof cloudRequestOutcomes.$inferSelect
