#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run scripts/with-test-lock.ts -- <command> [args...]`
// `bun run scripts/with-test-lock.ts --slot-only -- <command> [args...]`
// `bun run scripts/with-test-lock.ts --light -- <command> [args...]`
//
// The one wrapper for heavy work on a shared machine. --slot-only holds a
// machine-wide slot (scripts/lib/machine-slots.ts) and nothing else: a
// typecheck, a docs check, an app build, a test that needs no database.
// It queues in the heavy lane, except a tsgo or Biome command, which goes to
// the light lane (its own slots and queue, no load gate) so a one-minute check
// never waits behind hour-long suites. --light asks for the light lane for any
// other job of about a minute that needs no database.
//
// Without it, runs one command while holding a machine-wide test slot, inside this
// checkout's run namespace (its own database, Redis/Meili prefixes and port
// block: packages/test-helpers/src/test-namespace.ts), with the computed memory
// budget injected into its environment.
//
// Why this exists: Strobe's bun adapter hardcodes `bun test` and its
// `.strobe/settings.json` accepts only event and vision keys, so a project
// cannot redirect `debug_test` through scripts/test-run.ts. Anything that has
// to bypass the orchestrator (the substrate reset, the chunked Playwright
// commands, a one-off `bunx playwright test`) still needs the same two guards
// the orchestrator applies, so it goes through this wrapper.

import path from "node:path"
import {
  namespaceEnv,
  namespaceForCheckout,
  resolveTestCoordinates,
} from "../packages/test-helpers/src/test-namespace"
import { isLightCommand } from "./lib/machine-slots"
import { computeMemBudget, formatMemBudget } from "./lib/mem-budget"
import { resolveTestRedisPrefix } from "./lib/redis-prefix"
import {
  acquireNamespaceLock,
  acquireTestLock,
  leasePortBlock,
  releaseOnFailure,
  slotCount,
} from "./lib/test-lock"
import { prepareNamespaceDb } from "./lib/test-template"

const ROOT = path.resolve(import.meta.dir, "..")

const rawArgv = process.argv.slice(2)
const light = rawArgv[0] === "--light"
const slotOnly = rawArgv[0] === "--slot-only" || light
const argv = slotOnly ? rawArgv.slice(1) : rawArgv
const cmd = argv[0] === "--" ? argv.slice(1) : argv
if (cmd.length === 0) {
  console.error(
    "Usage: bun run scripts/with-test-lock.ts [--slot-only | --light] -- <command> [args...]",
  )
  process.exit(2)
}

async function runChild(env: Record<string, string | undefined>): Promise<never> {
  const proc = Bun.spawn({ cmd, env, stdout: "inherit", stderr: "inherit", stdin: "inherit" })
  // The child dies with us: a Ctrl-C or a kill of this wrapper must not leave
  // it running outside the slot this process held for it.
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.prependListener(signal, () => proc.kill(signal))
  process.exit(await proc.exited)
}

if (slotOnly) {
  if (process.env.LIAISON_TEST_LOCK_HELD !== "1") {
    await acquireTestLock({
      cmd: cmd.join(" "),
      lane: light || isLightCommand(cmd) ? "light" : "heavy",
    })
  }
  await runChild({ ...process.env, LIAISON_TEST_LOCK_HELD: "1" })
}

// Third guard, alongside the lock and the budget: a private Redis namespace.
// Unprefixed, every process on the same Redis database shares one BullMQ
// namespace and they consume each other's jobs, which surfaces as unrelated
// await timeouts in whichever run loses the race.
const redisPrefix = resolveTestRedisPrefix()

// The bun timeout this command carries, published to it the way test-run.ts publishes
// each suite's own. A test helper that bounds its own wait has to land BELOW bun's cap,
// or bun kills the case first and the run says only that something timed out; without
// this, a direct run through this wrapper left every such helper on the 30 s fallback
// while bun ran at the --timeout named here. Absent, nothing is published and the
// fallback stands, which is the honest answer.
function forwardedBunTestTimeoutMs(command: string[]): string | undefined {
  if (command[0] !== "bun" || command[1] !== "test") return undefined
  const flag = command.indexOf("--timeout")
  const value = flag === -1 ? undefined : command[flag + 1]
  return value !== undefined && /^\d+$/.test(value) ? value : undefined
}
const bunTestTimeoutMs = forwardedBunTestTimeoutMs(cmd)

const slots = slotCount()
const budget = computeMemBudget(undefined, undefined, process.env, slots)
const ns = namespaceForCheckout(ROOT)
let portBase = process.env.LIAISON_TEST_PORT_BASE
const nsHeld = process.env.LIAISON_TEST_NS_HELD === "1" && Boolean(portBase)
if (!nsHeld) {
  await acquireNamespaceLock(ns, { cmd: cmd.join(" ") })
  portBase = String(leasePortBlock(ns, { cmd: cmd.join(" ") }).base)
}
const lock =
  process.env.LIAISON_TEST_LOCK_HELD !== "1"
    ? await acquireTestLock({ cmd: cmd.join(" "), ns })
    : null
const coords = resolveTestCoordinates({
  ...process.env,
  LIAISON_TEST_NS: ns,
  LIAISON_TEST_PORT_BASE: portBase,
})
// The namespace database, reused while it matches the current migrations and
// re-cloned from the template when it does not. A parent that holds the
// namespace has already prepared it.
if (!nsHeld) {
  // Infrastructure down: the slot goes back at once, not when the error unwinds.
  const r = lock
    ? await releaseOnFailure(lock, () => prepareNamespaceDb({ root: ROOT, coords, fresh: false }))
    : await prepareNamespaceDb({ root: ROOT, coords, fresh: false })
  console.log(`namespace ${ns}: ${coords.dbName} ${r.action} (${r.ms}ms)`)
}
console.log(formatMemBudget(budget))
console.log(`redis prefix: ${redisPrefix}`)
console.log("")

await runChild({
  ...process.env,
  ...budget.env(),
  ...namespaceEnv(coords),
  REDIS_PREFIX: redisPrefix,
  LIAISON_TEST_LOCK_HELD: "1",
  LIAISON_TEST_NS_HELD: "1",
  ...(bunTestTimeoutMs !== undefined ? { BUN_TEST_TIMEOUT_MS: bunTestTimeoutMs } : {}),
})
