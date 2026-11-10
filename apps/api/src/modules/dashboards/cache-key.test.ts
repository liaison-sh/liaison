// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A block's cache key changes with anything the row policies read for the viewer: scopes,
// dimension grants AND roles (a contact shared with a role is visible only to its holders),
// so a viewer removed from a role is never answered with figures read while they held it.

import { describe, expect, it } from "bun:test"
import { permissionHash } from "~/modules/dashboards/cache"

const base = { scopes: ["kernel:contacts:read"], dimensionGrants: {} }

describe("permissionHash", () => {
  it("moves when the viewer's roles change, whatever their order", () => {
    const sales = permissionHash({ ...base, roles: ["r-sales", "r-member"] })
    expect(permissionHash({ ...base, roles: ["r-member", "r-sales"] })).toBe(sales)
    expect(permissionHash({ ...base, roles: ["r-member"] })).not.toBe(sales)
    expect(permissionHash({ ...base })).toBe(permissionHash({ ...base, roles: [] }))
  })
})
