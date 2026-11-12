// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app contract harness: every entry point of an app runs twice in ONE
// reused isolate (contract/isolate.ts; QuickJS today, any executor behind the
// same seam later), each run on its own replay bridge (recorded egress
// fixtures, replay-bridge.ts), under its row of the per-run limit table
// (run-limits.ts, production values). An entry fails the contract when:
//
//   module-state  its second run answers differently from its first: state the
//                 module kept between runs changed a result (the isolate's
//                 clock and random are reset per run, the bridge answers the
//                 same, so nothing else can);
//   wait          a run waited in its own timers for more than 2 s (the
//                 isolate's sleep counter); the static half is wait-lint.ts;
//   budget        a run went past its wall clock or heap, or made more bridge
//                 calls than its budget;
//   no-fixture    a run made a bridge call no fixture answers: the entry cannot
//                 be judged until its egress is recorded;
//   missing-export / load  the manifest names an export the bundle lacks, or
//                 the bundle does not evaluate.
//
// A passing entry is TRIVIAL when it has no recorded fixture and every run
// rejected its (empty) input: it threw or answered `{ error }` before reaching
// anything the contract checks (module state, waits, budget). Such a pass
// proves nothing; apps.contract.test.ts counts them per app
// (trivial-passes.json), and the count only shrinks: recording the entry's
// fixture is what turns it into a real pass.

import { join } from "node:path"
import { type RunLimits, runLimits } from "~/modules/apps/run-limits"
import { esmExportsToGlobalThis, loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import type { ContractEntry } from "./entries"
import type {
  ContractExecutor,
  ContractIsolate,
  ContractRunOutcome,
  ContractSource,
} from "./isolate"
import {
  canonicalJson,
  createReplayBridge,
  type EgressFixture,
  type ReplayStats,
} from "./replay-bridge"
import { MAX_IN_RUN_WAIT_MS } from "./wait-lint"

export type ContractReason =
  | "module-state"
  | "wait"
  | "budget"
  | "no-fixture"
  | "missing-export"
  | "load"

export interface EntryVerdict {
  entry: string
  /** Empty: the entry keeps the contract. */
  reasons: ContractReason[]
  detail?: string
  /** Passed only by rejecting empty input, with no fixture (see the header). */
  trivial?: true
}

export type BridgeSurface = ReadonlyArray<readonly [string, "sync" | "async"]>

export interface AppUnderContract {
  app: string
  /** Absolute app directory (bundled-apps/<name> or apps/api/src/apps/<name>). */
  dir: string
  entries: ContractEntry[]
  /** The app's handler code for this executor. */
  source: ContractSource
  /** A PDF template's code for this executor, by its source path. */
  templateSource?: (relativePath: string) => Promise<ContractSource>
  surface: BridgeSurface
  /**
   * The bridge a webhook verifier gets in production (webhooks/verify-bridge.ts):
   * config and HMAC helpers only. Defaults to `surface`.
   */
  verifySurface?: BridgeSurface
  fixtures?: Record<string, EgressFixture>
}

/** The bridge surface an entry's run gets: a webhook verifier's own, else the app's. */
export function surfaceFor(
  app: Pick<AppUnderContract, "surface" | "verifySurface">,
  entry: ContractEntry,
): BridgeSurface {
  return entry.kind === "webhook-verify" && app.verifySurface ? app.verifySurface : app.surface
}

/** Production limits: the contract holds an app to the budget it gets in production. */
export function productionLimits(entry: ContractEntry): RunLimits {
  return runLimits(entry.kind, {
    declaredMs: entry.declaredMs,
    env: { ...process.env, NODE_ENV: "production" },
  })
}

interface RunRecord {
  outcome: ContractRunOutcome
  stats: ReplayStats
}

/** The run refused its input: it threw, or answered with a top-level `error`. */
function rejected(r: ContractRunOutcome): boolean {
  if (!r.ok) return true
  const res = r.result
  return typeof res === "object" && res !== null && !Array.isArray(res) && "error" in res
}

function answerOf(r: ContractRunOutcome): string {
  return canonicalJson(r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error })
}

/** Judge every entry of one app on one executor. */
export async function runAppContract(
  app: AppUnderContract,
  executor: ContractExecutor,
  opts: { limitsFor?: (entry: ContractEntry) => RunLimits } = {},
): Promise<EntryVerdict[]> {
  const limitsFor = opts.limitsFor ?? productionLimits
  const verdicts: EntryVerdict[] = []
  const memoryBytes = runLimits("tool").memoryBytes
  let shared: ContractIsolate | null = null
  let sharedError: string | null = null
  const openShared = async (): Promise<ContractIsolate | null> => {
    if (shared || sharedError) return shared
    try {
      shared = await executor.open(app.source, { memoryBytes })
    } catch (err) {
      sharedError = err instanceof Error ? err.message : String(err)
    }
    return shared
  }

  try {
    for (const entry of app.entries) {
      let isolate: ContractIsolate | null
      let own: ContractIsolate | null = null
      if (entry.templateSource) {
        try {
          if (!app.templateSource) throw new Error("no template loader")
          own = await executor.open(await app.templateSource(entry.templateSource), { memoryBytes })
        } catch (err) {
          verdicts.push({
            entry: entry.entry,
            reasons: ["load"],
            detail: err instanceof Error ? err.message : String(err),
          })
          continue
        }
        isolate = own
      } else {
        isolate = await openShared()
        if (!isolate) {
          verdicts.push({
            entry: entry.entry,
            reasons: ["load"],
            detail: sharedError ?? "load failed",
          })
          continue
        }
      }
      const limits = limitsFor(entry)
      const fixture = app.fixtures?.[entry.entry] ?? null
      const runOnce = async (): Promise<RunRecord> => {
        const replay = createReplayBridge(surfaceFor(app, entry), fixture)
        const outcome = await (isolate as ContractIsolate).run({
          exportName: entry.exportName,
          params: fixture?.params ?? {},
          ...(fixture?.extraArgs ? { extraArgs: fixture.extraArgs } : {}),
          bridge: replay.bridge,
          limits,
        })
        return { outcome, stats: replay.stats }
      }
      try {
        const first = await runOnce()
        // A run stopped by a limit may leave the isolate unusable: judge, then start a new one.
        const second = first.outcome.overrun ? null : await runOnce()
        const verdict = judge(entry, limits, first, second)
        if (
          verdict.reasons.length === 0 &&
          !fixture &&
          [first, second].every((r) => r !== null && rejected(r.outcome))
        ) {
          verdict.trivial = true
        }
        verdicts.push(verdict)
        if (first.outcome.overrun || second?.outcome.overrun) {
          if (own) own.dispose()
          else {
            ;(shared as ContractIsolate | null)?.dispose()
            shared = null
          }
          own = null
        }
      } finally {
        own?.dispose()
      }
    }
  } finally {
    ;(shared as ContractIsolate | null)?.dispose()
  }
  return verdicts
}

function judge(
  entry: ContractEntry,
  limits: RunLimits,
  first: RunRecord,
  second: RunRecord | null,
): EntryVerdict {
  const runs = second ? [first, second] : [first]
  const notFound = runs.find((r) =>
    r.outcome.error?.startsWith(`Export "${entry.exportName}" not found`),
  )
  if (notFound)
    return { entry: entry.entry, reasons: ["missing-export"], detail: notFound.outcome.error }
  const missing = runs.flatMap((r) => r.stats.missing)
  if (missing.length > 0) {
    return {
      entry: entry.entry,
      reasons: ["no-fixture"],
      detail: `unrecorded: ${[...new Set(missing)].join(", ")}`,
    }
  }
  const reasons: ContractReason[] = []
  const details: string[] = []
  if (second && answerOf(first.outcome) !== answerOf(second.outcome)) {
    reasons.push("module-state")
    details.push(
      `run 1 ${answerOf(first.outcome).slice(0, 200)} != run 2 ${answerOf(second.outcome).slice(0, 200)}`,
    )
  }
  const slept = Math.max(...runs.map((r) => r.outcome.sleepMs))
  if (slept > MAX_IN_RUN_WAIT_MS) {
    reasons.push("wait")
    details.push(`waited ${slept} ms in a run`)
  }
  const overrun = runs.find((r) => r.outcome.overrun)?.outcome.overrun
  const calls = Math.max(...runs.map((r) => r.stats.calls))
  // A wait past the wall clock is an overrun too: on a real clock the run is killed.
  if (overrun || slept > limits.wallMs || calls > limits.bridgeCalls) {
    reasons.push("budget")
    details.push(
      overrun
        ? `past its ${overrun} limit`
        : slept > limits.wallMs
          ? `waited past its ${limits.wallMs} ms wall clock`
          : `${calls} bridge calls > ${limits.bridgeCalls}`,
    )
  }
  return { entry: entry.entry, reasons, ...(details.length ? { detail: details.join("; ") } : {}) }
}

// -- Loading app code ------------------------------------------------------------

async function buildScript(entrypoint: string): Promise<string> {
  const built = await Bun.build({ entrypoints: [entrypoint], target: "bun", external: ["node:*"] })
  const out = built.outputs[0]
  if (!built.success || !out) {
    throw new Error(`build of ${entrypoint} failed: ${built.logs.map((l) => l.message).join("; ")}`)
  }
  return esmExportsToGlobalThis(await out.text())
}

/**
 * A bundled app's handler script, built from source the way the dev and test
 * side channel builds it (bundle-loader.ts), and its PDF templates.
 */
export async function bundledAppScripts(dir: string): Promise<{
  source: ContractSource
  templateSource: (rel: string) => Promise<ContractSource>
}> {
  return {
    source: { script: await buildScript(join(dir, "handlers.ts")) },
    templateSource: async (rel) => ({ script: await buildScript(join(dir, rel)) }),
  }
}

/** An in-tree app's handler script, loaded the way its runs load it. */
export async function inTreeAppScript(bundlePath: string): Promise<ContractSource> {
  return { script: await loadBundle(bundlePath) }
}
