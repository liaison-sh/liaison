// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Backend money helper: currency-exponent-aware major<->minor conversion.
// Boxtal is a bundled app and cannot import invoicing's money.ts (bundling
// purity rule), so this mirrors the same ISO 4217 zero-decimal set + exponent
// rule invoicing/src/money.ts and ui/PrepGrid.tsx (kit.tsx) both use — single
// source of truth for the boxtal backend package.

export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF", "CLP", "DJF", "GNF", "HUF", "ISK", "JPY", "KMF", "KRW", "PYG",
  "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
])

/** Minor-unit digit count for a currency: 0 for zero-decimal currencies, else 2. */
export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2
}

/** Convert a major-unit amount (e.g. Boxtal's `price_ht`, a decimal float) to integer minor
 *  units, exponent-aware: 9.80 EUR -> 980, but 980 JPY -> 980 (zero-decimal, no scaling). */
export function toMinor(major: number, currency: string): number {
  const scale = 10 ** currencyExponent(currency)
  return Math.round(major * scale)
}

/** Gross figure whose included tax, divided out by invoicing (round half up of
 *  gross * 10000 / (10000 + rate)), gives back exactly `net`. Mirrors invoicing's
 *  grossOfExcludedTax (invoicing/src/money.ts), see the header for why it is copied. Net to gross
 *  to net is exact: the gross is within half a unit of net * (10000 + rate) / 10000, so dividing
 *  it again lands within less than half a unit of net. */
export function grossOfExcludedTax(net: number, rateBp: number): number {
  if (rateBp <= 0) return net
  return Number((BigInt(Math.round(net)) * BigInt(10_000 + rateBp) + 5_000n) / 10_000n)
}
