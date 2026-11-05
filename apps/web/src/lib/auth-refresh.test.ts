// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import { AuthRefreshError, isAuthRefreshError, isInvalidRefreshStatus } from "~/lib/auth-refresh"

describe("isInvalidRefreshStatus", () => {
  it("returns true for 400", () => {
    expect(isInvalidRefreshStatus(400)).toBe(true)
  })

  it("returns true for 401", () => {
    expect(isInvalidRefreshStatus(401)).toBe(true)
  })

  it("returns true for 403", () => {
    expect(isInvalidRefreshStatus(403)).toBe(true)
  })

  it("returns false for 500 (transient server error)", () => {
    expect(isInvalidRefreshStatus(500)).toBe(false)
  })

  it("returns false for 502", () => {
    expect(isInvalidRefreshStatus(502)).toBe(false)
  })

  it("returns false for 429 (rate limit)", () => {
    expect(isInvalidRefreshStatus(429)).toBe(false)
  })

  it("returns false for 200 (success)", () => {
    expect(isInvalidRefreshStatus(200)).toBe(false)
  })

  it("returns false for 404", () => {
    expect(isInvalidRefreshStatus(404)).toBe(false)
  })
})

describe("AuthRefreshError", () => {
  it("stores kind and message", () => {
    const err = new AuthRefreshError("invalid_credentials", "Token rejected")
    expect(err.kind).toBe("invalid_credentials")
    expect(err.message).toBe("Token rejected")
    expect(err.name).toBe("AuthRefreshError")
  })

  it("supports transient kind", () => {
    const err = new AuthRefreshError("transient", "Server unavailable")
    expect(err.kind).toBe("transient")
  })

  it("is an instance of Error", () => {
    const err = new AuthRefreshError("transient", "fail")
    expect(err).toBeInstanceOf(Error)
  })
})

describe("isAuthRefreshError", () => {
  it("returns true for AuthRefreshError instances", () => {
    const err = new AuthRefreshError("invalid_credentials", "bad")
    expect(isAuthRefreshError(err)).toBe(true)
  })

  it("returns false for plain Error", () => {
    expect(isAuthRefreshError(new Error("nope"))).toBe(false)
  })

  it("returns false for non-error values", () => {
    expect(isAuthRefreshError(null)).toBe(false)
    expect(isAuthRefreshError("string")).toBe(false)
    expect(isAuthRefreshError(42)).toBe(false)
  })
})
