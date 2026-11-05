// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { DEFAULT_ROLES } from "~/modules/permissions/default-roles"

describe("DEFAULT_ROLES", () => {
  it("declares at least admin / member / viewer as ship-with defaults", () => {
    const names = DEFAULT_ROLES.map((r) => r.name)
    expect(names).toContain("admin")
    expect(names).toContain("member")
    expect(names).toContain("viewer")
  })

  it("requires every default role to ship with a non-empty description", () => {
    for (const role of DEFAULT_ROLES) {
      expect(role.description.length).toBeGreaterThan(0)
    }
  })

  it("flags exactly one default role as the owner", () => {
    const owners = DEFAULT_ROLES.filter((r) => r.isOwner)
    expect(owners.length).toBe(1)
    expect(owners[0]?.name).toBe("admin")
  })

  it("grants the owner role full wildcard access", () => {
    const owner = DEFAULT_ROLES.find((r) => r.isOwner)
    expect(owner?.scopes).toContain("*")
  })

  it("only references kernel scopes (apps register their scopes post-bootstrap)", () => {
    for (const role of DEFAULT_ROLES) {
      for (const scope of role.scopes) {
        if (scope === "*") continue
        expect(scope.startsWith("kernel:")).toBe(true)
      }
    }
  })

  it("member gets the parent kernel:agent:memory scope (covers REST + agent-tool gate)", async () => {
    const { hasScope } = await import("~/modules/permissions/permissions")
    const member = DEFAULT_ROLES.find((r) => r.name === "member")
    expect(member).toBeDefined()
    const memberScopes = member!.scopes
    expect(hasScope("kernel:agent:memory", memberScopes)).toBe(true)
    expect(hasScope("kernel:agent:memory:read", memberScopes)).toBe(true)
    expect(hasScope("kernel:agent:memory:write", memberScopes)).toBe(true)
  })

  it("grants kernel:files:analyze to member but NOT viewer (paid spend off the read-only role)", () => {
    const member = DEFAULT_ROLES.find((r) => r.name === "member")
    const viewer = DEFAULT_ROLES.find((r) => r.name === "viewer")
    expect(member).toBeDefined()
    expect(viewer).toBeDefined()
    // Positive: the agent-capable member role holds the analyze scope.
    expect(member!.scopes).toContain("kernel:files:analyze")
    // Negative: the read-only viewer role must NOT (it would trigger paid Gemini spend).
    expect(viewer!.scopes).not.toContain("kernel:files:analyze")
  })

  it("viewer gets only the leaf :read scope (no agent-tool gate, no write)", async () => {
    const { hasScope } = await import("~/modules/permissions/permissions")
    const viewer = DEFAULT_ROLES.find((r) => r.name === "viewer")
    expect(viewer).toBeDefined()
    const viewerScopes = viewer!.scopes
    expect(hasScope("kernel:agent:memory:read", viewerScopes)).toBe(true)
    expect(hasScope("kernel:agent:memory:write", viewerScopes)).toBe(false)
    expect(hasScope("kernel:agent:memory", viewerScopes)).toBe(false)
  })
})
