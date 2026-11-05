// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import { cn } from "~/lib/cn"

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("text-sm", "font-bold")).toBe("text-sm font-bold")
  })

  it("handles conditional classes", () => {
    expect(cn("base", false && "hidden", "visible")).toBe("base visible")
  })

  it("deduplicates conflicting Tailwind classes", () => {
    expect(cn("px-4", "px-6")).toBe("px-6")
  })

  it("handles undefined and null inputs", () => {
    expect(cn("base", undefined, null, "end")).toBe("base end")
  })
})
