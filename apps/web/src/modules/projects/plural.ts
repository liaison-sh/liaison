// SPDX-License-Identifier: FSL-1.1-ALv2
// Locale-aware plural form selection for count-based labels.
//
// `count === 1` is correct English but wrong for other locales: French uses
// the singular form for 0 as well as 1 ("0 tache", not "0 taches"), and
// other locales have their own rules Intl.PluralRules already knows. Route
// through this instead of a hardcoded `count === 1` check anywhere a label
// picks between a singular and plural translation key.

/**
 * Returns "one" when `count` takes the singular ("one") plural category in
 * `locale`, otherwise "other" (which callers map to their plural/"many" key).
 */
export function pluralFormFor(locale: string, count: number): "one" | "other" {
  const category = new Intl.PluralRules(locale).select(count)
  return category === "one" ? "one" : "other"
}
