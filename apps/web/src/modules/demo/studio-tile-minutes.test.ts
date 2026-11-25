// SPDX-License-Identifier: FSL-1.1-ALv2
// The services world's tiles say the minutes its tour configurations say, and
// Everything is the sum of its seven. The software world keeps its own figures.

import { DEMO_WORLD_NEEDS, STUDIO_SCENARIO_MINUTES } from "@liaison/shared"
import { describe, expect, it } from "vitest"
import { needMinutes, needsMinutes } from "./NeedsPicker"

describe("the services world's tile minutes", () => {
  it("tile minutes read the tour configurations and everything is their sum", () => {
    const tiles = DEMO_WORLD_NEEDS.studio.map((need) => [need, needMinutes("studio", need)])
    expect(tiles).toEqual([
      ["support", 3],
      ["projects", 4],
      ["chat", 3],
      ["sales", 4],
      ["client", 4],
      ["dev", 3],
      ["knowledge", 3],
    ])
    for (const [need, minutes] of tiles) {
      expect(minutes).toBe(STUDIO_SCENARIO_MINUTES[need as keyof typeof STUDIO_SCENARIO_MINUTES])
    }
    expect(needsMinutes(DEMO_WORLD_NEEDS.studio, "studio")).toBe(24)
  })

  it("the software world's projects tile keeps its own figure", () => {
    expect(needMinutes("saas", "projects")).toBe(3)
    expect(needsMinutes(DEMO_WORLD_NEEDS.saas, "saas")).toBe(22)
  })
})
