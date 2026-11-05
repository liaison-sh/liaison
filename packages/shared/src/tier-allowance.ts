// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 14 Amendment 2 — four-tier kernel enum, ordered low → high.
// Allowances are monthly included credits; control plane (Phase 18) may override.
export const TIER_ORDER = ["starter", "team", "business", "enterprise"] as const
export type OrgTier = (typeof TIER_ORDER)[number]

export const TIER_ALLOWANCE: Record<OrgTier, string> = {
  starter: "0",
  team: "500",
  business: "2500",
  enterprise: "10000",
}

/** Returns true if `a` is at or above tier `b` in the hierarchy. */
export function tierAtLeast(a: string, b: string): boolean {
  const ai = TIER_ORDER.indexOf(a as OrgTier)
  const bi = TIER_ORDER.indexOf(b as OrgTier)
  if (ai === -1 || bi === -1) return false
  return ai >= bi
}
