// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * A picker lists org members by display name, and two Maries in the same org
 * are unremarkable. Without help the user picks blind: the list gives no way
 * to tell them apart. This computes, for one candidate list shown together,
 * which display names are AMBIGUOUS (shared by two or more candidates, once
 * case and accent are folded away) so a picker can show the disambiguating
 * email only for those rows and leave a uniquely-named candidate alone.
 */

/** Case- and accent-insensitive key a display name collides under. */
export function foldName(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
}

/**
 * The subset of names appearing two or more times in `names`, as their
 * folded keys. Compare a candidate's folded name against this set to decide
 * whether it needs disambiguating.
 */
export function ambiguousNameKeys(names: readonly string[]): Set<string> {
  const counts = new Map<string, number>()
  for (const name of names) {
    const key = foldName(name)
    if (key.length === 0) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const ambiguous = new Set<string>()
  for (const [key, count] of counts) {
    if (count > 1) ambiguous.add(key)
  }
  return ambiguous
}

/**
 * Marks each candidate in `candidates` with whether its display name is
 * ambiguous within THIS list. `getName` reads the display name off a
 * candidate; the same candidate re-shown in a differently-scoped list can
 * flip between ambiguous and unique, since the comparison is always against
 * the list it currently appears in.
 */
export function markAmbiguousNames<T>(
  candidates: readonly T[],
  getName: (candidate: T) => string,
): Array<{ candidate: T; ambiguous: boolean }> {
  const ambiguousKeys = ambiguousNameKeys(candidates.map(getName))
  return candidates.map((candidate) => ({
    candidate,
    ambiguous: ambiguousKeys.has(foldName(getName(candidate))),
  }))
}

/**
 * The label a picker row shows: the name alone when it is unique in the
 * list, or "Name (email)" when another candidate in the same list shares it.
 * Used by pickers that render one text node per row rather than a stacked
 * name/email layout.
 */
export function disambiguatedLabel(
  name: string,
  email: string | null | undefined,
  ambiguous: boolean,
): string {
  if (!ambiguous || !email) return name
  return `${name} (${email})`
}
