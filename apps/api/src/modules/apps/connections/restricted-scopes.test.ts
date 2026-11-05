// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  type RestrictedScopeContext,
  restrictedScopesAllowed,
  withoutRestricted,
} from "~/modules/apps/connections/restricted-scopes"

const READ = "https://www.googleapis.com/auth/drive.readonly"
const FILE = "https://www.googleapis.com/auth/drive.file"
const base: RestrictedScopeContext = {
  clientSource: "instance",
  instanceVerified: false,
  existingGrant: null,
  personAccountType: "google_consumer",
}

describe("restricted scopes", () => {
  test("a personal account on an unverified instance client asks for drive.file only", () => {
    const allowed = restrictedScopesAllowed([READ], base)
    expect(allowed).toBe(false)
    expect(withoutRestricted(["openid", "email", READ, FILE], [READ], allowed)).toEqual([
      "openid",
      "email",
      FILE,
    ])
  })

  test("an unknown or non-Google address is treated like a personal account", () => {
    expect(restrictedScopesAllowed([READ], { ...base, personAccountType: "unknown" })).toBe(false)
    expect(restrictedScopesAllowed([READ], { ...base, personAccountType: "other" })).toBe(false)
    expect(restrictedScopesAllowed([READ], { ...base, personAccountType: null })).toBe(false)
  })

  test("the full Drive: org client, verified instance client, Workspace address, held or unknown grant", () => {
    expect(restrictedScopesAllowed([READ], { ...base, clientSource: "org" })).toBe(true)
    expect(restrictedScopesAllowed([READ], { ...base, instanceVerified: true })).toBe(true)
    expect(
      restrictedScopesAllowed([READ], { ...base, personAccountType: "google_workspace" }),
    ).toBe(true)
    expect(restrictedScopesAllowed([READ], { ...base, existingGrant: [READ, FILE] })).toBe(true)
    expect(restrictedScopesAllowed([READ], { ...base, existingGrant: "unknown" })).toBe(true)
    expect(restrictedScopesAllowed([READ], { ...base, existingGrant: [FILE] })).toBe(false)
  })

  test("a connection without restricted scopes is untouched", () => {
    expect(restrictedScopesAllowed([], base)).toBe(true)
    expect(withoutRestricted(["a", "b"], [], true)).toEqual(["a", "b"])
  })
})

describe("one rule for the OAuth flow and the agent's prediction", () => {
  test("restrictedScopesAllowed without a grant is googleDriveMode === full", async () => {
    const { googleDriveMode } = await import("@liaison/shared")
    for (const clientSource of ["org", "instance"] as const) {
      for (const instanceVerified of [true, false]) {
        for (const personAccountType of [
          "google_workspace",
          "google_consumer",
          "microsoft",
          "other",
          "unknown",
          null,
        ] as const) {
          const allowed = restrictedScopesAllowed([READ], {
            clientSource,
            instanceVerified,
            existingGrant: null,
            personAccountType,
          })
          const mode = googleDriveMode(personAccountType, {
            source: clientSource,
            restrictedVerified: instanceVerified,
          })
          expect(allowed).toBe(mode === "full")
        }
      }
    }
  })
})
