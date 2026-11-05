// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { buildPermissionFilter } from "./permission-filter"

const registeredReadScopes = [
  "tickets:tickets:read",
  "kernel:threads:read",
  "projects:project:read",
]

describe("buildPermissionFilter", () => {
  it("admin with '*' authorizes every registered read scope", () => {
    const f = buildPermissionFilter({
      orgId: "org-1",
      userId: "u-1",
      scopes: ["*"],
      dimensionGrants: {},
      registeredReadScopes,
      dimensionFields: ["team"],
    })
    expect(f).toContain(`org_id = "org-1"`)
    expect(f).toContain(
      `read_scope IN ["tickets:tickets:read","kernel:threads:read","projects:project:read"]`,
    )
    expect(f).toContain(`(NOT participant_ids EXISTS OR participant_ids = "u-1")`)
    expect(f).toContain(`(NOT team EXISTS)`)
  })

  it("broader grant 'tickets' authorizes child read scope", () => {
    const f = buildPermissionFilter({
      orgId: "o",
      userId: "u",
      scopes: ["tickets"],
      dimensionGrants: {},
      registeredReadScopes,
      dimensionFields: [],
    })
    expect(f).toContain(`read_scope IN ["tickets:tickets:read"]`)
    expect(f).not.toContain("kernel:threads:read")
  })

  it("dimension grant emits OR-not-exists", () => {
    const f = buildPermissionFilter({
      orgId: "o",
      userId: "u",
      scopes: ["tickets:tickets:read"],
      dimensionGrants: { team: ["red", "blue"] },
      registeredReadScopes,
      dimensionFields: ["team"],
    })
    expect(f).toContain(`(team IN ["red","blue"] OR NOT team EXISTS)`)
  })

  it("empty authorized scopes returns null (short-circuit)", () => {
    expect(
      buildPermissionFilter({
        orgId: "o",
        userId: "u",
        scopes: ["unrelated:scope"],
        dimensionGrants: {},
        registeredReadScopes,
        dimensionFields: [],
      }),
    ).toBeNull()
  })

  it("escapes double-quotes in identifiers", () => {
    const f = buildPermissionFilter({
      orgId: 'o"1',
      userId: "u",
      scopes: ["*"],
      dimensionGrants: {},
      registeredReadScopes: [],
      dimensionFields: [],
    })
    expect(f).toBeNull()
  })
})

describe("buildPermissionFilter — app-driven dimensions", () => {
  it("uses participant_ids for personal owner-only entity types", () => {
    const filter = buildPermissionFilter({
      orgId: "org-1",
      userId: "owner-1",
      scopes: ["knowledge:documents:read"],
      registeredReadScopes: ["knowledge:documents:read"],
      dimensionFields: ["team", "sensitivity"],
      dimensionGrants: { sensitivity: ["public", "internal"] },
    })

    expect(filter).toContain('participant_ids = "owner-1"')
    expect(filter).toContain('(sensitivity IN ["public","internal"] OR NOT sensitivity EXISTS)')
  })

  it("wildcard global grant dimensionGrants['*']=['*'] bypasses ALL per-dimension clauses", () => {
    // Phase 11.1 — admin actors authenticated with a JWT carrying
    // `dimensionGrants: { "*": ["*"] }` should be subject to org isolation +
    // read_scope + participant gates but NOT to any per-dimension filtering.
    // Without this, an admin searching their own personal Knowledge doc gets
    // 0 hits because the doc has `sensitivity=internal` and the kernel filter
    // emits `(NOT sensitivity EXISTS)` whenever the actor lacks an explicit
    // sensitivity grant.
    const filter = buildPermissionFilter({
      orgId: "o",
      userId: "u",
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
      registeredReadScopes,
      dimensionFields: ["team", "sensitivity"],
    })
    expect(filter).toContain(`org_id = "o"`)
    expect(filter).toContain(`(NOT participant_ids EXISTS OR participant_ids = "u")`)
    expect(filter).not.toContain("team")
    expect(filter).not.toContain("sensitivity")
  })

  it("wildcard global grant still enforces participant_ids gate (zero-knowledge preserved)", () => {
    // Even with `*:*` (admin), a personal doc owned by another user must
    // remain invisible: the participant_ids clause runs BEFORE the wildcard
    // dimension bypass.
    const filter = buildPermissionFilter({
      orgId: "o",
      userId: "alice",
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
      registeredReadScopes,
      dimensionFields: ["team", "sensitivity"],
    })
    expect(filter).toContain(`(NOT participant_ids EXISTS OR participant_ids = "alice")`)
  })

  it("per-dimension wildcard grant dimensionGrants[dim]=['*'] bypasses that one dimension's clause", () => {
    const filter = buildPermissionFilter({
      orgId: "o",
      userId: "u",
      scopes: ["*"],
      dimensionGrants: { sensitivity: ["*"], team: ["red"] },
      registeredReadScopes,
      dimensionFields: ["team", "sensitivity"],
    })
    expect(filter).not.toContain("sensitivity")
    expect(filter).toContain(`(team IN ["red"] OR NOT team EXISTS)`)
  })

  it("treats dimension grants opaquely — caller is responsible for any per-app expansion", () => {
    // Knowledge service expands its sensitivity ladder
    // (public < internal < confidential < restricted) before invoking search.
    // The kernel filter must not encode any app-specific ordering — verify by
    // passing already-expanded grants and asserting the filter echoes them
    // verbatim without further interpretation.
    const filter = buildPermissionFilter({
      orgId: "org-1",
      userId: "u1",
      scopes: ["knowledge:documents:read"],
      registeredReadScopes: ["knowledge:documents:read"],
      dimensionFields: ["sensitivity"],
      dimensionGrants: { sensitivity: ["public", "internal", "confidential"] },
    })

    expect(filter).toContain(
      '(sensitivity IN ["public","internal","confidential"] OR NOT sensitivity EXISTS)',
    )
    expect(filter).not.toContain("restricted")
  })
})

describe("buildPermissionFilter — generic ACL search primitive (aclFields)", () => {
  const aclFieldDeclarations = [
    { orgWideField: "org_wide", userIdsField: "acl_user_ids", roleIdsField: "acl_role_ids" },
  ]

  it("emits the NOT-EXISTS-OR-org-wide-OR-acl-user-ids shape", () => {
    const filter = buildPermissionFilter({
      orgId: "org-1",
      userId: "u-1",
      scopes: ["knowledge:documents:read"],
      dimensionGrants: {},
      registeredReadScopes: ["knowledge:documents:read"],
      dimensionFields: [],
      aclFieldDeclarations,
    })
    expect(filter).toContain('(NOT org_wide EXISTS OR org_wide = true OR acl_user_ids = "u-1")')
  })

  it("appends the role disjunct only when the caller has roles", () => {
    const withRoles = buildPermissionFilter({
      orgId: "org-1",
      userId: "u-1",
      scopes: ["knowledge:documents:read"],
      dimensionGrants: {},
      registeredReadScopes: ["knowledge:documents:read"],
      dimensionFields: [],
      roleIds: ["role-a", "role-b"],
      aclFieldDeclarations,
    })
    expect(withRoles).toContain(
      '(NOT org_wide EXISTS OR org_wide = true OR acl_user_ids = "u-1" OR acl_role_ids IN ["role-a","role-b"])',
    )

    const withoutRoles = buildPermissionFilter({
      orgId: "org-1",
      userId: "u-1",
      scopes: ["knowledge:documents:read"],
      dimensionGrants: {},
      registeredReadScopes: ["knowledge:documents:read"],
      dimensionFields: [],
      aclFieldDeclarations,
    })
    expect(withoutRoles).not.toContain("acl_role_ids")
  })

  it("a dimension grant (a mailbox's access set) matches the keys a share to it is projected as", async () => {
    const { searchKeysForDimension } = await import("~/modules/sharing/service")
    const filter = buildPermissionFilter({
      orgId: "org-1",
      userId: "u-1",
      scopes: ["kernel:contacts:read"],
      dimensionGrants: { "mail:inbox": ["acc-1"] },
      registeredReadScopes: ["kernel:contacts:read"],
      dimensionFields: [],
      aclFieldDeclarations,
    })
    expect(filter).toContain('acl_role_ids IN ["dim:mail:inbox=acc-1"]')
    // The contact shared with that mailbox carries this key in acl_role_ids.
    expect(searchKeysForDimension("mail:inbox", "acc-1")).toContain("dim:mail:inbox=acc-1")
    // A member of another mailbox holds a key the contact does not carry.
    expect(searchKeysForDimension("mail:inbox", "acc-1")).not.toContain("dim:mail:inbox=acc-2")
  })

  it("entities without aclFields declared are unaffected (no clause emitted)", () => {
    const filter = buildPermissionFilter({
      orgId: "org-1",
      userId: "u-1",
      scopes: ["kernel:threads:read"],
      dimensionGrants: {},
      registeredReadScopes: ["kernel:threads:read"],
      dimensionFields: [],
    })
    expect(filter).not.toContain("org_wide")
    expect(filter).not.toContain("acl_user_ids")
    expect(filter).not.toContain("acl_role_ids")
  })
})
