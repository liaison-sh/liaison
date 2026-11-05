// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  checkToolScopes,
  resolveRequiredScopes,
  TOOL_DECLARES_NO_SCOPES,
} from "~/modules/agent/scopes/required-scopes"
import { toolRegistry } from "~/modules/apps/app-registries"

describe("tool registry: requiredScopes is the only scope field", () => {
  const orgId = "test-org-required-scopes-invariant"
  const base = {
    appName: "kernel",
    description: "fixture tool for the registration invariant",
    handler: async () => ({ ok: true }),
  }

  it("registration refuses a tool that carries the retired scope key, naming the tool", () => {
    try {
      expect(() =>
        toolRegistry.set([orgId, "kernel", "legacy_scope"], {
          ...base,
          name: "legacy_scope",
          requiredScopes: ["a:b:read"],
          scope: "a:b:read",
        } as never),
      ).toThrow(/legacy_scope.*"scope"/)
      expect(toolRegistry.get([orgId, "kernel", "legacy_scope"])).toBeUndefined()
    } finally {
      toolRegistry.deleteByPrefix([orgId])
    }
  })

  it("registration refuses a missing, empty or malformed requiredScopes", () => {
    try {
      expect(() =>
        toolRegistry.set([orgId, "kernel", "no_scopes"], {
          ...base,
          name: "no_scopes",
        } as never),
      ).toThrow(/no_scopes.*requiredScopes/)
      expect(() =>
        toolRegistry.set([orgId, "kernel", "empty_scopes"], {
          ...base,
          name: "empty_scopes",
          requiredScopes: [],
        }),
      ).toThrow(/empty_scopes.*requiredScopes/)
      expect(() =>
        toolRegistry.set([orgId, "kernel", "blank_scope"], {
          ...base,
          name: "blank_scope",
          requiredScopes: [""],
        }),
      ).toThrow(/blank_scope.*requiredScopes/)
      expect(toolRegistry.get([orgId, "kernel", "no_scopes"])).toBeUndefined()
      expect(toolRegistry.get([orgId, "kernel", "empty_scopes"])).toBeUndefined()
      expect(toolRegistry.get([orgId, "kernel", "blank_scope"])).toBeUndefined()
    } finally {
      toolRegistry.deleteByPrefix([orgId])
    }
  })

  it("registration accepts one or several requiredScopes", () => {
    try {
      toolRegistry.set([orgId, "kernel", "one_scope"], {
        ...base,
        name: "one_scope",
        requiredScopes: ["a:b:read"],
      })
      toolRegistry.set([orgId, "kernel", "two_scopes"], {
        ...base,
        name: "two_scopes",
        requiredScopes: ["a:c:write", "a:b:read"],
      })
      expect(toolRegistry.get([orgId, "kernel", "one_scope"])?.requiredScopes).toEqual(["a:b:read"])
      expect(toolRegistry.get([orgId, "kernel", "two_scopes"])?.requiredScopes).toEqual([
        "a:c:write",
        "a:b:read",
      ])
    } finally {
      toolRegistry.deleteByPrefix([orgId])
    }
  })

  it("the registry type has no scope field: writing or reading it does not compile", () => {
    const orgId2 = `${orgId}-types`
    try {
      toolRegistry.set([orgId2, "kernel", "typed"], {
        ...base,
        name: "typed",
        requiredScopes: ["a:b:read"],
      })
      const entry = toolRegistry.get([orgId2, "kernel", "typed"])
      // @ts-expect-error the retired single-scope field is not on the registry type
      expect(entry?.scope).toBeUndefined()
      expect(() =>
        toolRegistry.set([orgId2, "kernel", "typed_write"], {
          ...base,
          name: "typed_write",
          requiredScopes: ["a:b:read"],
          // @ts-expect-error the retired single-scope field is not on the registry type
          scope: "a:b:read",
        }),
      ).toThrow(/typed_write/)
    } finally {
      toolRegistry.deleteByPrefix([orgId2])
    }
  })
})

describe("checkToolScopes", () => {
  const multi = { requiredScopes: ["a:b:read", "a:c:write"] }

  it("authorizes only when every required scope is held, wildcard-aware", () => {
    expect(checkToolScopes(multi, ["a:b:read"])).toEqual({
      required: ["a:b:read", "a:c:write"],
      missing: ["a:c:write"],
      authorized: false,
    })
    expect(checkToolScopes(multi, ["a:b:read", "a:c:write"]).authorized).toBe(true)
    expect(checkToolScopes(multi, ["a:*"]).authorized).toBe(true)
    expect(checkToolScopes({ requiredScopes: ["a:b:read"] }, ["a:b:read"]).authorized).toBe(true)
  })

  it("never authorizes a tool that declares no scope, even for a full wildcard", () => {
    expect(checkToolScopes({}, ["*"])).toEqual({ required: [], missing: [], authorized: false })
  })

  it("ignores a stray scope key on an untyped definition: only requiredScopes counts", () => {
    const untyped = { scope: "a:b:read" } as unknown as { requiredScopes?: string[] }
    expect(checkToolScopes(untyped, ["*"]).authorized).toBe(false)
  })
})

describe("resolveRequiredScopes", () => {
  it("returns the requiredScopes array when present", () => {
    expect(resolveRequiredScopes({ requiredScopes: ["a:b:read", "a:c:write"] })).toEqual([
      "a:b:read",
      "a:c:write",
    ])
  })

  it("deduplicates the requiredScopes array", () => {
    expect(
      resolveRequiredScopes({
        requiredScopes: ["a:b:read", "a:c:write", "a:b:read"],
      }),
    ).toEqual(["a:b:read", "a:c:write"])
  })

  it("returns an empty array when requiredScopes is absent", () => {
    expect(resolveRequiredScopes({})).toEqual([])
  })

  it("TOOL_DECLARES_NO_SCOPES is true only for the empty case", () => {
    expect(TOOL_DECLARES_NO_SCOPES({ requiredScopes: ["a:b:read"] })).toBe(false)
    expect(TOOL_DECLARES_NO_SCOPES({ requiredScopes: [] })).toBe(true)
    expect(TOOL_DECLARES_NO_SCOPES({})).toBe(true)
  })
})
