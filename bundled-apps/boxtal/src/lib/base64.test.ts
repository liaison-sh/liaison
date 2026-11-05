// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { base64Encode } from "./base64"

// `base64Encode` is the QuickJS-safe replacement for `btoa` (which is undefined
// in the sandbox — the E2E install smoke caught the live `btoa is not defined`
// throw on every Boxtal Basic-auth request). It must match `btoa` for ASCII and
// the UTF-8-then-base64 form for non-ASCII.
describe("base64Encode (QuickJS-safe Basic-auth encoder)", () => {
  it("matches btoa for ASCII credential strings", () => {
    for (const s of ["key:secret", "user:pass", "mock-v3-key:mock-v3-secret", "a", "ab", "abc", "abcd"]) {
      expect(base64Encode(s)).toBe(btoa(s))
    }
  })

  it("encodes empty string to empty", () => {
    expect(base64Encode("")).toBe("")
  })

  it("pads correctly for 1/2/3-byte tails", () => {
    expect(base64Encode("M")).toBe("TQ==")
    expect(base64Encode("Ma")).toBe("TWE=")
    expect(base64Encode("Man")).toBe("TWFu")
  })

  it("UTF-8-encodes non-ASCII before base64 (matches btoa(unescape(encodeURIComponent(x))))", () => {
    for (const s of ["héllo:wörld", "café", "日本語"]) {
      expect(base64Encode(s)).toBe(btoa(unescape(encodeURIComponent(s))))
    }
  })
})
