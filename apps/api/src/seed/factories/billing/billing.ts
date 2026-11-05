// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The billing factories: the rows a managed cell holds about money, written in
// their schema's shape for a test that needs one in a given state.
//
//  - `seedOrgBillingState`: the row a control plane billing push leaves
//    (`modules/cloud/billing.ts`, `applyBillingPush`), without the push's side
//    effects on the org (its tier and caps), so a test that only needs the
//    status keeps the org it made;
//  - `seedCreditBalance` / `seedCreditTransactions`: a balance and ledger rows
//    as the meter and the top-up path leave them (the credit service's own
//    entry points, `addCredits` and friends, are the seed route's way:
//    test-support/seed/agent.ts `setCreditBalance`);
//  - `seedModelPricingRows`: catalog rows for named models;
//  - `setSystemConfig` / `setInstanceSetting`: one instance-wide key.
//
// Privileged: these tables are written by the product over the privileged
// connection only (their RLS policies grant the org SELECT).
import type { CloudAutoTopUp } from "@liaison/control-plane-contract"
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import {
  creditBalances,
  creditTransactions,
  instanceSettings,
  modelPricing,
  orgBillingState,
  systemConfig,
} from "~/db/schema/kernel"

/** Auto top-up off, the default a push carries for an org that never set it. */
export const AUTO_TOP_UP_OFF: CloudAutoTopUp = {
  enabled: false,
  thresholdCredits: 10,
  amountCredits: 50,
}

const DAY_MS = 86_400_000

export interface BillingStateSeed {
  plan?: string
  status?: string
  /** Default: 20 days from now. */
  periodEnd?: Date
  /** Default "100". */
  includedCredits?: string | number
  caps?: Record<string, number | null>
  autoTopUp?: CloudAutoTopUp
  accessUntil?: Date | null
  closedAt?: Date | null
  /** Default 1. */
  version?: number
}

/**
 * Write the org's billing state. `onConflict`: "error" (default) fails on an
 * org that already has one, "status" keeps the stored row and changes only its
 * status, "replace" overwrites the plan, status, period end and included
 * credits and bumps the version (a newer push).
 */
export async function seedOrgBillingState(
  orgId: string,
  state: BillingStateSeed = {},
  opts: { onConflict?: "error" | "status" | "replace" } = {},
): Promise<void> {
  const values = {
    orgId,
    version: state.version ?? 1,
    plan: state.plan ?? "base",
    status: state.status ?? "active",
    periodEnd: state.periodEnd ?? new Date(Date.now() + 20 * DAY_MS),
    includedCredits: String(state.includedCredits ?? "100"),
    caps: state.caps ?? {},
    autoTopUp: state.autoTopUp ?? AUTO_TOP_UP_OFF,
    accessUntil: state.accessUntil ?? null,
    closedAt: state.closedAt ?? null,
  }
  await withSystemDb("seed-org-billing-state", async (db) => {
    const insert = db.insert(orgBillingState).values(values)
    const mode = opts.onConflict ?? "error"
    if (mode === "error") return insert
    if (mode === "status") {
      return insert.onConflictDoUpdate({
        target: orgBillingState.orgId,
        set: { status: values.status },
      })
    }
    return insert.onConflictDoUpdate({
      target: orgBillingState.orgId,
      set: {
        plan: values.plan,
        status: values.status,
        periodEnd: values.periodEnd,
        includedCredits: values.includedCredits,
        version: sql`${orgBillingState.version} + 1`,
      },
    })
  })
}

/**
 * The org's credit balance. On an org that already has one, `onConflict`
 * "included" (default "error") rewrites only the included balance.
 */
export async function seedCreditBalance(
  orgId: string,
  balance: { included: string; purchased?: string; currency?: string },
  opts: { onConflict?: "error" | "included" } = {},
): Promise<void> {
  await withSystemDb("seed-credit-balance", async (db) => {
    const insert = db.insert(creditBalances).values({
      orgId,
      includedBalance: balance.included,
      purchasedBalance: balance.purchased ?? "0",
      currency: balance.currency ?? "EUR",
    })
    if ((opts.onConflict ?? "error") === "error") return insert
    return insert.onConflictDoUpdate({
      target: creditBalances.orgId,
      set: { includedBalance: balance.included },
    })
  })
}

export type CreditTransactionSeed = typeof creditTransactions.$inferInsert

/** Ledger rows, as written (no balance is moved). */
export async function seedCreditTransactions(rows: CreditTransactionSeed[]): Promise<void> {
  if (rows.length === 0) return
  await withSystemDb("seed-credit-transactions", (db) => db.insert(creditTransactions).values(rows))
}

export type ModelPricingSeed = typeof modelPricing.$inferInsert

/** Catalog rows for named models; a model already priced keeps its row. */
export async function seedModelPricingRows(rows: ModelPricingSeed[]): Promise<void> {
  if (rows.length === 0) return
  await withSystemDb("seed-model-pricing-rows", (db) =>
    db.insert(modelPricing).values(rows).onConflictDoNothing(),
  )
}

/** Set one `kernel.system_config` key (insert, or replace its value). */
export async function setSystemConfig(key: string, value: unknown): Promise<void> {
  await withSystemDb("seed-system-config", (db) =>
    db
      .insert(systemConfig)
      .values({ key, value, updatedAt: sql`now()` })
      .onConflictDoUpdate({ target: systemConfig.key, set: { value, updatedAt: sql`now()` } }),
  )
}

/** Set one `kernel.instance_settings` key (insert, or replace its value). */
export async function setInstanceSetting(key: string, value: unknown): Promise<void> {
  await withSystemDb("seed-instance-setting", (db) =>
    db
      .insert(instanceSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: instanceSettings.key, set: { value } }),
  )
}
