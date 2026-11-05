// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  isValidSlug,
  projectedToolName,
  registryKey,
  resolveSanitizedNames,
  sanitizeToolName,
  scopeString,
  sdkName,
} from "~/modules/mcp-client/naming"

describe("MCP name synthesis (spec §3.6)", () => {
  it.each([
    ["create-issue", "create_issue"],
    ["Create Issue", "create_issue"],
    ["__weird::name__", "weird_name"],
    ["a", "a"],
    ["a__b__c", "a_b_c"],
  ])("sanitize(%s) -> %s", (input, expected) => {
    expect(sanitizeToolName(input)).toBe(expected)
  })

  it("projectedToolName joins slug and sanitized tool", () => {
    expect(projectedToolName("linear", "Create Issue")).toBe("linear:create_issue")
  })

  it.each([
    ["linear", true],
    ["my-linear", true],
    ["a", true],
    ["a-1-b", true],
    ["", false],
    ["A", false],
    ["a_b", false],
    ["a.b", false],
    ["x".repeat(33), false],
  ])("isValidSlug(%s) === %s", (slug, ok) => {
    expect(isValidSlug(slug)).toBe(ok)
  })

  it("registryKey/sdkName/scopeString all derive consistently", () => {
    const org = "00000000-0000-0000-0000-000000000001"
    expect(registryKey(org, "linear", "Create Issue")).toEqual([org, "mcp", "linear:create_issue"])
    expect(sdkName("linear", "Create Issue")).toBe("mcp__linear_create_issue")
    expect(scopeString("linear", "Create Issue")).toBe("mcp:linear:create_issue")
  })
})

describe("resolveSanitizedNames — collision-free segment assignment", () => {
  it("disambiguates names that sanitize to the same segment", () => {
    const m = resolveSanitizedNames(["get-user", "get_user", "get.user"])
    const segments = [...m.values()]
    // All three remain distinct — none silently overwrites another.
    expect(new Set(segments).size).toBe(3)
    // Each maps to a segment beginning with the shared sanitized base.
    for (const seg of segments) expect(seg.startsWith("get_user")).toBe(true)
  })

  it("is deterministic for a given input order", () => {
    const a = resolveSanitizedNames(["get-user", "get_user"])
    const b = resolveSanitizedNames(["get-user", "get_user"])
    expect([...a.entries()]).toEqual([...b.entries()])
  })

  it("an already-canonical name keeps its clean segment regardless of order", () => {
    // `resource_read` is canonical; `resource-read` is lossy. The canonical one
    // must win the clean segment even though it sorts after the hyphen form.
    const m = resolveSanitizedNames(["resource-read", "resource_read"])
    expect(m.get("resource_read")).toBe("resource_read")
    expect(m.get("resource-read")).not.toBe("resource_read")
  })

  it("passes non-colliding names through unchanged", () => {
    const m = resolveSanitizedNames(["Create Issue", "list_items"])
    expect(m.get("Create Issue")).toBe("create_issue")
    expect(m.get("list_items")).toBe("list_items")
  })
})
