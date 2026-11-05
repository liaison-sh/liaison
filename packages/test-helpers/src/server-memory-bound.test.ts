// SPDX-License-Identifier: FSL-1.1-ALv2
// The spawned e2e API server must run under a memory-bounding Bun flag. Left
// unconstrained, JSC defers collection far past the server's live set: one was
// measured climbing 506MB -> 7216MB RSS over eleven browser scenarios on a 31GB
// box, then dropping to 779MB the instant a full GC ran. Four Playwright workers
// overshooting like that blow the 2GiB per worker slice in
// scripts/lib/mem-budget.ts and trip the memory guard mid-lane. `--smol` is the
// only lever Bun 1.3.11 honours (measured on an allocator loop: 152MB baseline,
// 152MB with BUN_JSC_forceRAMSize, 127MB with BUN_JSC_gcMaxHeapSize, 59MB with
// --smol), so these cases pin the flag and its spawn wiring.
import { describe, expect, it } from "bun:test"
import { computeMemBudget } from "../../../scripts/lib/mem-budget"
import { forwardServerBudgetEnv, serverBunFlags } from "./worker-env"

// Budget knobs the harness consumes itself. Every other key the budget computes
// is read by the spawned server and must reach its (allowlisted) env.
const HARNESS_ONLY_BUDGET_KEYS = new Set([
  "PLAYWRIGHT_WORKERS", // apps/web/playwright.config.ts
  "VITEST_MAX_WORKERS", // apps/web/vitest.config.ts
  "TEST_E2E_WORKERS", // scripts/test-e2e-parallel.ts
  "TEST_UNIT_SHARDS", // scripts/test-unit-parallel.ts
  "BUN_OPTIONS", // the server gets --smol on its command line (serverBunFlags)
])

describe("e2e server budget env", () => {
  const GIB = 1024 ** 3
  for (const [label, totalGib] of [
    ["low memory host", 12],
    ["large host", 64],
  ] as const) {
    it(`every server side budget knob reaches the spawned server env: ${label}`, () => {
      const budgetEnv = computeMemBudget(totalGib * GIB, 8, {}).env()
      const forwarded = forwardServerBudgetEnv(budgetEnv)
      const lost = Object.keys(budgetEnv).filter(
        (key) => !HARNESS_ONLY_BUDGET_KEYS.has(key) && forwarded[key] !== budgetEnv[key],
      )
      expect(lost).toEqual([])
    })
  }

  it("forwards nothing the run did not set", () => {
    expect(forwardServerBudgetEnv({})).toEqual({})
  })

  it("spreads the forwarded knobs into the spawned server env", async () => {
    const src = await Bun.file(new URL("./worker-env.ts", import.meta.url)).text()
    expect(src).toContain("...forwardServerBudgetEnv(process.env),")
  })
})

describe("e2e server memory bound", () => {
  it("spawns with --smol by default", () => {
    expect(serverBunFlags({})).toEqual(["--smol"])
  })

  it("lets an operator opt out with LIAISON_E2E_SERVER_SMOL=0 only", () => {
    expect(serverBunFlags({ LIAISON_E2E_SERVER_SMOL: "0" })).toEqual([])
    expect(serverBunFlags({ LIAISON_E2E_SERVER_SMOL: "1" })).toEqual(["--smol"])
    expect(serverBunFlags({ LIAISON_E2E_SERVER_SMOL: "" })).toEqual(["--smol"])
    expect(serverBunFlags({ LIAISON_E2E_SERVER_SMOL: "false" })).toEqual(["--smol"])
  })

  it("puts the flag on the spawned server's command line", async () => {
    // Source pin: the spawn is inline, so this is the cheapest falsifiable
    // guard that the flag reaches the child. Same pattern as
    // apps/api/src/lib/orphan-exit.test.ts pins LIAISON_EXIT_WHEN_ORPHANED.
    const src = await Bun.file(new URL("./worker-env.ts", import.meta.url)).text()
    expect(src).toContain(
      'cmd: ["bun", ...serverBunFlags(process.env), "test-support/index.e2e.ts"]',
    )
  })
})
