// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B10 — Pure mapper from Shopify staff permissions (an array of
// permission strings) to the `shopify:*` scope set the Liaison user should
// hold to mirror that staff member's authority.
//
// The mapping is intentionally narrow / conservative: only permissions whose
// Liaison equivalent is implemented in this app appear in the table. Unknown
// permissions are silently ignored (the seed UI surfaces them as
// "unmapped — review manually" in Task B14).
//
// Reference: Shopify Admin API StaffMember.permissions enumeration.
// https://shopify.dev/docs/api/admin-graphql/latest/objects/StaffMember
// Captured 2026-05-26 in decisions.md §0.3b.

/** All scopes implemented by this app's mutation tools (mirror of the §3.2 table). */
const ALL_SHOPIFY_SCOPES: readonly string[] = [
  "shopify:orders:read",
  "shopify:orders:write",
  "shopify:refunds:create",
  "shopify:products:read",
  "shopify:products:write",
  "shopify:customers:read",
  "shopify:customers:write",
  "shopify:inventory:read",
  "shopify:inventory:write",
  "shopify:fulfillments:read",
  "shopify:fulfillments:write",
  "shopify:returns:read",
  "shopify:returns:write",
  "shopify:discounts:read",
  "shopify:discounts:write",
  "shopify:metafields:read",
  "shopify:metafields:write",
  "shopify:draft-orders:read",
  "shopify:draft-orders:write",
]

/**
 * Mapping table: Shopify staff permission → ordered list of Liaison scopes
 * that the permission implies. `full` is special-cased (grants everything).
 */
const PERMISSION_TO_SCOPES: Record<string, readonly string[]> = {
  read_orders: ["shopify:orders:read"],
  write_orders: ["shopify:orders:write"],
  refund_orders: ["shopify:refunds:create"],
  read_products: ["shopify:products:read"],
  write_products: ["shopify:products:write"],
  read_customers: ["shopify:customers:read"],
  write_customers: ["shopify:customers:write"],
  read_inventory: ["shopify:inventory:read"],
  write_inventory: ["shopify:inventory:write"],
  read_fulfillments: ["shopify:fulfillments:read"],
  write_fulfillments: ["shopify:fulfillments:write"],
  read_returns: ["shopify:returns:read"],
  write_returns: ["shopify:returns:write"],
  read_discounts: ["shopify:discounts:read"],
  write_discounts: ["shopify:discounts:write"],
  read_metafields: ["shopify:metafields:read"],
  write_metafields: ["shopify:metafields:write"],
  read_draft_orders: ["shopify:draft-orders:read"],
  write_draft_orders: ["shopify:draft-orders:write"],
}

export interface StaffPermissionsInput {
  permissions: readonly string[]
}

/**
 * Map a Shopify staff member's permission list to the matching `shopify:*`
 * scope set. Unknown permissions are silently dropped. `full` expands to the
 * union of every scope this app exposes.
 */
export function mapStaffPermissionsToScopes(input: StaffPermissionsInput): string[] {
  if (input.permissions.includes("full")) {
    return [...ALL_SHOPIFY_SCOPES]
  }
  const out = new Set<string>()
  for (const perm of input.permissions) {
    const scopes = PERMISSION_TO_SCOPES[perm]
    if (scopes) {
      for (const s of scopes) out.add(s)
    }
  }
  return [...out]
}
