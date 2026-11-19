// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { knowledgeDocumentSharingSchema, knowledgeEditScopeSchema } from "@liaison/shared"
import { intersectScopes } from "~/modules/agent/subruns/spawn-agent"
import { EXACT_ONLY_SCOPES, isExactOnlyScope, isScopeCovered } from "./scope-coverage"

describe("isScopeCovered", () => {
  it("treats an empty required set as covered", () => {
    expect(isScopeCovered([], [])).toBe(true)
    expect(isScopeCovered([], ["kernel:agent:memory"])).toBe(true)
  })

  it("covers exact matches", () => {
    expect(isScopeCovered(["kernel:threads:read"], ["kernel:threads:read"])).toBe(true)
    expect(isScopeCovered(["kernel:threads:read"], ["kernel:threads:write"])).toBe(false)
  })

  it("the full wildcard covers everything", () => {
    expect(isScopeCovered(["mcp:jira:read", "kernel:threads:write"], ["*"])).toBe(true)
  })

  it("a :* glob covers deeper required scopes (the routine-authoring regression)", () => {
    // Holder of mcp:jira:* must be able to author a routine requiring mcp:jira:read.
    expect(isScopeCovered(["mcp:jira:read"], ["mcp:jira:*"])).toBe(true)
    expect(isScopeCovered(["mcp:jira:issues:create"], ["mcp:jira:*"])).toBe(true)
    // ...but not a sibling namespace.
    expect(isScopeCovered(["mcp:github:read"], ["mcp:jira:*"])).toBe(false)
  })

  it("a bare ancestor prefix covers descendants (the spawn under-grant regression)", () => {
    // Holder of the bare kernel:agent:memory grant covers the :read leaf.
    expect(isScopeCovered(["kernel:agent:memory:read"], ["kernel:agent:memory"])).toBe(true)
    expect(isScopeCovered(["kernel:agent:memory"], ["kernel:agent:memory"])).toBe(true)
  })

  it("bare-prefix coverage respects the colon boundary", () => {
    // a:bc must NOT be covered by a:b.
    expect(isScopeCovered(["kernel:agent:memorywrite"], ["kernel:agent:memory"])).toBe(false)
  })

  it("requires every required scope to be covered", () => {
    expect(isScopeCovered(["mcp:jira:read", "kernel:threads:read"], ["mcp:jira:*"])).toBe(false)
    expect(
      isScopeCovered(
        ["mcp:jira:read", "kernel:threads:read"],
        ["mcp:jira:*", "kernel:threads:read"],
      ),
    ).toBe(true)
  })
})

describe("exact-only scopes", () => {
  it("lists every scope the migrations check by its exact grant", () => {
    const dir = join(import.meta.dir, "..", "..", "..", "db", "migrations")
    const checked = new Set<string>()
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
      const text = readFileSync(join(dir, file), "utf8")
      for (const m of text.matchAll(/app_has_exact_scope\('([^']+)'\)/g))
        checked.add(m[1] as string)
    }
    expect(checked.size).toBeGreaterThan(0)
    expect([...EXACT_ONLY_SCOPES].sort()).toEqual([...checked].sort())
  })

  it("a bare marker scope is exact-only, the wildcard and app scopes are not", () => {
    expect(isExactOnlyScope("clevel")).toBe(true)
    expect(isExactOnlyScope("projects:margin:read")).toBe(true)
    expect(isExactOnlyScope("*")).toBe(false)
    expect(isExactOnlyScope("tickets:tickets:read")).toBe(false)
  })

  it("no wildcard, glob or parent covers an exact-only scope; its exact grant does", () => {
    for (const scope of [...EXACT_ONLY_SCOPES, "clevel"]) {
      expect(isScopeCovered([scope], ["*"])).toBe(false)
      expect(isScopeCovered([scope], [`${scope.split(":")[0]}:*`])).toBe(false)
      expect(isScopeCovered([scope], [scope])).toBe(true)
      expect(isScopeCovered([scope], ["*", scope])).toBe(true)
    }
    expect(isScopeCovered(["projects:margin:read"], ["projects:margin"])).toBe(false)
    // The wildcard still covers every other scope.
    expect(isScopeCovered(["projects:projects:read", "kernel:agents:admin"], ["*"])).toBe(true)
  })

  it("an intersection keeps an exact-only scope only when both sides name it", () => {
    const margin = "projects:margin:read"
    expect(intersectScopes(["*"], ["tickets:tickets:read", margin])).toEqual([
      "tickets:tickets:read",
    ])
    expect(intersectScopes(["tickets:tickets:read", margin], ["*"])).toEqual([
      "tickets:tickets:read",
    ])
    expect(intersectScopes([margin, "x:y:read"], ["*", margin])).toEqual([margin, "x:y:read"])
  })

  it("a knowledge edit scope, checked exactly by row security, can only be an exact-only scope", () => {
    for (const ok of ["clevel", "board_only", "finance-leads"]) {
      expect(knowledgeEditScopeSchema.safeParse(ok).success).toBe(true)
      expect(isExactOnlyScope(ok)).toBe(true)
    }
    for (const refused of ["finance:docs:edit", "*", "knowledge:*", "a,b", "", "Board"]) {
      expect(knowledgeEditScopeSchema.safeParse(refused).success).toBe(false)
    }
    const sharing = { orgAccess: "viewer", shares: [] }
    expect(
      knowledgeDocumentSharingSchema.safeParse({ ...sharing, editScope: "finance:docs:edit" })
        .success,
    ).toBe(false)
    expect(knowledgeDocumentSharingSchema.safeParse({ ...sharing, editScope: null }).success).toBe(
      true,
    )
  })
})
