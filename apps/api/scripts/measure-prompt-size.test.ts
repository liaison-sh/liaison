// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { measure } from "./measure-prompt-size"

describe("measure-prompt-size", () => {
  it("is importable and exposes a measure() function", () => {
    expect(typeof measure).toBe("function")
  })

  it("returns within-budget true at the default 100 skills", () => {
    const result = measure({ skills: 100 })
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.tokens).toBeLessThan(15_000)
    expect(result.withinBudget).toBe(true)
  })

  it("scales linearly with skill count and stays under budget at 100", () => {
    const ten = measure({ skills: 10 }).tokens
    const hundred = measure({ skills: 100 }).tokens
    expect(hundred).toBeGreaterThan(ten * 5)
  })
})
