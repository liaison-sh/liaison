// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import { kebabCase } from "~/lib/kebab-case"

describe("kebabCase", () => {
  it("normalizes a normal phrase", () => {
    expect(kebabCase("My Skill")).toBe("my-skill")
  })

  it("trims leading and trailing punctuation", () => {
    expect(kebabCase("!!My Skill!!")).toBe("my-skill")
  })

  it("collapses consecutive separators to one hyphen", () => {
    expect(kebabCase("My   Cool -- Skill")).toBe("my-cool-skill")
  })

  it("truncates to 60 characters without leaving a trailing hyphen", () => {
    const input = `${"a".repeat(59)} ${"b".repeat(10)}`
    const result = kebabCase(input)
    expect(result.length).toBeLessThanOrEqual(60)
    expect(result.endsWith("-")).toBe(false)
  })

  it("passes an already-valid slug through unchanged", () => {
    expect(kebabCase("already-valid-slug")).toBe("already-valid-slug")
  })
})
