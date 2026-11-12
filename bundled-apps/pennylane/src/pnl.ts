// SPDX-License-Identifier: FSL-1.1-ALv2
import type { PnlClass } from "./types"

export interface TbLine {
  account_code: string
  label: string
  balance_minor: bigint
}
export interface PnlSummary {
  revenue: bigint
  cogs: bigint
  opex: bigint
  other: bigint
  gross_margin: bigint
}
export interface Runway {
  months: number | null
  cash_status: "live" | "unavailable"
}

/** Longest-prefix-wins so "601" beats "60". Unmatched → "other". */
export function classifyAccount(code: string, mapping: Record<string, PnlClass>): PnlClass {
  let best: { prefix: string; cls: PnlClass } | null = null
  for (const [prefix, cls] of Object.entries(mapping)) {
    if (code.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, cls }
    }
  }
  return best ? best.cls : "other"
}

export function computePnlSummary(lines: TbLine[], mapping: Record<string, PnlClass>): PnlSummary {
  const acc: Record<PnlClass, bigint> = { revenue: 0n, cogs: 0n, opex: 0n, other: 0n }
  for (const l of lines) acc[classifyAccount(l.account_code, mapping)] += l.balance_minor
  return { ...acc, gross_margin: acc.revenue - acc.cogs }
}

export function computeRunway(
  cashMinor: bigint,
  netBurnMinor: bigint,
  opts?: { cashUnavailable?: boolean },
): Runway {
  if (opts?.cashUnavailable) return { months: null, cash_status: "unavailable" }
  // cash-flow positive (net burn ≤ 0) → no finite runway, never divide by ≤ 0.
  if (netBurnMinor <= 0n) return { months: null, cash_status: "live" }
  return { months: Number(cashMinor / netBurnMinor), cash_status: "live" }
}
