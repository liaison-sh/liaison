// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { knowledgeDocumentSharingSchema, knowledgeEditScopeSchema } from "@liaison/shared"
import { personalCeiling, personalRestriction } from "~/modules/agent/directory/personal-agent"
import { holdsEveryScope } from "~/modules/agent/scopes/taint-approval-audience"
import { readScopesCoveredByWildcard } from "~/modules/agent/scopes/taint-read-scopes"
import { intersectScopes } from "~/modules/agent/subruns/spawn-agent"
import {
  ceilingRefusalMessage,
  EXACT_ONLY_SCOPES,
  isExactOnlyScope,
  isScopeCovered,
  ungrantableCeilingScopes,
} from "./scope-coverage"

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

  it("the database's kernel.scope_is_exact_only lists the same scopes and the bare-marker rule", () => {
    const dir = join(import.meta.dir, "..", "..", "..", "db", "migrations")
    const defining = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .filter((t) => t.includes("FUNCTION kernel.scope_is_exact_only("))
    const text = defining.at(-1) ?? ""
    const body = text.slice(text.indexOf("FUNCTION kernel.scope_is_exact_only("))
    const fn = body.slice(0, body.indexOf("$fn$;"))
    const list = fn.match(/ANY \(ARRAY\[([^\]]*)\]/)?.[1] ?? ""
    const listed = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1] as string)
    expect([...listed].sort()).toEqual([...EXACT_ONLY_SCOPES].sort())
    // A bare marker (no `:`) is exact-only there too, the wildcard excepted.
    expect(fn).toContain("pg_catalog.strpos(scope, ':') OPERATOR(pg_catalog.=) 0")
    expect(fn).toContain("scope OPERATOR(pg_catalog.<>) '*'")
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

describe("ceiling writes are judged on what they add", () => {
  const margin = "projects:margin:read"

  it("an unchanged or narrowed ceiling holding exact-only scopes saves under `*`", () => {
    const stored = ["*", "clevel", margin]
    expect(ungrantableCeilingScopes(stored, stored, ["*"])).toEqual([])
    expect(ungrantableCeilingScopes(["tickets:tickets:read", "clevel"], stored, ["*"])).toEqual([])
  })

  it("`*` never newly grants an exact-only scope; its exact grant does", () => {
    expect(
      ungrantableCeilingScopes(["kernel:threads:read", margin], ["kernel:threads:read"], ["*"]),
    ).toEqual([margin])
    expect(ungrantableCeilingScopes([margin], [], ["*"])).toEqual([margin])
    expect(ungrantableCeilingScopes(["clevel"], [], ["*"])).toEqual(["clevel"])
    expect(ungrantableCeilingScopes([margin], [], ["*", margin])).toEqual([])
    // A stored `*` does not hold it either.
    expect(ungrantableCeilingScopes(["*", margin], ["*"], ["*"])).toEqual([margin])
  })

  it("an ordinary scope beyond the stored ceiling needs the writer's own cover", () => {
    expect(
      ungrantableCeilingScopes(["tickets:tickets:write"], [], ["kernel:threads:read"]),
    ).toEqual(["tickets:tickets:write"])
    expect(ungrantableCeilingScopes(["tickets:tickets:write"], ["tickets:*"], [])).toEqual([])
  })

  it("the refusal names the scope and says it must be granted exactly", () => {
    const message = ceilingRefusalMessage([margin])
    expect(message).toContain(margin)
    expect(message).toContain("exactly")
    expect(ceilingRefusalMessage(["tickets:tickets:write"])).not.toContain("exactly")
  })
})

describe("a personal agent's restriction records only what was removed", () => {
  const owner = ["*", "clevel"]

  it("resending the ceiling an owner's scopes make narrows nothing", () => {
    expect(personalRestriction(owner, owner, owner, null)).toBeNull()
  })

  it("narrowing keeps clevel when the written ceiling keeps it", () => {
    const r = personalRestriction(owner, ["kernel:threads:read", "clevel"], owner, null)
    // `!` marks a restriction that records removals; nothing was removed that is exact-only.
    expect(r).toEqual(["kernel:threads:read", "clevel", "!"])
  })

  it("clevel removed from the ceiling the admin was shown is dropped", () => {
    expect(personalRestriction(owner, ["kernel:threads:read"], owner, null)).toEqual([
      "kernel:threads:read",
      "!",
      "!clevel",
    ])
    expect(personalRestriction(owner, ["*"], owner, null)).toEqual(["*", "!", "!clevel"])
    // And the ceiling it makes leaves it out.
    expect(personalCeiling(owner, personalRestriction(owner, ["*"], owner, null))).toEqual(["*"])
  })

  it("an owner's exact-only scope the shown ceiling did not carry is kept, not silently dropped", () => {
    // The ceiling had not caught up with the owner's clevel grant: the admin could not name it.
    expect(personalRestriction(owner, ["*"], ["*"], null)).toBeNull()
    expect(personalRestriction(owner, ["kernel:threads:read"], ["*"], null)).toEqual([
      "kernel:threads:read",
      "clevel",
      "!",
    ])
    // Under an earlier restriction it was left out on purpose: it stays out, recorded as removed.
    expect(personalRestriction(owner, ["kernel:threads:read"], ["*"], ["*"])).toEqual([
      "kernel:threads:read",
      "!",
      "!clevel",
    ])
  })
})

describe("an exact-only scope granted after a personal agent was narrowed", () => {
  const margin = "projects:margin:read"
  const before = ["tickets:*", "projects:*"]
  const after = [...before, margin]

  it("an exact-only scope granted after a narrowing reaches the personal agent when the restriction does not remove it", () => {
    // The admin removed tickets and kept projects; the owner is later granted margin exactly.
    const narrowed = personalRestriction(before, ["projects:*"], before, null)
    expect(personalCeiling(before, narrowed)).toEqual(["projects:*"])
    expect(personalCeiling(after, narrowed)).toEqual(["projects:*", margin])
    // A restriction that removed the scope's whole area keeps it off.
    const noProjects = personalRestriction(before, ["tickets:*"], before, null)
    expect(personalCeiling(after, noProjects)).toEqual(["tickets:*"])
    // A scope the admin removed by name stays off when it is granted again.
    const removed = personalRestriction(after, ["projects:*"], after, null)
    expect(personalCeiling(before, removed)).toEqual(["projects:*"])
    expect(personalCeiling(after, removed)).toEqual(["projects:*"])
    // A later narrowing keeps that removal unless the admin names the scope again.
    const later = personalRestriction(after, ["projects:*"], ["projects:*"], removed)
    expect(personalCeiling(after, later)).toEqual(["projects:*"])
    const readded = personalRestriction(after, ["projects:*", margin], ["projects:*"], removed)
    expect(personalCeiling(after, readded)).toEqual(["projects:*", margin])
    // A restriction recorded before removals were kept names its exact-only scopes, as before.
    expect(personalCeiling(after, ["projects:*"])).toEqual(["projects:*"])
  })

  it("an older restriction saved again in the removal format never widens", () => {
    // Recorded before removals were kept: it names its exact-only scopes, so margin is off.
    const legacy = ["projects:*"]
    const stored = personalCeiling(after, legacy)
    expect(stored).toEqual(["projects:*"])
    // An admin saves the ceiling unchanged (the form resends it whole): margin stays off.
    const resaved = personalRestriction(after, stored, stored, legacy)
    expect(personalCeiling(after, resaved)).toEqual(["projects:*"])
    // And on every later save and recompute.
    const again = personalRestriction(after, ["projects:*"], ["projects:*"], resaved)
    expect(personalCeiling(after, again)).toEqual(["projects:*"])
    // An admin who holds margin exactly and names it puts it back.
    const named = personalRestriction(after, ["projects:*", margin], stored, legacy)
    expect(personalCeiling(after, named)).toEqual(["projects:*", margin])
    // A legacy restriction that named the scope keeps it.
    const kept = [...legacy, margin]
    const keptResaved = personalRestriction(
      after,
      personalCeiling(after, kept),
      personalCeiling(after, kept),
      kept,
    )
    expect(personalCeiling(after, keptResaved)).toEqual(["projects:*", margin])
  })

  it("a wildcard holder still does not cover an exact-only scope", () => {
    // A pin: the coverage primitives are unchanged; the restriction filters, it never grants.
    expect(isScopeCovered([margin], ["*"])).toBe(false)
    expect(isScopeCovered([margin], ["projects:*"])).toBe(false)
    expect(isScopeCovered(["clevel"], ["*"])).toBe(false)
    expect(intersectScopes(["*"], [margin])).toEqual([])
    // An owner holding `*` but not margin gets no margin through a restriction keeping `*`.
    const narrowed = personalRestriction(["*"], ["*"], ["*"], ["*", "!"])
    expect(personalCeiling(["*"], narrowed)).toEqual(["*"])
    expect(personalCeiling(["*"], ["*", "!"])).not.toContain(margin)
    // An entry shaped like a removal is never written as a scope.
    expect(personalRestriction(after, ["projects:*", "!"], after, null)).not.toContain(margin)
  })
})

describe("taint audiences and wildcard reads use exact-aware coverage", () => {
  const margin = "projects:margin:read"

  it("a `*`-only holder does not hold an exact-only taint scope; its exact holder does", () => {
    expect(holdsEveryScope(["*"], [margin])).toBe(false)
    expect(holdsEveryScope(["projects:*"], [margin])).toBe(false)
    expect(holdsEveryScope(["*", margin], [margin, "tickets:tickets:read"])).toBe(true)
    expect(holdsEveryScope(["*"], ["tickets:tickets:read"])).toBe(true)
  })

  it("a grant wildcard expands onto no exact-only read", () => {
    const catalog = ["tickets:tickets:read", margin, "projects:tasks:read"]
    expect(readScopesCoveredByWildcard("*", catalog)).toEqual([
      "tickets:tickets:read",
      "projects:tasks:read",
    ])
    expect(readScopesCoveredByWildcard("projects:*", catalog)).toEqual(["projects:tasks:read"])
    expect(readScopesCoveredByWildcard("*:read", catalog)).toEqual([])
  })
})
