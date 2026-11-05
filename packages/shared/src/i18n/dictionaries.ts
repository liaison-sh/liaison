// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Canonical dictionary registry. The locale→namespace→dict map is generated
 * from the `locales/<locale>/<ns>.json` directory tree into `_generated.ts`
 * (see scripts/i18n-gen-dictionaries.ts, run via predev/prebuild). Adding a
 * locale or a namespace is FILE-ONLY — drop the JSON, no hand code edit here
 * (I7). Web (i18n-context) and api (server-i18n) consume the SAME copy.
 */
import type { ShippedLocale } from "./locales"
import { GENERATED_DICTIONARIES } from "./locales/_generated"

export type LocaleDict = Record<string, unknown>
export type NamespaceDicts = Record<string, LocaleDict>

const DICTIONARIES = GENERATED_DICTIONARIES as Record<ShippedLocale, NamespaceDicts>

/**
 * All namespace dictionaries for a locale. Namespaces missing in a non-en
 * locale fall back at the namespace level to `en`; per-KEY fallback is the
 * consumer's responsibility (web `t()` / api `serverT`).
 */
export function dictionariesFor(locale: ShippedLocale): NamespaceDicts {
  return DICTIONARIES[locale] ?? DICTIONARIES.en
}

/**
 * The English dictionaries — used as the per-key fallback source by both
 * the web translator and the server translator.
 */
export function englishDictionaries(): NamespaceDicts {
  return DICTIONARIES.en
}
