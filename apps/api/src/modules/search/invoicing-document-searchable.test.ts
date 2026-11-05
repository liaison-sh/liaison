// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Proof that the invoicing `document` search entity's read scope is
// ENFORCED at query time, not merely declared in the manifest. Invoicing
// documents carry financial totals, so a user without the
// invoicing:documents:read grant must never see them through the global
// command palette's shared search index.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildPermissionFilter } from "~/modules/search/permission-filter"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const MANIFEST_PATH = join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json")

describe("invoicing document entity: read scope declared and enforced", () => {
  it("the real invoicing manifest declares the document entity with readScope invoicing:documents:read", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
    const entity = manifest.entities?.document
    expect(entity, "manifest.entities.document must exist").toBeDefined()
    expect(entity.searchable).toBe(true)
    expect(entity.readScope).toBe("invoicing:documents:read")
  })

  // registeredReadScopes mirrors the real index-wide shape: every searchable
  // entity's readScope across the whole org, not just invoicing's, so an actor
  // with an unrelated grant still authorizes SOMETHING and the filter is not
  // trivially null just because invoicing:documents:read is absent from scopes.
  const baseInput = {
    orgId: "org-1",
    userId: "user-1",
    dimensionGrants: {},
    registeredReadScopes: ["invoicing:documents:read", "tickets:tickets:read"],
    dimensionFields: [],
  }

  it("an actor holding only an unrelated scope gets a filter that does NOT authorize invoicing:documents:read", () => {
    const filter = buildPermissionFilter({ ...baseInput, scopes: ["tickets:tickets:read"] })
    expect(
      filter,
      "an unrelated scope must still produce SOME filter (org isolation etc)",
    ).not.toBeNull()
    expect(filter).not.toContain("invoicing:documents:read")
  })

  it("an actor holding NO registered scope at all gets null (caller must short circuit to empty)", () => {
    const filter = buildPermissionFilter({ ...baseInput, scopes: [] })
    expect(filter).toBeNull()
  })

  it("an actor holding invoicing:documents:read directly gets a filter that DOES authorize it", () => {
    const filter = buildPermissionFilter({ ...baseInput, scopes: ["invoicing:documents:read"] })
    expect(filter).not.toBeNull()
    expect(filter).toContain("invoicing:documents:read")
  })

  it("an actor holding the hierarchical parent invoicing:* also gets it (expected: hasScope is hierarchical)", () => {
    const filter = buildPermissionFilter({ ...baseInput, scopes: ["invoicing:*"] })
    expect(filter).not.toBeNull()
    expect(filter).toContain("invoicing:documents:read")
  })
})
