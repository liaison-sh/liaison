// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * How the managed edition shows AI usage (spec S18): credits, never money.
 * A credit amount is a plain number in the reader's locale; a model's price is
 * a multiplier against the model Auto runs ("≈ 1.4×", "≈ 3×").
 */
import { currentLocale } from "~/modules/i18n/i18n-context"

/** A credit amount (signed): up to two decimals, "<0.01" for a non-zero sliver. */
export function formatCreditAmount(value: string | number): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  const abs = Math.abs(n)
  if (abs > 0 && abs < 0.005) {
    return `<${new Intl.NumberFormat(currentLocale(), { minimumFractionDigits: 2 }).format(0.01)}`
  }
  return new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 2 }).format(n)
}

/** `≈ N×` against Auto; empty when unknown. */
export function formatMultiplier(multiplier: number | null | undefined): string {
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier)) return ""
  const shown = new Intl.NumberFormat(currentLocale(), {
    maximumFractionDigits: multiplier < 2 ? 1 : 0,
  }).format(multiplier)
  return `≈ ${shown}×`
}
