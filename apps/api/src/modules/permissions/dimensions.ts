// SPDX-License-Identifier: FSL-1.1-ALv2
export interface DimensionInheritFrom {
  table: string
  localColumn: string
  remoteColumn: string
}

export interface DimensionDefinition {
  type: "membership" | "level" | "enum" | "value"
  order?: string[] // For level type
  values?: string[] // For enum type
  column?: string // Explicit column mapping (e.g. "accountId" → account_id); defaults to self-ref (id)
  inheritFrom?: DimensionInheritFrom
}

export function matchesDimensions(
  row: Record<string, unknown>,
  grants: Record<string, string[]>,
  dimensions: Record<string, DimensionDefinition>,
): boolean {
  for (const [key, def] of Object.entries(dimensions)) {
    const grantValues = grants[key]
    if (!grantValues) return false // No grant for this dimension -> deny

    if (grantValues.includes("*")) continue // Wildcard -> skip this dimension

    if (grantValues.length === 0) return false // Empty grant -> deny

    const rowValue = row[key]
    if (rowValue == null) return false // Null row value -> deny

    switch (def.type) {
      case "membership":
      case "enum":
      case "value":
        if (!grantValues.includes(String(rowValue))) return false
        break
      case "level": {
        if (!def.order) return false
        const rowIndex = def.order.indexOf(String(rowValue))
        const maxGrantIndex = Math.max(...grantValues.map((v) => def.order!.indexOf(v)))
        // If no grant values are in the order array, maxGrantIndex is -1 → deny
        if (maxGrantIndex === -1 || rowIndex === -1 || rowIndex > maxGrantIndex) return false
        break
      }
    }
  }
  return true
}
