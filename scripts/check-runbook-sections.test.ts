// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { checkRunbook, REQUIRED_SECTIONS } from "./check-runbook-sections"

describe("check-runbook-sections", () => {
  it("passes when all nine headings are present in order", () => {
    const text = REQUIRED_SECTIONS.map((s) => `## ${s}\n\nbody`).join("\n\n")
    const r = checkRunbook(text)
    expect(r.ok).toBe(true)
    expect(r.missing).toHaveLength(0)
  })

  it("fails when a heading is missing", () => {
    const partial = REQUIRED_SECTIONS.slice(0, 8)
      .map((s) => `## ${s}`)
      .join("\n\n")
    const r = checkRunbook(partial)
    expect(r.ok).toBe(false)
    expect(r.missing).toContain("Where to file issues")
  })

  it("flags out-of-order sections", () => {
    const reordered = [REQUIRED_SECTIONS[1], REQUIRED_SECTIONS[0], ...REQUIRED_SECTIONS.slice(2)]
      .map((s) => `## ${s}`)
      .join("\n\n")
    const r = checkRunbook(reordered)
    expect(r.ok).toBe(false)
    expect(r.outOfOrder.length).toBeGreaterThan(0)
  })
})
