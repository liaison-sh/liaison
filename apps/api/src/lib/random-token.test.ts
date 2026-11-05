// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { base32Token } from "~/lib/random-token"

describe("base32Token", () => {
  it("returns a 16-char uppercase base32 string for default 10-byte input", () => {
    const t = base32Token()
    expect(t).toMatch(/^[A-Z2-7]{16}$/)
  })

  it("returns distinct tokens across 1000 calls (no collisions)", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(base32Token())
    expect(seen.size).toBe(1000)
  })

  it("scales length with bytes parameter (8 bytes -> 13 chars)", () => {
    const t = base32Token(8)
    expect(t.length).toBe(13)
  })
})
