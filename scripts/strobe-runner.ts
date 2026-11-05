#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run scripts/strobe-runner.ts --suite <name>`
//
// CI-side wrapper used by .github/workflows/{ci,release}.yml. Interactive dev
// goes through Strobe's debug_test MCP; CI has no MCP host, so this wrapper
// invokes the same suite orchestrator (`scripts/test-run.ts`) the MCP would
// run, ensuring CI executes exactly the same suite definitions, pretest hooks,
// and per-suite environment as Strobe does. Suite "all" runs the composite
// `full` flow (unit + integration + e2e-parallel + web-unit + playwright +
// security + chaos) — must include security (the V2 gate) before any release tag.

import { resolve } from "node:path"
import { computeMemBudget, formatMemBudget } from "./lib/mem-budget"
import { formatMemGuard, startMemGuard } from "./lib/mem-guard"
import { acquireTestLock, slotCount } from "./lib/test-lock"

const ROOT = resolve(new URL("..", import.meta.url).pathname)
const SUITES = new Set([
  "unit",
  "integration",
  "e2e-parallel",
  "playwright",
  "security",
  "web-unit",
  "all",
])

interface Args {
  suite: string
  dryRun: boolean
}

export function parseArgs(argv: string[]): Args {
  let suite = ""
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--suite") suite = argv[++i] ?? ""
    else if (a === "--dry-run") dryRun = true
  }
  if (!suite) {
    console.error("missing --suite")
    process.exit(2)
  }
  if (!SUITES.has(suite)) {
    console.error(`unknown suite: ${suite}`)
    process.exit(2)
  }
  return { suite, dryRun }
}

export function resolveCommand(suite: string): string[] {
  if (suite === "all") return ["bun", "run", "scripts/test-run.ts", "full"]
  return ["bun", "run", "scripts/test-run.ts", suite]
}

async function run(suite: string): Promise<number> {
  // Same two guards the orchestrator applies, applied here too because Strobe
  // and CI both enter through this wrapper: one suite run at a time on the
  // machine, and every knob sized from the RAM this host actually has.
  // LIAISON_TEST_LOCK_HELD tells the spawned test-run.ts that we hold it.
  // Third guard, same reason: the budget is a plan and the lock is a turnstile,
  // neither stops a run that grows past what the machine has while it runs.
  // startMemGuard samples available memory and this tree's RSS and kills the
  // whole tree rather than letting the OOM killer pick the victim.
  // One test slot, and this run's share of the machine (test-run.ts takes
  // the namespace itself).
  const budget = computeMemBudget(undefined, undefined, process.env, slotCount())
  let memGuard: { setLogDir(dir: string): void; stop(): void } | null = null
  if (process.env.LIAISON_TEST_LOCK_HELD !== "1") {
    await acquireTestLock({ cmd: `strobe-runner.ts ${suite}` })
    memGuard = startMemGuard({
      budgetMb: budget.budgetMb,
      reserveMb: budget.reserveMb,
      logDir: resolve(ROOT, "logs"),
      label: `strobe-runner.ts ${suite}`,
    })
  }
  console.log(formatMemBudget(budget))
  if (memGuard) console.log(formatMemGuard(budget.budgetMb, budget.reserveMb))
  console.log("")
  const cmd = resolveCommand(suite)
  console.log(`→ ${cmd.join(" ")}`)
  const timeoutMs = Number(process.env.STROBE_TIMEOUT_MS ?? 30 * 60_000)
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    env: { ...process.env, ...budget.env(), LIAISON_TEST_LOCK_HELD: "1" },
    stdout: "inherit",
    stderr: "inherit",
  })
  const timer = setTimeout(() => {
    console.error(`timeout: suite ${suite} exceeded ${timeoutMs}ms`)
    proc.kill("SIGKILL")
  }, timeoutMs)
  const code = await proc.exited
  clearTimeout(timer)
  memGuard?.stop()
  return code
}

async function main() {
  const { suite, dryRun } = parseArgs(process.argv.slice(2))
  if (dryRun) {
    console.log(resolveCommand(suite).join(" "))
    return
  }
  const code = await run(suite)
  process.exit(code)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
