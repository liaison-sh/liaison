// SPDX-License-Identifier: FSL-1.1-ALv2
import { dimensionDefRegistry } from "~/modules/apps/app-registries"

export type DimensionType = "membership" | "level" | "enum"

export interface DimensionCatalogEntry {
  /** Full dimension key including app prefix (e.g. "tickets:team"). */
  key: string
  app: string
  type: DimensionType | string
  /** Ordered values for level-type dimensions. */
  order?: string[]
  /** Enumerated values for enum/membership dimensions. */
  values?: string[]
  /** Admin-UI label, eg. "Team". Defaults to the capitalized key segment. */
  label?: string
  description?: string
  /**
   * Optional href to a settings page that manages this dimension's values.
   * Set when the values catalog is dynamic and not enumerable from the
   * manifest (eg. mail inboxes are per-org accounts).
   */
  manageHref?: string
}

const cache = new Map<string, DimensionCatalogEntry[]>()

export function invalidateDimensionCatalog(orgId?: string): void {
  if (orgId) cache.delete(orgId)
  else cache.clear()
}

export function getDimensionCatalog(orgId: string): DimensionCatalogEntry[] {
  const hit = cache.get(orgId)
  if (hit) return hit

  const out: DimensionCatalogEntry[] = []
  const seen = new Set<string>()

  for (const [[entryOrgId, app, localKey], def] of dimensionDefRegistry.entries()) {
    if (entryOrgId !== orgId && entryOrgId !== "*") continue
    const fullKey = `${app}:${localKey}`
    if (seen.has(fullKey)) continue
    seen.add(fullKey)
    const entry: DimensionCatalogEntry = {
      key: fullKey,
      app,
      type: def.type,
    }
    if (def.order) entry.order = def.order
    if (def.values) entry.values = def.values
    if (def.label) entry.label = def.label
    if (def.description) entry.description = def.description
    if (def.manageHref) entry.manageHref = def.manageHref
    out.push(entry)
  }

  out.sort((a, b) => {
    if (a.app !== b.app) return a.app.localeCompare(b.app)
    return a.key.localeCompare(b.key)
  })

  cache.set(orgId, out)
  return out
}

/** Strict lookup — returns the catalog entry for a full key, or undefined. */
export function findDimensionEntry(orgId: string, key: string): DimensionCatalogEntry | undefined {
  return getDimensionCatalog(orgId).find((entry) => entry.key === key)
}
