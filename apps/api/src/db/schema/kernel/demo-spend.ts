// SPDX-License-Identifier: FSL-1.1-ALv2
import { bigint, index, primaryKey, text, timestamp } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

/**
 * The demo spend ledger (migration 0180): the durable copy of the verified
 * visitors' budget counters, in integer micro-EUR. Instance-level, reached
 * only through the privileged connection (modules/demo/demo-spend.ts).
 */
export const demoSpend = kernel.table(
  "demo_spend",
  {
    budget: text("budget").notNull(),
    key: text("key").notNull(),
    period: text("period").notNull(),
    spentMicroEur: bigint("spent_micro_eur", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.budget, table.key, table.period] }),
    index("demo_spend_updated_at_idx").on(table.updatedAt),
  ],
)
