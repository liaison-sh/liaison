// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { statusDot, statusWash } from "./StatusPill"

describe("StatusPill colours", () => {
  it("draws a hex status colour", () => {
    expect(statusDot("#3b82f6")).toBe("#3b82f6")
    expect(statusWash("#3b82f6")).toContain("#3b82f6")
  })

  it("falls back to the neutral colours for anything that is not a hex colour", () => {
    for (const bad of ["red", "url(https://x.example/a.png)", "#12", "var(--x)", "", null]) {
      expect(statusDot(bad)).toBe("var(--color-text-tertiary)")
      expect(statusWash(bad)).toBe("var(--color-surface-hover)")
    }
  })
})
