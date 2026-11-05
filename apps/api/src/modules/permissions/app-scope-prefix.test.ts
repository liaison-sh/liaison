// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A hyphenated app declares its scopes under the underscore prefix
// (`mcp-manager` -> `mcp_manager:*`). Both the "has scopes of its own" check
// that allows restricting the app and the restriction itself (dropping a
// denied app's scopes) map the app name to that prefix.
import { afterEach, describe, expect, it } from "bun:test"
import { manifestRegistry } from "~/modules/apps/app-registries"
import { appHasOwnScopes } from "~/modules/apps/org-app-admin"
import { dropAppScopes } from "~/modules/permissions/permissions"
import { invalidateScopeCatalog } from "~/modules/permissions/scope-catalog"

const ORG = "00000000-0000-4000-8000-0000000007a1"

afterEach(() => {
  manifestRegistry.deleteByPrefix([ORG])
  invalidateScopeCatalog(ORG)
})

describe("app name -> scope prefix", () => {
  it("a hyphenated app owns its underscore-prefixed scopes", () => {
    // Declared through a manifest role only (no tool, so no derived `<app>:approve`).
    manifestRegistry.set([ORG, "mcp-manager"], {
      name: "mcp-manager",
      roles: { operator: { scopes: ["mcp_manager:connection:read"] } },
    } as never)
    invalidateScopeCatalog(ORG)
    expect(appHasOwnScopes(ORG, "mcp-manager")).toBe(true)
  })

  it("a denied hyphenated app loses its underscore-prefixed scopes, others stay", () => {
    expect(
      dropAppScopes(
        ["mcp_manager:audit:read", "mcp-manager:x", "mcp_manager", "tickets:tickets:read"],
        new Set(["mcp-manager"]),
      ),
    ).toEqual(["tickets:tickets:read"])
  })
})
