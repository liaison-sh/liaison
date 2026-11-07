// SPDX-License-Identifier: FSL-1.1-ALv2
// The approval card's delta of a publish against the active version (pure).
import { describe, expect, test } from "bun:test"
import { grantsOf, manifestDelta, pinTypecheck, readPin, typecheckLine } from "./publish"

const v1 = {
  scopes: ["a-o1234abcd:x:read"],
  network: { allowedDomains: ["api.example.com"] },
  schema: { returns: { fields: { order: "string" } }, notes: { fields: { body: "string" } } },
  secrets: { key: { hosts: ["api.example.com"], in: "header:X-Key" } },
  cross_app_calls: [{ target: "knowledge:search", reason: "r" }],
}

describe("manifestDelta", () => {
  test("names what a new version adds and removes, and the tables it keeps", () => {
    const v2 = {
      scopes: ["a-o1234abcd:x:read", "a-o1234abcd:x:write"],
      network: { allowedDomains: ["api.example.com", "files.example.com"] },
      schema: { returns: { fields: { order: "string", reason: "string?" } } },
      secrets: { key: { hosts: ["files.example.com"], in: "header:X-Key" } },
      cross_app_calls: [],
    }
    const lines = manifestDelta(v1, v2, "0.1.0")
    expect(lines).toContain("Scopes added: a-o1234abcd:x:write.")
    expect(lines).toContain("Allowed domains added: files.example.com.")
    expect(lines).toContain("Cross-app calls removed: knowledge:search.")
    expect(lines).toContain("New columns: returns.reason.")
    expect(lines).toContain(
      "Tables kept: notes (this version no longer declares them; their data stays).",
    )
    expect(lines).toContain("Secret key: header:X-Key to files.example.com.")
  })

  test("a code-only change says so; a first publish lists what it asks", () => {
    expect(manifestDelta(v1, v1, "0.1.0")).toEqual([
      "No change of access against 0.1.0: code only.",
    ])
    const first = manifestDelta(null, v1, null)
    expect(first).toContain("Scopes asked: a-o1234abcd:x:read.")
    expect(first).toContain("New tables: returns, notes.")
  })

  test("grants and pins", () => {
    expect(grantsOf(v1)).toEqual({
      scopes: ["a-o1234abcd:x:read"],
      connections: [],
      capabilities: [],
      crossAppCalls: ["knowledge:search"],
    })
    expect(readPin({ draftId: "d", n: 1, appName: "a", appVersion: "0.1.0" })).toBeNull()
    expect(
      readPin({
        draftId: "d",
        n: 1,
        appName: "a",
        appVersion: "0.1.0",
        baseVersion: null,
        packageSha256: "a".repeat(64),
        grants: { scopes: ["s"] },
      }),
    ).toMatchObject({ packageSha256: "a".repeat(64), grants: { scopes: ["s"], connections: [] } })
  })
})

describe("the type check on the card", () => {
  test("a pin carries the build's type check, read back tolerantly, as one line", () => {
    const t = pinTypecheck({
      ok: false,
      errors: [
        { file: "handlers.ts", line: 4, message: "Property 'x' does not exist" },
        { file: "ui.tsx", line: 1, message: "y" },
      ],
    })
    expect(t).toEqual({ ok: false, errors: 2, first: "handlers.ts:4 Property 'x' does not exist" })
    expect(typecheckLine(t)).toBe(
      "Type check: 2 errors (first: handlers.ts:4 Property 'x' does not exist).",
    )
    expect(typecheckLine(pinTypecheck({ ok: true, errors: [] }))).toBe("Type check: ok.")
    expect(typecheckLine(undefined)).toBe("Type check: not run.")
    const pin = {
      draftId: "d",
      n: 1,
      appName: "a",
      appVersion: "0.1.0",
      baseVersion: null,
      packageSha256: "a".repeat(64),
      grants: {},
    }
    expect(readPin({ ...pin, typecheck: t })?.typecheck).toEqual(t)
    expect(readPin({ ...pin, typecheck: "bogus" })?.typecheck).toBeUndefined()
  })
})
