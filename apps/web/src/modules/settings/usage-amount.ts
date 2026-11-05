// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * How one credit-ledger row's amount reads in the Usage table.
 *
 * The ledger is signed from the org's balance: a model call is a DEBIT, stored
 * negative (`deductCredits` writes `-cost`), a grant or top-up a positive
 * credit. That sign is right for the ledger and wrong for the self-hosted
 * "Activity" table, which has no Type column and lists nothing but model
 * spend under "Amount": every row read as a negative cost ("-€0.07").
 *
 * - Self-hosted (no Type column): the figure is a COST, shown unsigned.
 * - Managed (Type column): the ledger sign is kept, "+" on credits, since
 *   grants and debits share the table.
 * - Either way, a non-zero amount that rounds to zero at cents reads "<€0.01"
 *   instead of "€0.00" / "-€0.00" (a model call is rarely worth a cent).
 */
export interface UsageAmountDisplay {
  /** Printed before the formatted currency: "", "+", "<", "+<" or "-<". */
  prefix: string
  /** The value to format as currency (a string, like the ledger's). */
  value: string
  /** True for a credit on the managed ledger (the green "+" row). */
  credit: boolean
}

export function usageAmountDisplay(amount: string, managed: boolean): UsageAmountDisplay {
  const n = Number(amount)
  if (!Number.isFinite(n)) return { prefix: "", value: amount, credit: false }
  const credit = managed && n > 0
  const shown = managed ? n : Math.abs(n)
  if (n !== 0 && Math.abs(n) < 0.005) {
    // Tiny: a sub-cent magnitude. The managed ledger keeps its sign in front
    // ("-<€0.01"); the "<" says it is below the cent either way.
    const sign = credit ? "+" : managed && n < 0 ? "-" : ""
    return { prefix: `${sign}<`, value: "0.01", credit }
  }
  return { prefix: credit ? "+" : "", value: String(shown), credit }
}
