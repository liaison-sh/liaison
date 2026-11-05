// SPDX-License-Identifier: FSL-1.1-ALv2
// Canonical knowledge sensitivity ladder — shared between API services, RLS predicates,
// and frontend grant calculators. Adding or reordering tiers requires a parallel update to
// the SQL `app_knowledge.expand_sensitivity_grants` function in the migration so the parity
// test stays green.

export const SENSITIVITY_ORDER = ["public", "internal", "confidential", "restricted"] as const

export type KnowledgeSensitivityTier = (typeof SENSITIVITY_ORDER)[number]

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}

/**
 * Expand a list of sensitivity grants into the cumulative set of tiers the caller may read.
 * The ladder is ordered least → most sensitive, so granting `confidential` implicitly grants
 * `public` and `internal`. Wildcard (`*`) short-circuits to a single-element wildcard list.
 * Unknown tiers are preserved verbatim so unrelated, externally-defined levels still pass
 * through.
 */
export function expandKnowledgeSensitivityGrants(values: string[] = []): string[] {
  if (values.includes("*")) return ["*"]

  let max = -1
  const unknown: string[] = []
  for (const value of values) {
    const index = SENSITIVITY_ORDER.indexOf(value as KnowledgeSensitivityTier)
    if (index >= 0) max = Math.max(max, index)
    else unknown.push(value)
  }

  const expanded = max >= 0 ? SENSITIVITY_ORDER.slice(0, max + 1) : []
  return unique([...expanded, ...unknown])
}
