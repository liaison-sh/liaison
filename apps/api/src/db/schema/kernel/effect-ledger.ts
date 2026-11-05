// SPDX-License-Identifier: FSL-1.1-ALv2
import { index, jsonb, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

export const EFFECT_LEDGER_STATES = ["pending", "done", "unknown"] as const
export type EffectLedgerState = (typeof EFFECT_LEDGER_STATES)[number]

/**
 * One outside effect, claimed by key before it runs (migration 0226).
 * `pending` while its claimer runs it, `done` with its result after,
 * `unknown` when the claimer died mid-way. Reached only through the
 * privileged connection (lib/effect-once.ts, the only writer).
 */
export const effectLedger = kernel.table(
  "effect_ledger",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    state: text("state", { enum: EFFECT_LEDGER_STATES }).notNull(),
    result: jsonb("result").$type<unknown>(),
    claimedBy: text("claimed_by").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp("done_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.key] }),
    index("effect_ledger_state_done_idx").on(table.state, table.doneAt),
  ],
)

export type EffectLedgerRow = typeof effectLedger.$inferSelect
