// SPDX-License-Identifier: FSL-1.1-ALv2
// scripts/test-e2e-parallel.ts
// Spawns N bun:test processes, one per API scenario file, each with a unique WORKER_ID.
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createE2eLane, type E2eLane } from "../packages/test-helpers/src/e2e-lane"
import { E2E_LANE_ENV } from "../packages/test-helpers/src/worker-env"
import { apiE2eScenarioFiles } from "./lib/api-e2e-files"

const ROOT_ENV_FILE = path.resolve(import.meta.dir, "../.env.test")

// Each file's own `bun test` gets an explicit --timeout: bun ignores the
// `[test] timeout` key in bunfig.toml, so without the flag every hook and every
// case that names no timeout of its own ran at bun's 5 s default, and a loaded
// machine failed `beforeAll` setups with nothing but "(unnamed) timed out".
// scripts/test-run.ts passes the same cap to the bun-test suites it runs itself
// and publishes it as BUN_TEST_TIMEOUT_MS; a bare invocation falls back to it.
const bunTestTimeoutMs = (() => {
  const fromEnv = Number(process.env.BUN_TEST_TIMEOUT_MS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 60_000
})()

// Worker count: an explicit --workers= flag wins, then TEST_E2E_WORKERS (set
// from the computed memory budget by scripts/test-run.ts and the strobe
// runner), then a conservative 1. The old hardcoded 4 spawned four full
// bun:test processes regardless of how much RAM the host actually had.
const workerFlag = Number(process.argv.find((a) => a.startsWith("--workers="))?.split("=")[1])
const workerEnvValue = Number(process.env.TEST_E2E_WORKERS)
const workerCount =
  Number.isFinite(workerFlag) && workerFlag > 0
    ? Math.floor(workerFlag)
    : Number.isFinite(workerEnvValue) && workerEnvValue > 0
      ? Math.floor(workerEnvValue)
      : 1
const scenarioDir = path.resolve(import.meta.dir, "../apps/api/src/tests/e2e")

// Discover all scenario files, INCLUDING the ones in subdirectories: the
// agent-memory harness lives in one, and a non recursive glob left every file
// in it invisible to this lane while the sequential `e2e` suite ran them.
//
// Files named on the command line (relative to apps/api or the repo root, or
// absolute) narrow the run to just those: `test:gate` passes the scenarios a
// change touches.
const named = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const apiDir = path.resolve(import.meta.dir, "../apps/api")
const scenarioFiles: string[] = []
if (named.length > 0) {
  for (const f of named) {
    const candidates = [path.resolve(apiDir, f), path.resolve(import.meta.dir, "..", f)]
    const hit = candidates.find((c) => existsSync(c))
    if (!hit) {
      console.error(`no such scenario file: ${f}`)
      process.exit(1)
    }
    scenarioFiles.push(hit)
  }
} else {
  // Never the `cell` suite's directory (scripts/lib/api-e2e-files.ts): each of
  // those files boots several API processes of its own.
  scenarioFiles.push(...apiE2eScenarioFiles(scenarioDir))
}

// `--list`: print the files this run would take and exit, booting nothing
// (scripts/test-run.suites.test.ts holds the cell exclusion with it).
if (process.argv.includes("--list")) {
  for (const f of scenarioFiles) console.log(f)
  process.exit(0)
}

console.log(
  `Running ${scenarioFiles.length} scenarios across ${Math.min(workerCount, scenarioFiles.length)} workers`,
)

// Each parallel slot is a LANE: it boots one API server and runs its files
// against it one after another, the worker's data reset to the post-boot
// snapshot before each (packages/test-helpers/src/e2e-lane.ts). A file whose
// source carries the `e2e-own-server` marker runs the old way instead (its own
// schemas and server), after the slot's lane is closed so the two servers never
// overlap. LIAISON_E2E_SHARED_SERVER=0 runs every file the old way.
const sharedLanes = process.env.LIAISON_E2E_SHARED_SERVER !== "0"
const OWN_SERVER_MARKER = "e2e-own-server"
const limit = Math.min(workerCount, scenarioFiles.length)
// In-process scenario files (they import route-test-setup: acquireTestLock,
// createTestOrg) run the API in the test process itself against the namespace
// database's UNPREFIXED schemas, which every such file shares. Two of them at
// once reset and seed the same tables, so they run one after another, on slot 0
// only; route-test-setup's database lock is the safety net, not the schedule.
// A file that never calls setupScenario is in-process too, whatever it imports:
// it seeds the shared schemas itself (the MCP test helpers, ~/db), and run on a
// lane slot beside the in-process queue it collided with it (one file's reset
// deleted the other's org mid-test; the other's org failed a bootstrap).
const IN_PROCESS_MARKER = "~/tests/route-test-setup"
const LANE_ENTRY = "setupScenario("
const sharedQueue: string[] = []
const ownQueue: string[] = []
const inProcessQueue: string[] = []
for (const file of scenarioFiles) {
  const source = await Bun.file(file).text()
  if (source.includes(IN_PROCESS_MARKER) || !source.includes(LANE_ENTRY)) {
    inProcessQueue.push(file)
    continue
  }
  const ownServer = !sharedLanes || source.includes(OWN_SERVER_MARKER)
  ;(ownServer ? ownQueue : sharedQueue).push(file)
}
const results: Array<{
  file: string
  exitCode: number
  stdout: string
  stderr: string
  wallMs: number
  testMs: number
  mode: "lane" | "own"
}> = []
const logDir = process.env.LOG_DIR ?? path.resolve(import.meta.dir, "../logs")
// Lanes take worker ids 0..limit-1; every file gets a private id above them
// for the schemas and ports of a server of its own (own-server files, and a
// lane file that asks for one through `setupScenario({ ownServer: true })`).
let nextPrivateId = limit

/**
 * Sum of the per-test durations bun prints (`(pass) name [12.34ms]`): the time
 * spent inside test bodies. The file's wall clock minus this is setup,
 * teardown and module load, which is what a slow file usually spends on.
 */
function sumTestBodyMs(output: string): number {
  let total = 0
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "")
  for (const m of plain.matchAll(/^(?:\((?:pass|fail)\)|✓|✗) .*\[([\d.]+)(ms|s)\]\s*$/gm)) {
    const v = Number(m[1])
    total += m[2] === "s" ? v * 1000 : v
  }
  return total
}

async function runFile(file: string, lane: E2eLane | null): Promise<void> {
  const workerId = nextPrivateId++
  // Strip DATABASE_URL + NODE_ENV inherited from this script's own process —
  // when `bun run scripts/test-e2e-parallel.ts` boots, Bun auto-loads
  // apps/api/.env (DATABASE_URL=…liaison_dev, NODE_ENV=development), which then
  // leaks into the spawned `bun test` child. Without scrubbing, the child's
  // `~/db/connection` (env.DATABASE_URL) connects to liaison_dev instead of
  // liaison_test, so any test that imports `__privileged_db__` (e.g.
  // tickets.scenario S8) hits "relation w<n>_kernel.organizations does not
  // exist". Removing them lets `bun test` set NODE_ENV=test itself and
  // re-load DATABASE_URL from the test env file below.
  //
  // The repo-root `.env.test` is passed explicitly with --env-file: Bun's
  // implicit `.env.test` load is cwd-relative and apps/api has none, so without
  // the flag a checkout whose test env lives only at the root (the documented
  // setup) runs every file that imports `~/lib/env` with no JWT_SECRET /
  // ENCRYPTION_KEY and it dies at load. Same flag scripts/test-run.ts passes
  // the sequential bun-test suites.
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    WORKER_ID: String(workerId),
    DB_POOL_MAX: "8",
    BUN_TEST_TIMEOUT_MS: String(bunTestTimeoutMs),
  }
  if (lane) childEnv[E2E_LANE_ENV] = JSON.stringify(lane.info)
  else delete childEnv[E2E_LANE_ENV]
  // Under scripts/test-run.ts the run namespace (LIAISON_TEST_NS) has already
  // set DATABASE_URL to the namespace's own database: keep that one. Only a
  // bare invocation has the auto-loaded liaison_dev URL to strip.
  if (!process.env.LIAISON_TEST_NS) delete childEnv.DATABASE_URL
  delete childEnv.NODE_ENV
  const envFileArgs = existsSync(ROOT_ENV_FILE) ? [`--env-file=${ROOT_ENV_FILE}`] : []
  const startedAt = performance.now()
  const proc = Bun.spawn({
    cmd: ["bun", "test", "--timeout", String(bunTestTimeoutMs), ...envFileArgs, file],
    cwd: path.resolve(import.meta.dir, "../apps/api"),
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  })

  const readStream = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    const chunks: string[] = []
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(decoder.decode(value, { stream: true }))
      }
    } catch {}
    return chunks.join("")
  }

  const [stdout, stderr] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr)])
  const exitCode = await proc.exited
  const wallMs = performance.now() - startedAt
  const testMs = sumTestBodyMs(`${stdout}\n${stderr}`)
  // Every file's own output, passing or not, next to the run's other logs.
  try {
    mkdirSync(logDir, { recursive: true })
    writeFileSync(
      path.join(logDir, `${path.basename(file, ".scenario.test.ts")}.log`),
      `${stdout}\n${stderr}`,
    )
  } catch {}
  results.push({
    file: path.basename(file),
    exitCode,
    stdout,
    stderr,
    wallMs,
    testMs,
    mode: lane ? "lane" : "own",
  })
}

async function runSlot(laneId: number): Promise<void> {
  // Slot 0 runs the in-process files first, one at a time, with no lane: they
  // never call setupScenario.
  if (laneId === 0) {
    while (true) {
      const file = inProcessQueue.shift()
      if (!file) break
      await runFile(file, null)
    }
  }
  let lane: E2eLane | null = null
  let laneBroken = false
  try {
    while (true) {
      const file = sharedQueue.shift()
      if (!file) break
      if (!lane && !laneBroken) {
        const t0 = performance.now()
        try {
          lane = await createE2eLane(laneId, logDir)
          console.log(
            `lane ${laneId}: server up + snapshot in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
          )
        } catch (err) {
          // Loud, and the slot keeps going the old way rather than failing
          // every file it would have run.
          laneBroken = true
          console.error(`lane ${laneId} failed to start, running its files with their own server:`)
          console.error(err)
        }
      }
      await runFile(file, lane)
    }
  } finally {
    await lane?.close().catch((err) => console.error(`lane ${laneId} close failed:`, err))
  }
  while (true) {
    const file = ownQueue.shift()
    if (!file) break
    await runFile(file, null)
  }
}

const suiteStart = performance.now()
await Promise.all(Array.from({ length: limit }, (_, i) => runSlot(i)))
const suiteWallMs = performance.now() - suiteStart

// Report results
let failed = 0
for (const r of results) {
  const status = r.exitCode === 0 ? "✓" : "✗"
  const wall = (r.wallMs / 1000).toFixed(1)
  const body = (r.testMs / 1000).toFixed(1)
  const setup = ((r.wallMs - r.testMs) / 1000).toFixed(1)
  console.log(
    `${status} ${r.file} (exit ${r.exitCode}) [${r.mode}] wall ${wall}s = tests ${body}s + setup/teardown ${setup}s`,
  )
  // tests/e2e/setup.ts prints where each setupScenario call spent its time.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
  for (const line of `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    if (line.startsWith("[setupScenario]")) console.log(`    ${line}`)
  }
  if (r.exitCode !== 0) {
    failed++
    console.log(r.stdout)
    console.error(r.stderr)
  }
}

console.log(`e2e-parallel wall clock: ${(suiteWallMs / 1000).toFixed(1)}s`)
process.exit(failed > 0 ? 1 : 0)
