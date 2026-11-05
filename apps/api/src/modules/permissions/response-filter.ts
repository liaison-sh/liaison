// SPDX-License-Identifier: FSL-1.1-ALv2

import { rootLogger } from "~/lib/logger"
import { dimensionDefRegistry } from "~/modules/apps/app-registries"
import { type DimensionDefinition, matchesDimensions } from "~/modules/permissions/dimensions"

const log = rootLogger.child({ module: "response-filter" })

/**
 * The definitions of the dimensions a tool's `returns.dimensions` names, keyed
 * as it names them. A manifest names a dimension by its full key
 * (`<app>:<key>`, the key grants carry) while the registry holds each under
 * the app and its short key, so the app prefix is taken off for the lookup; a
 * bare short key is looked up as is. A dimension the org's apps do not
 * declare has no definition (filterResponse then reads it as membership).
 */
export function returnsDimensionDefs(
  orgId: string,
  appName: string,
  returnsDimensions: Record<string, string>,
): Record<string, DimensionDefinition> {
  const defs: Record<string, DimensionDefinition> = {}
  for (const dimKey of Object.values(returnsDimensions)) {
    const prefix = `${appName}:`
    const key = dimKey.startsWith(prefix) ? dimKey.slice(prefix.length) : dimKey
    const def = dimensionDefRegistry.get([orgId, appName, key])
    if (def) defs[dimKey] = def as DimensionDefinition
  }
  return defs
}

/**
 * Filter response data based on user's dimension grants.
 * Path B filtering for external API data.
 *
 * @param data - Raw data from app handler (array or single object)
 * @param returnsDimensions - Mapping from response field to dimension key (e.g. { market: "test:market" })
 * @param userGrants - User's dimension grants (e.g. { "test:market": ["eu"] })
 * @param dimensionDefs - Dimension definitions for each dimension key
 */
export function filterResponse(
  data: unknown,
  returnsDimensions: Record<string, string>,
  userGrants: Record<string, string[]>,
  dimensionDefs: Record<string, DimensionDefinition>,
): unknown {
  // No dimensions declared -> pass through
  if (Object.keys(returnsDimensions).length === 0) {
    return data
  }

  const isArray = Array.isArray(data)
  const items = isArray ? data : [data]

  // Build dimension definitions keyed by response field for matchesDimensions
  const fieldDefs: Record<string, DimensionDefinition> = {}
  const fieldGrants: Record<string, string[]> = {}

  for (const [responseField, dimensionKey] of Object.entries(returnsDimensions)) {
    const def = dimensionDefs[dimensionKey]
    if (!def) {
      log.warn(
        { dimensionKey, responseField },
        "Dimension definition not found — defaulting to membership",
      )
    }
    fieldDefs[responseField] = def ?? { type: "membership" }
    fieldGrants[responseField] = userGrants[dimensionKey] ?? []
  }

  const filtered = items.filter((item: any) => matchesDimensions(item, fieldGrants, fieldDefs))

  return isArray ? filtered : (filtered[0] ?? null)
}
