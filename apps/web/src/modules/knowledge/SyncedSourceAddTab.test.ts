// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { canCreateOrgSource } from "~/modules/knowledge/SyncedSourceAddTab"

describe("canCreateOrgSource", () => {
  it("offers a shared source to the admin wildcard and to parent grants, as the server allows", () => {
    expect(canCreateOrgSource(["*"])).toBe(true)
    expect(canCreateOrgSource(["knowledge"])).toBe(true)
    expect(canCreateOrgSource(["knowledge:sources"])).toBe(true)
    expect(canCreateOrgSource(["knowledge:sources:manage"])).toBe(true)
    expect(canCreateOrgSource(["knowledge:documents:admin"])).toBe(true)
  })

  it("does not offer it without the scope", () => {
    expect(canCreateOrgSource(undefined)).toBe(false)
    expect(canCreateOrgSource(["knowledge:documents:read", "knowledge:sources:read"])).toBe(false)
  })
})
