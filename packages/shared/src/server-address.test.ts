// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { isValidServerAddress, normalizeServerAddress } from "./server-address"

describe("what a person types as a server address", () => {
  it("a bare host gets https:// and is then valid", () => {
    expect(normalizeServerAddress("  liaison.example.com  ")).toBe("https://liaison.example.com")
    expect(isValidServerAddress(normalizeServerAddress("liaison.example.com"))).toBe(true)
  })
  it("keeps an explicit scheme and drops a trailing slash", () => {
    expect(normalizeServerAddress("http://203.0.113.10:3000/")).toBe("http://203.0.113.10:3000")
    expect(normalizeServerAddress("https://acme.example.com//")).toBe("https://acme.example.com")
  })
  it("leaves empty input empty, so it is still refused", () => {
    expect(normalizeServerAddress("   ")).toBe("")
    expect(isValidServerAddress(normalizeServerAddress("   "))).toBe(false)
  })
})

describe("server address validation", () => {
  it("takes an http(s) URL with a dotted host, an IP address or localhost", () => {
    for (const good of [
      "https://acme.example.com",
      "http://203.0.113.10:3000",
      "http://localhost:18080",
      "http://[::1]:3000",
    ]) {
      expect(isValidServerAddress(good)).toBe(true)
    }
  })
  it("refuses other schemes, a bare host and a single word", () => {
    for (const bad of [
      "",
      "acme.example.com",
      "https://not-an-address",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ]) {
      expect(isValidServerAddress(bad)).toBe(false)
    }
  })
})

describe("normalizeServerAddress on a long run of slashes", () => {
  it("drops every trailing slash, in linear time", () => {
    const started = performance.now()
    expect(normalizeServerAddress(`liaison.example.com${"/".repeat(100_000)}`)).toBe(
      "https://liaison.example.com",
    )
    expect(normalizeServerAddress(`https://h/${"/".repeat(100_000)}a`)).toBe(
      `https://h/${"/".repeat(100_000)}a`,
    )
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
