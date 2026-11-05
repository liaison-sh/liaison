// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The managed edition's view of AI usage (spec S18): credits, a percentage of
// the period's credits and a price multiplier against Auto, never money. No
// currency, no provider price, no rate, no per-row token counts. The
// self-hosted edition never reaches this file: its responses stay as they
// were (S19, `money-editions.test.ts`).

import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { creditBalances, organizations, orgBillingState } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { priceMultiplier } from "~/modules/agent/credits/credit-cost"

/** Row types that spend credits. */
export const SPEND_TYPES = ["usage", "tool_usage"] as const

interface Priced {
  inputCostPerM?: unknown
  outputCostPerM?: unknown
}

/** A model row with its prices replaced by `multiplier` (`≈ N×` against Auto's model). */
export function withMultiplier<T extends Priced>(
  row: T,
  auto: Priced | null,
): Omit<T, "inputCostPerM" | "outputCostPerM"> & { multiplier: number | null } {
  const { inputCostPerM, outputCostPerM, ...rest } = row
  const priced = inputCostPerM != null && outputCostPerM != null
  return {
    ...rest,
    multiplier: priced
      ? priceMultiplier(
          { inputCostPerM, outputCostPerM },
          auto ? { inputCostPerM: auto.inputCostPerM, outputCostPerM: auto.outputCostPerM } : null,
        )
      : null,
  }
}

const fmt = (n: number) => n.toFixed(8)

export interface ManagedBalance {
  mode: "managed"
  /** The plan's kernel tier (the model picker's tier gate), not money. */
  tier: string
  credits: { included: string; purchased: string; total: string }
  period: {
    start: string | null
    end: string | null
    availableThisPeriod: string
    usedThisPeriod: string
    usedPercent: number
  }
}

/**
 * Credits left and the period's use (P2R-20). The period starts at its
 * `monthly_reset` row: available = the included credits it set + the
 * purchased balance at that moment (its `balance_after` minus its amount) +
 * every top-up since. Used = every spend since. Without a reset row yet (a
 * new org), the period is the org's whole history and the included credits
 * are the pushed plan's.
 */
export async function managedBalance(orgId: string): Promise<ManagedBalance> {
  return withPrivilegedDb(orgId, "credits-managed-balance", async (tx) => {
    const k = drizzleSql.raw(schemaRef("kernel"))
    const [bal] = await tx
      .select({
        included: creditBalances.includedBalance,
        purchased: creditBalances.purchasedBalance,
      })
      .from(creditBalances)
      .where(eq(creditBalances.orgId, orgId))
    const [org] = await tx
      .select({ tier: organizations.tier })
      .from(organizations)
      .where(eq(organizations.id, orgId))
    const [state] = await tx
      .select({ included: orgBillingState.includedCredits, periodEnd: orgBillingState.periodEnd })
      .from(orgBillingState)
      .where(eq(orgBillingState.orgId, orgId))
    const [reset] = extractRows<{
      amount: string
      balance_after: string
      created_at: Date | string
    }>(
      await tx.execute(drizzleSql`
        SELECT amount::text, balance_after::text, created_at
          FROM ${k}.credit_transactions
         WHERE org_id = ${orgId}::uuid AND type = 'monthly_reset'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`),
    )
    const start = reset ? new Date(reset.created_at).toISOString() : null
    const since = start ? drizzleSql`AND created_at >= ${start}::timestamptz` : drizzleSql``
    const spend = drizzleSql.join(
      SPEND_TYPES.map((t) => drizzleSql`${t}`),
      drizzleSql`, `,
    )
    const [sums] = extractRows<{ topups: string; used: string }>(
      await tx.execute(drizzleSql`
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE type = 'top_up'), 0)::text AS topups,
          COALESCE(SUM(ABS(amount)) FILTER (WHERE type IN (${spend})), 0)::text AS used
          FROM ${k}.credit_transactions
         WHERE org_id = ${orgId}::uuid ${since}`),
    )
    const included = Number(bal?.included ?? 0)
    const purchased = Number(bal?.purchased ?? 0)
    const used = Number(sums?.used ?? 0)
    const topups = Number(sums?.topups ?? 0)
    // No reset yet (the first period): the opening grant is what the ledger shows it was, never
    // the plan's current figure, which an upgrade raised while its difference arrived as a top-up.
    const periodIncluded = reset
      ? Number(reset.amount)
      : Math.max(0, included + purchased + used - topups)
    const purchasedAtStart = reset
      ? Math.max(0, Number(reset.balance_after) - Number(reset.amount))
      : 0
    const available = periodIncluded + purchasedAtStart + topups
    return {
      mode: "managed",
      tier: org?.tier ?? "starter",
      credits: {
        included: fmt(included),
        purchased: fmt(purchased),
        total: fmt(included + purchased),
      },
      period: {
        start,
        end: state?.periodEnd ? state.periodEnd.toISOString() : null,
        availableThisPeriod: fmt(available),
        usedThisPeriod: fmt(used),
        usedPercent: available > 0 ? Math.round((used / available) * 1000) / 10 : 0,
      },
    }
  })
}
