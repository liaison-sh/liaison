// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The accounting factory: the cached figures an accounting app's Home
// dashboard reads (the account class map, the P&L snapshot, the cash
// snapshot), as its refresh job writes them.
//
// Privileged: the app's refresh job writes these tables from a live
// accounting connection over time; a seeded org has no connection, so the
// rows go in over the system connection through the app-table writer. The
// app's list screens refetch live and are deliberately left in their "not
// connected" state: faking a credential would be a lie the org cannot keep.
import { withSystemDb } from "~/db/privileged"
import type { SeedContext } from "~/seed/context"
import { iso, jsonCell, shiftTime, upsertAppRow } from "../app-tables"

export interface PnlFigures {
  revenueMinor: bigint
  cogsMinor: bigint
  opexMinor: bigint
  otherMinor: bigint
  grossMarginMinor: bigint
}

export interface AccountingSnapshotInput {
  accountClassMap: readonly { prefix: string; class: "revenue" | "cogs" | "opex" | "other" }[]
  pnl: PnlFigures
  /** Cash held per currency, in minor units. */
  cashByCurrency: Record<string, bigint>
}

/** Writes the snapshots, refreshed two hours before `ctx.now`. */
export async function seedAccountingSnapshot(
  ctx: SeedContext,
  input: AccountingSnapshotInput,
): Promise<void> {
  const { orgId, now } = ctx
  const refreshedAt = iso(shiftTime(now, 0, -2))
  const { pnl } = input
  await withSystemDb("seed-accounting-snapshot", async (tx) => {
    for (const m of input.accountClassMap) {
      await upsertAppRow(tx, "pennylane", "account_class_map", {
        id: ctx.id("account_class", m.prefix),
        org_id: orgId,
        prefix: m.prefix,
        class: m.class,
        created_at: iso(shiftTime(now, -300)),
        updated_at: iso(shiftTime(now, -300)),
      })
    }
    await upsertAppRow(tx, "pennylane", "pnl_snapshot", {
      id: ctx.id("pnl_snapshot", "current"),
      org_id: orgId,
      period: "current",
      revenue: pnl.revenueMinor.toString(),
      cogs: pnl.cogsMinor.toString(),
      opex: pnl.opexMinor.toString(),
      other: pnl.otherMinor.toString(),
      gross_margin: pnl.grossMarginMinor.toString(),
      refreshed_at: refreshedAt,
      created_at: refreshedAt,
      updated_at: refreshedAt,
    })
    // `total_by_currency` is a JSON STRING inside the json column: that is what
    // the refresh job writes (`JSON.stringify(totals)`) and what `home_load`
    // reads back with `JSON.parse`. Writing a bare object here would make the
    // dashboard throw on parse.
    const totals = Object.fromEntries(
      Object.entries(input.cashByCurrency).map(([cur, v]) => [cur, v.toString()]),
    )
    await upsertAppRow(tx, "pennylane", "cash_snapshot", {
      id: ctx.id("cash_snapshot", "current"),
      org_id: orgId,
      total_by_currency: jsonCell(JSON.stringify(totals)),
      cash_status: "live",
      refreshed_at: refreshedAt,
      created_at: refreshedAt,
      updated_at: refreshedAt,
    })
  })
}
