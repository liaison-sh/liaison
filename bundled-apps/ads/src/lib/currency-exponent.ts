// SPDX-License-Identifier: FSL-1.1-ALv2
// Currency minor-unit exponent table. 0 = no decimal (JPY, VND, KRW, ...),
// 2 = standard (USD, EUR, GBP, ...), 3 = Kuwaiti (KWD, BHD, OMR, ...).
// Shared between meta-client.ts and ui-logic.ts — single source of truth.

const ZERO_DECIMAL = new Set([
  "JPY",
  "KRW",
  "VND",
  "BIF",
  "CLP",
  "GNF",
  "ISK",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "XAF",
  "XOF",
  "XPF",
])
const THREE_DECIMAL = new Set(["KWD", "BHD", "OMR", "JOD"])

export function currencyExponent(currency: string): number {
  const c = (currency ?? "USD").toUpperCase()
  if (ZERO_DECIMAL.has(c)) return 0
  if (THREE_DECIMAL.has(c)) return 3
  return 2
}
