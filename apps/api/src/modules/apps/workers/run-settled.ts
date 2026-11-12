// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One event per app run through runApp (sandbox/run-app.ts), whatever its
// executor and outcome, raised once the run has settled (its result or error
// is final, its bridge closed). Modules that account for runs subscribe here
// instead of editing runApp: the run timing records (timings.ts) are one
// subscriber, per-org usage another.
//
// Subscribers run synchronously, in subscription order, inside runApp's
// `finally`: they must be cheap and never throw (a throw is caught, logged
// once per subscriber and ignored). Anything slow (a database write) is the
// subscriber's to batch or defer.

import { rootLogger } from "~/lib/logger"
import type { LoaderTimings } from "./timings"

const log = rootLogger.child({ module: "app-run-settled" })

/**
 * Why a run that would have gone to Workers ran on the fallback target instead
 * (the instance's own sandbox service when configured, else QuickJS): the
 * breaker was open, this org's app@version is under an app fallback, or this
 * run's Workers attempts met a loader-level fault before any bridge call
 * (`loader_fault`: the run then ran once more, on the fallback target).
 */
export type WorkersFallback = "breaker" | "app" | "loader_fault"

/** How a failed Workers attempt is classified (workers/faults.ts). */
export type WorkersFaultClass = "loader" | "app" | "final"

export interface RunSettledInfo {
  /** The Workers run id of the last attempt (Workers only). */
  runId?: string
  app: string
  orgId: string
  /** `<kind>:<name>`: tool:<tool>, webhook:<export>, job:<job>, event:<export>, ... */
  entry: string
  /**
   * `workerd`: this instance's own sandbox service, the target of a fallback
   * when one is configured (workers/config.ts readFallbackTarget).
   */
  executor: "workers" | "workerd" | "quickjs" | "inprocess"
  nested: boolean
  /** The app of the run this one is nested in, when known. */
  parentApp?: string
  /** Wall time of the whole run as runApp saw it (admission, retries and loader included). */
  ms: number
  ok: boolean
  /** Start time (epoch ms). */
  at: number
  /** Bridge calls the run made, as the cell counted them (Workers only). */
  bridgeCalls?: number
  /** The loader's own timings of the last attempt (Workers only). */
  loader?: LoaderTimings
  sleepMs?: number
  sleepExact?: boolean
  /** Set when the run was meant for Workers and ran on QuickJS. */
  fallback?: WorkersFallback
  /** Workers attempts made (2 when the run was retried). */
  attempts?: number
  /** The loader's error kind of the failing attempt, or "network" / "http_<status>". */
  errorKind?: string
  faultClass?: WorkersFaultClass
}

export type RunSettledListener = (info: RunSettledInfo) => void

const listeners = new Set<RunSettledListener>()
const failedOnce = new WeakSet<RunSettledListener>()

/** Subscribe; returns the unsubscribe function. */
export function onRunSettled(listener: RunSettledListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Raised by runApp once per run. Never throws. */
export function emitRunSettled(info: RunSettledInfo): void {
  for (const listener of listeners) {
    try {
      listener(info)
    } catch (err) {
      if (failedOnce.has(listener)) continue
      failedOnce.add(listener)
      log.error(
        { err, app: info.app },
        "A run-settled subscriber threw; its later throws are not logged",
      )
    }
  }
}
