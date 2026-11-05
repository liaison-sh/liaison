// SPDX-License-Identifier: FSL-1.1-ALv2
// Dynamic memory budget for test runs.
//
// Every parallelism knob in this repo was a fixed constant sized for the
// biggest machine anyone had used: vitest with no maxWorkers (cpus-1 jsdom
// workers), 4 hardcoded e2e-parallel children, 8 warm sandbox worker
// subprocesses recycling at 512MB RSS, 24 in-process QuickJS slots at 32MB.
// Summed, a full suite run wants roughly twice the RAM of a 16GB laptop, so
// the suite OOM-killed the host instead of running slower.
//
// This module turns those constants into one function of the machine: reserve
// a slice for the OS plus editors plus browsers, then spend what is left
// on a derived set of caps. The SAME function runs on a 16GB laptop, a CI
// runner and a 64GB workstation, so no knob has to be tuned per host and no
// host silently inherits another host's headroom.
//
// Pure and side effect free: it reads nothing, spawns nothing, and takes every
// input as a parameter so it can be pinned by unit tests at exact numbers.

import os from "node:os"

const MIB = 1024 * 1024
const GIB = 1024 * MIB

/**
 * Slice withheld from the budget for the OS and whatever else is open, for a
 * whole-suite run: dozens of files, several lanes, servers and browsers at once.
 */
export const DEFAULT_RESERVE_BYTES = 8 * GIB
/**
 * The reserve for a targeted run (`test-run.ts <suite> --file <path>`, one or
 * more files). Its tree is one lane, measured at 0.7 GB for a Playwright file, so
 * withholding 8 GiB on a 16 GiB Mac stopped runs that fit several times over
 * while the machine reported a third of its memory free. 2 GiB still keeps
 * the OS and the editor clear of the run.
 */
export const SINGLE_FILE_RESERVE_BYTES = 2 * GIB

/** What the run covers: one file, or a whole suite (any other shape). */
export type RunScope = "suite" | "single-file"
/** Below this much budget the run goes into low memory mode. */
export const SMOL_THRESHOLD_BYTES = 6 * GIB
/**
 * Peak RSS one e2e API server reaches before its first full GC when nothing
 * bounds it, measured on the dev box (31GB, eleven browser scenarios, RSS read
 * from /proc by pid): 506MB at boot, 7216MB at scenario 11, 779MB at 13. The
 * live set is about 770MB, so this is deferred collection, not a leak, and it
 * is the number the per-worker slice has to be compared against.
 */
export const UNCONSTRAINED_E2E_SERVER_PEAK_MB = 7216

export interface MemBudget {
  /** Spendable budget in whole MiB (total minus reserve, never negative). */
  budgetMb: number
  /** The reserve actually applied, in whole MiB. */
  reserveMb: number
  /** Low memory mode: shrink every cap and hand children the bun --smol flag. */
  smol: boolean
  playwrightWorkers: number
  vitestMaxWorkers: number
  e2eParallelWorkers: number
  sandboxWorkerPoolMax: number
  sandboxWarmSize: number
  sandboxWorkerMaxRssMb: number
  sandboxPoolMaxSize: number
  /** Concurrent `bun test` processes of the sharded unit suite (test-unit-parallel.ts). */
  unitShards: number
  /**
   * Whether a spawned e2e API server runs under `bun --smol`. True whenever the
   * server's MEASURED unconstrained peak does not fit the per-Playwright-worker
   * slice, which is every host: left alone, JSC defers collection until about
   * 7.2GB RSS (measured, 31GB box, eleven browser scenarios), then a full GC
   * drops it to 779MB. Four workers overshooting like that trip the memory
   * guard mid-lane, which is the 2-workers-only workaround this removes.
   */
  e2eServerSmol: boolean
  /**
   * The env var map to inject into every spawned suite. Values the caller had
   * already set explicitly are preserved verbatim, so an operator lowering a
   * knob by hand is never raised back up by the computed value.
   */
  env(): Record<string, string>
}

// The low bound always wins: a ceiling of cpus-1 collapses to 0 on a single
// core host, and a worker count of 0 means "no workers", not "go slow".
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(high, low))
}

function perUnit(budgetBytes: number, unitBytes: number): number {
  return Math.floor(budgetBytes / unitBytes)
}

/**
 * Derives every test parallelism cap from the machine's total RAM.
 *
 * @param totalBytes Total physical memory. Defaults to this machine's.
 * @param cpus Usable parallelism. Defaults to this machine's.
 * @param env Environment read for overrides (TEST_MEM_RESERVE_MB, which wins
 *   over both default reserves) and for the caller wins rule applied by the
 *   returned `env()`.
 * @param slots How many runs may share the machine at once (scripts/lib/
 *   test-lock.ts). Each run gets an equal share of what is left after the
 *   reserve, so the slots together never plan past the machine.
 * @param scope "single-file" for a run of exactly one file, which defaults to
 *   SINGLE_FILE_RESERVE_BYTES; anything else keeps DEFAULT_RESERVE_BYTES.
 */
export function computeMemBudget(
  totalBytes: number = os.totalmem(),
  cpus: number = os.availableParallelism(),
  env: NodeJS.ProcessEnv = process.env,
  slots = 1,
  scope: RunScope = "suite",
): MemBudget {
  const reserveOverrideMb = Number(env.TEST_MEM_RESERVE_MB)
  const reserveBytes =
    Number.isFinite(reserveOverrideMb) && reserveOverrideMb >= 0
      ? Math.floor(reserveOverrideMb) * MIB
      : scope === "single-file"
        ? SINGLE_FILE_RESERVE_BYTES
        : DEFAULT_RESERVE_BYTES

  const share = Number.isInteger(slots) && slots >= 1 ? slots : 1
  const budgetBytes = Math.floor(Math.max(0, totalBytes - reserveBytes) / share)
  const budgetMb = Math.floor(budgetBytes / MIB)
  const smol = budgetBytes < SMOL_THRESHOLD_BYTES

  // One Playwright worker is a lane (an API server serving the web build, no
  // Vite since the shared lanes, apps/web/src/tests/e2e/pw-lanes.ts) plus its
  // Chromium: measured 0.7-1.0GiB for the server and about 0.7GiB of browser
  // per worker, so one per 1.5GiB. At most 4: memory would allow 6 on a 43GiB
  // box, but 6 was measured SLOWER (the same 62 tests: 4.9 min against 2.9;
  // test time summed 418 s against 233 s, and six parallel seeds took twice as
  // long). The lanes are CPU bound, not memory bound.
  const playwrightWorkers = clamp(perUnit(budgetBytes, Math.floor(1.5 * GIB)), 1, 4)
  // A vitest jsdom worker is cheap (about 400MiB) but never worth more than
  // cpus-1 of them.
  const vitestMaxWorkers = clamp(perUnit(budgetBytes, Math.floor(0.4 * GIB)), 1, cpus - 1)
  // An e2e-parallel child is a full bun:test process against its own schema.
  const e2eParallelWorkers = clamp(perUnit(budgetBytes, GIB), 1, 4)
  // Sandbox worker subprocesses: RSS ratchets monotonically until recycled, so
  // count each at its recycling cap rather than its cold size.
  const sandboxWorkerPoolMax = clamp(perUnit(budgetBytes, GIB), 1, 4)
  // Warm eagerly only in production. A test run wants no spawn storm at boot.
  const sandboxWarmSize = 1
  const sandboxWorkerMaxRssMb = smol ? 256 : 512
  // In-process QuickJS slots, 32MiB of WASM linear memory each that is never
  // returned to the OS. Floor of 2 keeps the pool able to queue rather than
  // deadlock on a nested acquire.
  const sandboxPoolMaxSize = clamp(perUnit(budgetBytes, Math.floor(0.5 * GIB)), 2, 8)
  // A sharded unit file is one bun:test process with the app graph loaded
  // (about 1GiB at peak), so one shard per 1.5GiB, never more than the cores.
  const unitShards = clamp(perUnit(budgetBytes, Math.floor(1.5 * GIB)), 1, Math.min(8, cpus))
  // Measured on the dev box: an unconstrained e2e server peaks near
  // UNCONSTRAINED_E2E_SERVER_PEAK_MB before its first full GC, while its live
  // set is about 770MiB. Compare the peak against the slice a Playwright worker
  // actually gets (the server shares it with Chromium, about 700MiB) and
  // constrain the server whenever the peak does not fit.
  const playwrightWorkerSliceMb = Math.floor(1.5 * 1024)
  const e2eServerSmol = UNCONSTRAINED_E2E_SERVER_PEAK_MB > playwrightWorkerSliceMb

  const computed: Record<string, string> = {
    PLAYWRIGHT_WORKERS: String(playwrightWorkers),
    VITEST_MAX_WORKERS: String(vitestMaxWorkers),
    TEST_E2E_WORKERS: String(e2eParallelWorkers),
    APP_WORKER_POOL_MAX: String(sandboxWorkerPoolMax),
    SANDBOX_POOL_WARM_SIZE: String(sandboxWarmSize),
    APP_WORKER_MAX_RSS_MB: String(sandboxWorkerMaxRssMb),
    SANDBOX_POOL_MAX_SIZE: String(sandboxPoolMaxSize),
    TEST_UNIT_SHARDS: String(unitShards),
    LIAISON_E2E_SERVER_SMOL: e2eServerSmol ? "1" : "0",
  }
  if (smol) computed.BUN_OPTIONS = "--smol"

  return {
    budgetMb,
    reserveMb: Math.floor(reserveBytes / MIB),
    smol,
    playwrightWorkers,
    vitestMaxWorkers,
    e2eParallelWorkers,
    sandboxWorkerPoolMax,
    sandboxWarmSize,
    sandboxWorkerMaxRssMb,
    sandboxPoolMaxSize,
    unitShards,
    e2eServerSmol,
    env() {
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(computed)) {
        const explicit = env[key]
        out[key] = explicit !== undefined && explicit !== "" ? explicit : value
      }
      return out
    },
  }
}

/** One line per knob, for printing once at the start of a run. */
export function formatMemBudget(budget: MemBudget): string {
  const rows: Array<[string, string | number]> = [
    ["budget", `${budget.budgetMb} MB`],
    ["low memory mode", budget.smol ? "yes" : "no"],
    ["playwright workers", budget.playwrightWorkers],
    ["vitest max workers", budget.vitestMaxWorkers],
    ["e2e parallel workers", budget.e2eParallelWorkers],
    ["sandbox worker pool max", budget.sandboxWorkerPoolMax],
    ["sandbox warm size", budget.sandboxWarmSize],
    ["sandbox worker max RSS", `${budget.sandboxWorkerMaxRssMb} MB`],
    ["sandbox pool max size", budget.sandboxPoolMaxSize],
    ["unit shards", budget.unitShards],
    ["e2e server low memory mode", budget.e2eServerSmol ? "yes" : "no"],
  ]
  const width = Math.max(...rows.map(([label]) => label.length))
  const lines = rows.map(([label, value]) => `  ${label.padEnd(width)} : ${value}`)
  return [`memory budget (reserve ${budget.reserveMb} MB)`, ...lines].join("\n")
}
