// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Single source of truth for the shipped locale set, shared by web
 * (i18n-context) and api (server-i18n). Derived from the `locales/<x>/`
 * directory tree via the generated module — adding a locale is FILE-ONLY
 * (drop locales/<x>/*.json, the predev/prebuild generator picks it up). I7.
 */
import { GENERATED_LOCALES } from "./locales/_generated"

export const SHIPPED_LOCALES = GENERATED_LOCALES
export type ShippedLocale = (typeof SHIPPED_LOCALES)[number]

function isShipped(value: string): value is ShippedLocale {
  return (SHIPPED_LOCALES as readonly string[]).includes(value)
}

/** A candidate's shipped base locale ("fr-FR" -> "fr"), or null when unshipped/blank. */
export function toShippedLocale(value: string | null | undefined): ShippedLocale | null {
  if (!value) return null
  const base = value.trim().split(/[-_]/)[0]?.toLowerCase()
  return base && isShipped(base) ? base : null
}

/**
 * Resolve the active locale from candidates in precedence order. The first
 * candidate whose base language ships wins; none does -> "en".
 *
 * The product's chain is: the user's EXPLICIT choice (null when they never
 * picked one) > the org default locale > the browser language > "en".
 * The api has no browser, so it stops at the org default.
 */
export function resolveLocale(...candidates: Array<string | null | undefined>): ShippedLocale {
  for (const c of candidates) {
    const hit = toShippedLocale(c)
    if (hit) return hit
  }
  return "en"
}
