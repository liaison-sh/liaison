// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  generateCurrentCode,
  generateRecoveryCodes,
  generateTotpSecret,
  generateTotpUri,
  verifyTotpCode,
} from "~/modules/auth/totp"

describe("TOTP service", () => {
  it("generates a base32-encoded secret", () => {
    const secret = generateTotpSecret()
    expect(secret.length).toBeGreaterThan(0)
    expect(secret).toMatch(/^[A-Z2-7]+=*$/)
  })

  it("generates an otpauth URI", () => {
    const uri = generateTotpUri("test-secret", "user@test.com", "Liaison")
    expect(uri).toContain("otpauth://totp/")
    expect(uri).toContain("user%40test.com")
    expect(uri).toContain("Liaison")
    expect(uri).toContain("secret=test-secret")
  })

  it("verifies a valid TOTP code", () => {
    const secret = generateTotpSecret()
    const code = generateCurrentCode(secret)
    expect(verifyTotpCode(secret, code)).toBe(true)
  })

  it("rejects invalid TOTP code", () => {
    const secret = generateTotpSecret()
    expect(verifyTotpCode(secret, "000000")).toBe(false)
  })

  it("generates 8 unique recovery codes", () => {
    const codes = generateRecoveryCodes()
    expect(codes).toHaveLength(8)
    const unique = new Set(codes)
    expect(unique.size).toBe(8)
    for (const code of codes) {
      expect(code).toMatch(/^[a-f0-9]{20}$/)
    }
  })
})
