// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An editable field stored in one unit and read in another: minutes shown as hours, an
// amount in minor units (cents) shown in the currency's own units. The card shows and takes
// the person's unit; the payload keeps the stored one.

/** Digits after the point for a currency (2 when unknown). */
function fractionDigits(currency: unknown): number {
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return 2
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    )
  } catch {
    return 2
  }
}

/** The stored value as the person reads it, as the input's text. */
export function shownValue(unit: string | undefined, stored: unknown, currency?: unknown): string {
  if (stored === undefined || stored === null || stored === "") return ""
  if (unit === "hours") {
    const n = Number(stored)
    return Number.isFinite(n) ? String(Math.round((n / 60) * 100) / 100) : String(stored)
  }
  if (unit === "money") {
    const s = String(stored)
    if (!/^\d+$/.test(s)) return s
    const d = fractionDigits(currency)
    if (d === 0) return s
    const padded = s.padStart(d + 1, "0")
    return `${padded.slice(0, -d)}.${padded.slice(-d)}`
  }
  return String(stored)
}

/**
 * What the person typed, back in the stored unit; undefined when it is not a value of that
 * unit (the draft keeps what it had). `money` keeps a string param a string.
 */
export function storedValue(
  unit: string | undefined,
  typed: string,
  previous: unknown,
  currency?: unknown,
): unknown {
  const t = typed.trim().replace(",", ".")
  if (unit === "hours") {
    const n = Number(t)
    return t !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n * 60) : undefined
  }
  if (unit === "money") {
    const d = fractionDigits(currency)
    const m = new RegExp(`^(\\d+)(?:\\.(\\d{0,${d}}))?$`).exec(t)
    if (!m) return undefined
    const minor =
      BigInt(m[1] ?? "0") * 10n ** BigInt(d) + BigInt((m[2] ?? "").padEnd(d, "0") || "0")
    return typeof previous === "number" ? Number(minor) : minor.toString()
  }
  return typed
}
