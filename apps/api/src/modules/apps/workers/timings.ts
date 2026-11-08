// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Measurement records, kept in a ring buffer for diagnostics and tests, and
// appended as one JSON line each to LIAISON_APP_BRIDGE_TIMINGS_FILE when that
// is set (measurement runs):
//
//   kind "call"  one /api/app-bridge call that reached a run (bridge-route.ts)
//   kind "run"   one app run through runApp of an app listed in
//                LIAISON_WORKERS_APPS, on whichever executor ran it (run-app.ts):
//                {kind, runId?, app, entry, executor, nested, parentApp?, ms, at,
//                 ok, loader?, sleepMs?, sleepExact?, fallback?, attempts?, errorKind?,
//                 faultClass?}
//                `loader` is the loader's own timings (Workers only); `sleepMs`
//                the time the app's code waited in its own timers inside the
//                isolate (worker-core.ts; Workers only, QuickJS has no timers).
//                `fallback` ("breaker" | "app" | "loader_fault") marks a run meant for Workers that ran
//                on QuickJS (workers/fallback.ts); `attempts` is 2 when it was retried.
//
// The run records are one subscriber of runApp's run-settled event
// (run-settled.ts).

import { appendFile } from "node:fs/promises"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { isCustomAppName } from "~/modules/apps/custom-app-name"
import {
  onRunSettled,
  type RunSettledInfo,
  type WorkersFallback,
  type WorkersFaultClass,
} from "./run-settled"

const log = rootLogger.child({ module: "app-bridge-timings" })

export interface BridgeTiming {
  kind: "call"
  runId: string
  app: string
  executor: "workers"
  method: string
  /** Wall time of the bridge call itself, in ms. */
  ms: number
  /** HTTP status the route answered. */
  status: number
  /** False when the bridge method threw (still answered 200 with an error body). */
  ok: boolean
  at: number
}

/** The loader's timings of one run, as its /run answer carries them. */
export interface LoaderTimings {
  loadMs?: number
  runMs?: number
  bridgeCalls?: number
  bridgeMsTotal?: number
  cold?: boolean
  workerRunMs?: number
}

export interface RunTiming {
  kind: "run"
  runId?: string
  app: string
  /** `<kind>:<name>`: tool:<tool>, webhook:<export>, job:<job>, event:<export>, ... */
  entry: string
  executor: "workers" | "quickjs" | "inprocess"
  nested: boolean
  parentApp?: string
  /** Wall time of the whole run as runApp saw it (admission and loader included). */
  ms: number
  ok: boolean
  at: number
  loader?: LoaderTimings
  sleepMs?: number
  /** False when another run shared the isolate's timers meanwhile (sleepMs is then an upper bound). */
  sleepExact?: boolean
  fallback?: WorkersFallback
  attempts?: number
  errorKind?: string
  faultClass?: WorkersFaultClass
}

export type TimingRecord = BridgeTiming | RunTiming

const RING_SIZE = 1000
const ring: BridgeTiming[] = []
const runRing: RunTiming[] = []
let fileFailed = false

export function recordBridgeTiming(t: BridgeTiming): void {
  ring.push(t)
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE)
  appendLine(t)
}

export function recordRunTiming(t: RunTiming): void {
  runRing.push(t)
  if (runRing.length > RING_SIZE) runRing.splice(0, runRing.length - RING_SIZE)
  appendLine(t)
}

function appendLine(t: TimingRecord): void {
  const file = env.LIAISON_APP_BRIDGE_TIMINGS_FILE
  if (!file) return
  appendFile(file, `${JSON.stringify(t)}\n`).catch((err: unknown) => {
    if (fileFailed) return
    fileFailed = true
    log.error({ err, file }, "Cannot append bridge timings; further failures are not logged")
  })
}

/** The most recent records, oldest first. */
export function recentBridgeTimings(): readonly BridgeTiming[] {
  return ring.slice()
}

/** The most recent run records, oldest first. */
export function recentRunTimings(): readonly RunTiming[] {
  return runRing.slice()
}

export function clearBridgeTimings(): void {
  ring.length = 0
  runRing.length = 0
}

/**
 * Whether an app's runs write a timing record: listed in LIAISON_WORKERS_APPS
 * (whatever else is set), or a custom app while LIAISON_WORKERS_CUSTOM_APPS is on.
 */
export function isTimedApp(appName: string): boolean {
  if (timedApps().has(appName)) return true
  const flag = (env.LIAISON_WORKERS_CUSTOM_APPS ?? "").trim().toLowerCase()
  return (flag === "1" || flag === "true") && isCustomAppName(appName)
}

/** The apps LIAISON_WORKERS_APPS lists. */
function timedApps(): ReadonlySet<string> {
  const raw = env.LIAISON_WORKERS_APPS ?? ""
  if (raw === timedAppsRaw) return timedAppsSet
  timedAppsRaw = raw
  timedAppsSet = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  return timedAppsSet
}
let timedAppsRaw = ""
let timedAppsSet: ReadonlySet<string> = new Set()

/** A settled run -> its run record. */
export function runTimingOf(info: RunSettledInfo): RunTiming {
  return {
    kind: "run",
    ...(info.runId ? { runId: info.runId } : {}),
    app: info.app,
    entry: info.entry,
    executor: info.executor,
    nested: info.nested,
    ...(info.parentApp ? { parentApp: info.parentApp } : {}),
    ms: info.ms,
    ok: info.ok,
    at: info.at,
    ...(info.loader ? { loader: info.loader } : {}),
    ...(info.sleepMs !== undefined ? { sleepMs: info.sleepMs } : {}),
    ...(info.sleepExact !== undefined ? { sleepExact: info.sleepExact } : {}),
    ...(info.fallback ? { fallback: info.fallback } : {}),
    ...(info.attempts !== undefined && info.attempts > 1 ? { attempts: info.attempts } : {}),
    ...(info.errorKind ? { errorKind: info.errorKind } : {}),
    ...(info.faultClass ? { faultClass: info.faultClass } : {}),
  }
}

onRunSettled((info) => {
  if (isTimedApp(info.app)) recordRunTiming(runTimingOf(info))
})
