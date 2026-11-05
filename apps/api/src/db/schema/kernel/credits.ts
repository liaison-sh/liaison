// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

export const creditBalances = kernel.table(
  "credit_balances",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id),
    includedBalance: numeric("included_balance", { precision: 16, scale: 8 })
      .notNull()
      .default("0"),
    purchasedBalance: numeric("purchased_balance", { precision: 16, scale: 8 })
      .notNull()
      .default("0"),
    currency: text("currency").notNull().default("EUR"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Balances are floored at 0: a single oversized deduction can overshoot the
    // available balance, but must never drive a real negative balance.
    check("credit_balances_purchased_nonneg", sql`${table.purchasedBalance} >= 0`),
    check("credit_balances_included_nonneg", sql`${table.includedBalance} >= 0`),
  ],
)

export const creditTransactions = kernel.table(
  "credit_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id").references(() => users.id),
    type: text("type").notNull(),
    amount: numeric("amount", { precision: 16, scale: 8 }).notNull(),
    balanceAfter: numeric("balance_after", { precision: 16, scale: 8 }).notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    rawCost: numeric("raw_cost", { precision: 16, scale: 8 }),
    /** The provider-reported (or token-estimated) cost in USD (migration 0262). */
    rawCostUsd: numeric("raw_cost_usd", { precision: 16, scale: 8 }),
    /** USD per EUR, the daily ECB rate the meter used for this row (migration 0262). */
    usdEurRate: numeric("usd_eur_rate", { precision: 12, scale: 6 }),
    description: text("description"),
    externalPaymentRef: text("external_payment_ref"),
    cycleId: text("cycle_id"),
    /**
     * The transfer this row arrived through when its org moved here; NULL for a
     * row metered on this instance (migration 0268). The daily usage report
     * counts NULL rows only.
     */
    arrivedVia: uuid("arrived_via"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("credit_transactions_org_created_idx").on(table.orgId, table.createdAt),
    uniqueIndex("credit_txn_org_external_pay_uniq")
      .on(table.orgId, table.externalPaymentRef)
      .where(sql`external_payment_ref IS NOT NULL`),
    uniqueIndex("credit_txn_org_cycle_uniq")
      .on(table.orgId, table.cycleId)
      .where(sql`cycle_id IS NOT NULL`),
  ],
)

export const modelPricing = kernel.table(
  "model_pricing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    displayName: text("display_name").notNull(),
    inputCostPerM: numeric("input_cost_per_m", { precision: 16, scale: 8 }).notNull(),
    outputCostPerM: numeric("output_cost_per_m", { precision: 16, scale: 8 }).notNull(),
    contextWindow: integer("context_window").notNull(),
    autoEligible: boolean("auto_eligible").notNull().default(false),
    tierMinimum: text("tier_minimum").notNull().default("starter"),
    source: text("source").notNull().default("manual"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("model_pricing_provider_model_idx").on(table.provider, table.modelId)],
)
