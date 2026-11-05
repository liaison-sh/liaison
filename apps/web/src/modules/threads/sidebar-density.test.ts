// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  SIDEBAR_DENSITY,
  SIDEBAR_METRICS,
  type SidebarDensity,
  sidebarMetrics,
} from "~/modules/threads/sidebar-density"

describe("sidebar density is one constant with two judged values", () => {
  it("defaults to the judged variant A", () => {
    expect(SIDEBAR_DENSITY).toBe("slack")
  })

  it("carries exactly the two variants that were captured and judged", () => {
    expect(Object.keys(SIDEBAR_METRICS).sort()).toEqual(["slack", "slack-dense"])
  })

  it("variant A is the 32 px row, variant B the 28 px row", () => {
    // h-8 = 32 px, h-7 = 28 px: the two heights measured off the mock pages.
    expect(SIDEBAR_METRICS.slack.row).toBe("h-8")
    expect(SIDEBAR_METRICS["slack-dense"].row).toBe("h-7")
  })

  it("every metric differs between the variants, so flipping the constant flips the row", () => {
    const a = SIDEBAR_METRICS.slack
    const b = SIDEBAR_METRICS["slack-dense"]
    expect(a.row).not.toBe(b.row)
    expect(a.name).not.toBe(b.name)
    expect(a.glyph).not.toBe(b.glyph)
    expect(a.person).not.toBe(b.person)
    expect(a.agentMark).not.toBe(b.agentMark)
    expect(a.headerPad).not.toBe(b.headerPad)
  })

  it("a person is a face in A and a presence dot in B", () => {
    expect(SIDEBAR_METRICS.slack.person).toBe("avatar")
    expect(SIDEBAR_METRICS["slack-dense"].person).toBe("dot")
  })

  it("sidebarMetrics reads the constant, and takes an explicit override", () => {
    expect(sidebarMetrics()).toEqual(SIDEBAR_METRICS[SIDEBAR_DENSITY])
    for (const d of ["slack", "slack-dense"] as SidebarDensity[]) {
      expect(sidebarMetrics(d)).toEqual(SIDEBAR_METRICS[d])
    }
  })
})
