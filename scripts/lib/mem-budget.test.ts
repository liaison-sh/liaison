// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { computeMemBudget, formatMemBudget, UNCONSTRAINED_E2E_SERVER_PEAK_MB } from "./mem-budget"

const GIB = 1024 * 1024 * 1024

describe("computeMemBudget", () => {
  it("derives every cap on a 16 GiB host with 10 cpus", () => {
    const b = computeMemBudget(16 * GIB, 10, {})
    expect(b.reserveMb).toBe(8192)
    expect(b.budgetMb).toBe(8192)
    expect(b.smol).toBe(false)
    expect(b.playwrightWorkers).toBe(4)
    expect(b.vitestMaxWorkers).toBe(9)
    expect(b.e2eParallelWorkers).toBe(4)
    expect(b.sandboxWorkerPoolMax).toBe(4)
    expect(b.sandboxWarmSize).toBe(1)
    expect(b.sandboxWorkerMaxRssMb).toBe(512)
    expect(b.sandboxPoolMaxSize).toBe(8)
    expect(b.env()).toEqual({
      PLAYWRIGHT_WORKERS: "4",
      VITEST_MAX_WORKERS: "9",
      TEST_E2E_WORKERS: "4",
      APP_WORKER_POOL_MAX: "4",
      SANDBOX_POOL_WARM_SIZE: "1",
      APP_WORKER_MAX_RSS_MB: "512",
      SANDBOX_POOL_MAX_SIZE: "8",
      TEST_UNIT_SHARDS: "5",
      LIAISON_E2E_SERVER_SMOL: "1",
    })
  })

  it("gives each test slot an equal share of the budget", () => {
    // 40 GiB - 8 GiB reserve = 32 GiB, two slots: 16 GiB each.
    const whole = computeMemBudget(40 * GIB, 16, {})
    const half = computeMemBudget(40 * GIB, 16, {}, 2)
    expect(whole.budgetMb).toBe(32768)
    expect(half.budgetMb).toBe(16384)
    // A bogus slot count is one slot, never a division by zero.
    expect(computeMemBudget(40 * GIB, 16, {}, 0).budgetMb).toBe(32768)
    // Caps follow the share: 16 GiB / 1.5 GiB = 10 shards, capped at 8; the
    // whole machine's 32 GiB would also cap at 8, so compare a smaller host.
    expect(computeMemBudget(20 * GIB, 16, {}, 2).unitShards).toBe(4)
    expect(computeMemBudget(20 * GIB, 16, {}, 1).unitShards).toBe(8)
  })

  it("collapses every cap to its floor on an 8 GiB host", () => {
    const b = computeMemBudget(8 * GIB, 8, {})
    expect(b.budgetMb).toBe(0)
    expect(b.smol).toBe(true)
    expect(b.playwrightWorkers).toBe(1)
    expect(b.vitestMaxWorkers).toBe(1)
    expect(b.e2eParallelWorkers).toBe(1)
    expect(b.sandboxWorkerPoolMax).toBe(1)
    expect(b.sandboxWarmSize).toBe(1)
    expect(b.sandboxWorkerMaxRssMb).toBe(256)
    expect(b.sandboxPoolMaxSize).toBe(2)
    expect(b.env().BUN_OPTIONS).toBe("--smol")
  })

  it("caps at the ceilings on a 64 GiB host with 16 cpus", () => {
    const b = computeMemBudget(64 * GIB, 16, {})
    expect(b.budgetMb).toBe(57344)
    expect(b.smol).toBe(false)
    expect(b.playwrightWorkers).toBe(4)
    expect(b.vitestMaxWorkers).toBe(15)
    expect(b.e2eParallelWorkers).toBe(4)
    expect(b.sandboxWorkerPoolMax).toBe(4)
    expect(b.sandboxWorkerMaxRssMb).toBe(512)
    expect(b.sandboxPoolMaxSize).toBe(8)
    expect(b.env().BUN_OPTIONS).toBeUndefined()
  })

  it("honours TEST_MEM_RESERVE_MB and enters low memory mode", () => {
    const b = computeMemBudget(16 * GIB, 10, { TEST_MEM_RESERVE_MB: "14336" })
    expect(b.reserveMb).toBe(14336)
    expect(b.budgetMb).toBe(2048)
    expect(b.smol).toBe(true)
    expect(b.playwrightWorkers).toBe(1)
    expect(b.vitestMaxWorkers).toBe(5)
    expect(b.e2eParallelWorkers).toBe(2)
    expect(b.sandboxWorkerPoolMax).toBe(2)
    expect(b.sandboxWorkerMaxRssMb).toBe(256)
    expect(b.sandboxPoolMaxSize).toBe(4)
    expect(b.env().BUN_OPTIONS).toBe("--smol")
  })

  it("reserves 2 GiB for a single-file run and 8 GiB for a whole suite", () => {
    const file = computeMemBudget(16 * GIB, 10, {}, 1, "single-file")
    expect(file.reserveMb).toBe(2048)
    expect(file.budgetMb).toBe(14336)
    expect(file.smol).toBe(false)
    expect(computeMemBudget(16 * GIB, 10, {}, 1, "suite").reserveMb).toBe(8192)
    // The slot share applies after the smaller reserve: (16 - 2) GiB / 2.
    expect(computeMemBudget(16 * GIB, 10, {}, 2, "single-file").budgetMb).toBe(7168)
  })

  it("lets TEST_MEM_RESERVE_MB override the single-file reserve too", () => {
    const b = computeMemBudget(16 * GIB, 10, { TEST_MEM_RESERVE_MB: "4096" }, 1, "single-file")
    expect(b.reserveMb).toBe(4096)
    expect(b.budgetMb).toBe(12288)
    expect(
      computeMemBudget(16 * GIB, 10, { TEST_MEM_RESERVE_MB: "0" }, 1, "single-file").reserveMb,
    ).toBe(0)
  })

  it("keeps an explicit caller value instead of raising it to the computed one", () => {
    const b = computeMemBudget(64 * GIB, 16, { PLAYWRIGHT_WORKERS: "1", VITEST_MAX_WORKERS: "2" })
    expect(b.playwrightWorkers).toBe(4)
    expect(b.env().PLAYWRIGHT_WORKERS).toBe("1")
    expect(b.env().VITEST_MAX_WORKERS).toBe("2")
    expect(b.env().TEST_E2E_WORKERS).toBe("4")
  })

  it("constrains the spawned e2e server because its measured peak does not fit a worker slice", () => {
    // Unbounded, JSC defers collection to about 7.2 GB RSS before the first
    // full GC drops it back to 779 MB (measured, 31 GB box, 11 browser
    // scenarios). That overshoot does not fit the 2 GiB this module hands a
    // Playwright worker on ANY host, so the server is constrained everywhere.
    expect(UNCONSTRAINED_E2E_SERVER_PEAK_MB).toBeGreaterThan(2 * 1024)
    expect(computeMemBudget(64 * GIB, 16, {}).e2eServerSmol).toBe(true)
    expect(computeMemBudget(32 * GIB, 16, {}).e2eServerSmol).toBe(true)
    expect(computeMemBudget(8 * GIB, 8, {}).e2eServerSmol).toBe(true)
    expect(computeMemBudget(64 * GIB, 16, {}).env().LIAISON_E2E_SERVER_SMOL).toBe("1")
    // An operator turning it off by hand is never turned back on.
    expect(
      computeMemBudget(64 * GIB, 16, { LIAISON_E2E_SERVER_SMOL: "0" }).env()
        .LIAISON_E2E_SERVER_SMOL,
    ).toBe("0")
  })

  it("never returns a worker count below one when cpus is one", () => {
    const b = computeMemBudget(16 * GIB, 1, {})
    expect(b.vitestMaxWorkers).toBe(1)
  })

  it("prints one line per knob with no dash punctuation", () => {
    const text = formatMemBudget(computeMemBudget(16 * GIB, 10, {}))
    expect(text).toContain("budget")
    expect(text).toContain("8192 MB")
    expect(text).toContain("playwright workers")
    expect(text.includes("--")).toBe(false)
  })
})
