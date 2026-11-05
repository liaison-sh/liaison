// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Verifies the org-settings schema admits the anti-prompt-injection controls
// (so "hardened" mode is reachable via PATCH /api/org) while still rejecting an
// invalid value (no fail-open). Uses a RELATIVE import so it resolves this
// package's own source rather than a workspace-linked build.
import { describe, expect, it } from "bun:test"
import { updateOrgSchema } from "./org"

describe("org settings web-protection schema", () => {
  it("accepts webContentProtection 'hardened' with fetch allow/blocklists", () => {
    const r = updateOrgSchema.safeParse({
      settings: {
        webContentProtection: "hardened",
        webFetchAllowlist: ["https://example.com"],
        webFetchBlocklist: ["https://evil.test"],
      },
    })
    expect(r.success).toBe(true)
  })

  it("accepts the default 'standard'", () => {
    expect(
      updateOrgSchema.safeParse({ settings: { webContentProtection: "standard" } }).success,
    ).toBe(true)
  })

  it("accepts 'off', the admin's explicit opt-out", () => {
    expect(updateOrgSchema.safeParse({ settings: { webContentProtection: "off" } }).success).toBe(
      true,
    )
  })

  it("rejects an invalid webContentProtection value (no fail-open)", () => {
    for (const value of ["none", "disabled", "", false]) {
      expect(updateOrgSchema.safeParse({ settings: { webContentProtection: value } }).success).toBe(
        false,
      )
    }
  })
})

// BYOK provider keys must NOT be writable through the generic org-settings PATCH.
// They are only accepted through the dedicated BYOK endpoint.
describe("org settings BYOK provider-keys exclusion", () => {
  it("rejects providerKeys in org-settings PATCH payload (strict schema)", () => {
    const result = updateOrgSchema.safeParse({
      settings: {
        providerKeys: {
          openai: {
            encrypted: "enc-value",
            maskedHint: "sk-...xxxx",
            validatedAt: new Date().toISOString(),
          },
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it("accepts a settings payload that omits providerKeys entirely", () => {
    const result = updateOrgSchema.safeParse({
      settings: {
        fileSizeLimitMb: 100,
      },
    })
    expect(result.success).toBe(true)
  })
})
