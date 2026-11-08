// SPDX-License-Identifier: FSL-1.1-ALv2
//
// When a run meant for Workers runs on QuickJS instead. Every app has both
// builds (its QuickJS bundle.js beside its Worker module; a custom app's
// installed row keeps both), and the two keep one contract, so falling back
// changes where the code runs, never what it answers.
//
// Two scopes, by who is at fault (faults.ts):
//
//  - The loader breaker, per process, on loader-level faults only. Closed:
//    every run goes to Workers; 5 loader faults within 60 s open it. Open:
//    every app of every org runs on QuickJS (`fallback: "breaker"`) for 60 s.
//    Then half-open: exactly one run is let through as a probe (its lease
//    lasts 60 s, after which another run may probe); the probe answered by the
//    loader in any way (even an app or handler error) closes the breaker, a
//    probe that meets another loader fault opens it again.
//  - The app fallback, per `org:app@version`, on app-level faults: that org's
//    version of that app runs on QuickJS (`fallback: "app"`) for 10 minutes.
//    Another org, or another version, stays on Workers.
//
//  - The run itself, once: a run whose Workers attempts (the retry included,
//    or skipped for budget) ended on a loader-level fault before any bridge
//    call runs once more on QuickJS (`fallback: "loader_fault"`). Never after
//    a bridge call: what the app did may have happened.
//
// runApp (sandbox/run-app.ts) decides where a run goes (`planWorkersRun`),
// then builds the bridge for that executor (a Workers bridge is secret-free,
// a QuickJS one is not), then runs; a loader-fault fallback builds the
// QuickJS bridge before it runs again. The outcome is recorded in the run line.

import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "apps-workers-fallback" })

export const BREAKER_THRESHOLD = 5
export const BREAKER_WINDOW_MS = 60_000
export const BREAKER_OPEN_MS = 60_000
export const BREAKER_PROBE_LEASE_MS = 60_000
export const APP_FALLBACK_MS = 10 * 60_000

export type BreakerState = "closed" | "open" | "half-open"

/** Whether a run may go to the loader; `probe` when it is the half-open probe. */
export type BreakerAdmission = { allow: true; probe: boolean } | { allow: false }

export class LoaderBreaker {
  private faults: number[] = []
  private openUntil = 0
  private halfOpen = false
  private probeLeaseUntil = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly opts = {
      threshold: BREAKER_THRESHOLD,
      windowMs: BREAKER_WINDOW_MS,
      openMs: BREAKER_OPEN_MS,
      probeLeaseMs: BREAKER_PROBE_LEASE_MS,
    },
  ) {}

  state(): BreakerState {
    if (this.halfOpen) return "half-open"
    if (this.openUntil > 0) return this.now() < this.openUntil ? "open" : "half-open"
    return "closed"
  }

  /** Asked once per run, before its bridge is built. */
  admit(): BreakerAdmission {
    const now = this.now()
    if (!this.halfOpen && this.openUntil === 0) return { allow: true, probe: false }
    if (!this.halfOpen) {
      if (now < this.openUntil) return { allow: false }
      this.halfOpen = true
      this.openUntil = 0
    }
    if (now < this.probeLeaseUntil) return { allow: false }
    this.probeLeaseUntil = now + this.opts.probeLeaseMs
    return { allow: true, probe: true }
  }

  /** One attempt's outcome: a loader-level fault, or any answer from the loader. */
  record(outcome: "loader_fault" | "answered", probe = false): void {
    const now = this.now()
    if (probe) {
      this.probeLeaseUntil = 0
      if (outcome === "answered") {
        this.close()
      } else {
        this.open(now, "the half-open probe met another loader fault")
      }
      return
    }
    if (outcome !== "loader_fault" || this.state() !== "closed") return
    this.faults.push(now)
    const since = now - this.opts.windowMs
    while (this.faults.length > 0 && (this.faults[0] as number) <= since) this.faults.shift()
    if (this.faults.length >= this.opts.threshold) {
      this.open(now, `${this.faults.length} loader faults within ${this.opts.windowMs / 1000} s`)
    }
  }

  private open(now: number, why: string): void {
    this.faults = []
    this.halfOpen = false
    this.openUntil = now + this.opts.openMs
    log.warn(
      { openMs: this.opts.openMs, why },
      "App loader breaker opened: every app runs on QuickJS until a probe succeeds",
    )
  }

  private close(): void {
    const wasOpen = this.halfOpen || this.openUntil > 0
    this.faults = []
    this.halfOpen = false
    this.openUntil = 0
    if (wasOpen) log.info("App loader breaker closed: apps run on Workers again")
  }
}

export class AppFallbacks {
  private readonly until = new Map<string, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = APP_FALLBACK_MS,
  ) {}

  static key(orgId: string, app: string, version: string): string {
    return `${orgId}:${app}@${version}`
  }

  active(key: string): boolean {
    const until = this.until.get(key)
    if (until === undefined) return false
    if (this.now() < until) return true
    this.until.delete(key)
    return false
  }

  mark(key: string, kind: string): void {
    const fresh = !this.active(key)
    this.until.set(key, this.now() + this.ttlMs)
    if (fresh) {
      log.warn(
        { key, kind, fallbackMs: this.ttlMs },
        "App-level Workers fault: this org's app version runs on QuickJS for a while",
      )
    }
  }
}

/** This process's breaker and app fallbacks. */
export const loaderBreaker = new LoaderBreaker()
export const appFallbacks = new AppFallbacks()

/** Test seam: fresh process-wide state between tests. */
export const WorkersFallbackTestAccess = {
  /** Fresh breaker and app fallbacks, on `now` (default: the real clock). */
  reset(now: () => number = Date.now): void {
    Object.assign(loaderBreaker, new LoaderBreaker(now))
    Object.assign(appFallbacks, new AppFallbacks(now))
  },
}
