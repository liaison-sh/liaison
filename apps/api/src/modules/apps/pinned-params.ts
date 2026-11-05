// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Pinned params: the params a gated tool's preflight sets on the staged call
 * (the approval card shows them, the execution checks them). A pinned key is a
 * top-level param name, never a dotted path.
 */

/** The pinned key a param path reaches: the key itself, a field under it, or
 *  a field above it. Null when none. */
export function pinnedOverlap(pinned: readonly string[], field: string): string | null {
  for (const p of pinned) {
    if (field === p || field.startsWith(`${p}.`) || p.startsWith(`${field}.`)) return p
  }
  return null
}
