// SPDX-License-Identifier: FSL-1.1-ALv2
// The path-to-suite map for the demo worlds: a change under a world pack, its
// seed plan, its scenarios or its tours runs the suites that prove them.

import { describe, expect, it } from "bun:test"
import { suitesFor } from "../.claude/test-map"

const WORLD_SUITES = ["demo-seed", "unit", "web-unit", "guards"]

describe("test map: the demo worlds", () => {
  it("the world pack paths map to demo-seed, unit, web-unit and guards", () => {
    for (const file of [
      "apps/api/src/seed/worlds/saas/plan.ts",
      "apps/api/src/modules/demo/worlds/saas/scenarios.ts",
      "packages/shared/src/tours/demo/worlds/saas/money-tour.ts",
    ]) {
      expect(suitesFor(file), file).toEqual(WORLD_SUITES)
    }
  })

  it("the payments fixtures run the seed suite and the modules they reach", () => {
    const suites = suitesFor("apps/api/src/seed/factories/payments/stripe-mirror.ts")
    expect(suites).toContain("demo-seed")
    expect(suites).toContain("unit")
  })

  it("the payments stand-in's integration test runs in the extra integration suite", () => {
    expect(
      suitesFor(
        "apps/api/src/modules/demo/worlds/saas/payments/stripe-standin.integration.test.ts",
      ),
    ).toContain("integration-extra")
  })

  it("keeps the tours outside the worlds on their own mapping", () => {
    expect(suitesFor("packages/shared/src/tours/demo/scenarios.ts")).toEqual([
      "unit",
      "web-unit",
      "integration",
      "guards",
    ])
  })
})
