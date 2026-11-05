// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * In-memory DB-pool pressure counters, surfaced at GET /diag (monitor/index.ts)
 * so the watchdog can alert on saturation BEFORE it becomes a total wedge --
 * the U4.16 sandbox-wedge finding: staging's app-tickets tools/jobs all
 * timed out at executeInSandbox because the main RLS pool was silently
 * exhausted (each sandbox timeout could leak a connection stuck behind a
 * still-running query); the ONLY visible signal was `docker compose restart
 * app` clearing it. There was no leading indicator. This module is that
 * indicator.
 *
 * Deliberately dependency-free and process-local (same tradeoff as
 * lib/error-tracker.ts): a counter, not a ledger. Multi-instance deployments
 * would need a shared store to aggregate across processes -- out of scope
 * here (staging/current deployment shape is single-process).
 *
 * Per pool (the five of db/pool-plan.ts): its planned max, the slots held now
 * and at most since start, the transactions waiting for a slot and the acquire
 * timeouts. Counted where withRlsContext and the privileged helpers open their
 * transactions; the main pool's direct users (outbox, health probes) are not
 * counted, so it shows its max only. Unsplit logins, request is the main pool
 * and privileged-jobs the jobs pool: their gauges count the same pools.
 */
import type { PoolName } from "~/db/pool-plan"
import { poolPlan } from "~/db/process-pool-plan"

let inFlight = 0
let acquireTimeouts = 0
let lastAcquireTimeoutAtMs: number | null = null
let statementTimeouts = 0
let lastStatementTimeoutAtMs: number | null = null
let nestedPrivileged = 0

export interface PoolDiagState {
  /** RLS transactions currently open (acquired or waiting to acquire). */
  inFlight: number
  /** Total DbAcquireTimeoutError rejections since process start (pool was full). */
  acquireTimeouts: number
  lastAcquireTimeoutAgoMs: number | null
  /** Total queries killed server-side by statement_timeout since process start. */
  statementTimeouts: number
  lastStatementTimeoutAgoMs: number | null
}

/** Call when a withRlsContext transaction begins (before the acquire race). */
export function recordRlsTxStart(): void {
  inFlight++
}

/** Call when a withRlsContext transaction settles, however it settles. */
export function recordRlsTxEnd(): void {
  inFlight = Math.max(0, inFlight - 1)
}

export function recordAcquireTimeout(now: number = Date.now()): void {
  acquireTimeouts++
  lastAcquireTimeoutAtMs = now
}

export function recordStatementTimeout(now: number = Date.now()): void {
  statementTimeouts++
  lastStatementTimeoutAtMs = now
}

/**
 * Call when a privileged-pool acquisition starts while the same async context
 * already holds a privileged slot (db/privileged.ts): one caller holding two
 * slots is the shape that deadlocks a full pool.
 */
export function recordNestedPrivileged(): void {
  nestedPrivileged++
}

/** Nested privileged acquisitions since process start. */
export function nestedPrivilegedAcquisitions(): number {
  return nestedPrivileged
}

interface Gauge {
  held: number
  peak: number
  waiting: number
  acquireTimeouts: number
  /** Transactions that got a slot since the process started. */
  transactions: number
}

const newGauge = (): Gauge => ({
  held: 0,
  peak: 0,
  waiting: 0,
  acquireTimeouts: 0,
  transactions: 0,
})

const gauges: Record<PoolName, Gauge> = {
  main: newGauge(),
  request: newGauge(),
  privileged: newGauge(),
  jobs: newGauge(),
  privilegedJobs: newGauge(),
}

/** One pool's gauge on /diag. */
export interface PoolGauge extends Gauge {
  max: number
}

/** One transaction's slot on a pool: waiting until acquired, held until released. */
export interface PoolSlot {
  /** The transaction callback started: the slot is held. */
  acquired(): void
  /** The transaction callback finished. */
  released(): void
  /** The transaction settled, however; a slot never acquired stops waiting. */
  settled(): void
}

/** Count a transaction on `pool`, waiting from now. */
export function poolSlot(pool: PoolName): PoolSlot {
  const g = gauges[pool]
  g.waiting++
  let state: "waiting" | "held" | "done" = "waiting"
  return {
    acquired() {
      if (state !== "waiting") return
      state = "held"
      g.waiting = Math.max(0, g.waiting - 1)
      g.held++
      g.transactions++
      g.peak = Math.max(g.peak, g.held)
    },
    released() {
      if (state !== "held") return
      state = "done"
      g.held = Math.max(0, g.held - 1)
    },
    settled() {
      if (state !== "waiting") return
      state = "done"
      g.waiting = Math.max(0, g.waiting - 1)
    },
  }
}

/** Call when a transaction on `pool` failed to acquire a slot in time. */
export function recordPoolAcquireTimeout(pool: PoolName): void {
  gauges[pool].acquireTimeouts++
}

/** Every pool's gauge, with its planned max. */
export function getPoolGauges(): Record<PoolName, PoolGauge> {
  const out = {} as Record<PoolName, PoolGauge>
  for (const name of Object.keys(gauges) as PoolName[]) {
    out[name] = { max: poolPlan.pools[name], ...gauges[name] }
  }
  return out
}

export function getPoolDiagState(now: number = Date.now()): PoolDiagState {
  return {
    inFlight,
    acquireTimeouts,
    lastAcquireTimeoutAgoMs: lastAcquireTimeoutAtMs === null ? null : now - lastAcquireTimeoutAtMs,
    statementTimeouts,
    lastStatementTimeoutAgoMs:
      lastStatementTimeoutAtMs === null ? null : now - lastStatementTimeoutAtMs,
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const PoolDiagTestAccess = {
  /**
   * Test-only reset seam, guarded by NODE_ENV per house rules (no raw test*()
   * methods left live in production).
   */
  reset(): void {
    if (process.env.NODE_ENV === "production") {
      throw new Error("PoolDiagTestAccess.reset must never be called in production")
    }
    inFlight = 0
    acquireTimeouts = 0
    lastAcquireTimeoutAtMs = null
    statementTimeouts = 0
    lastStatementTimeoutAtMs = null
    nestedPrivileged = 0
    for (const g of Object.values(gauges)) Object.assign(g, newGauge())
  },
  /** Start counting `pool`'s peak from the slots it holds now. */
  resetPeak(pool: PoolName): void {
    if (process.env.NODE_ENV === "production") {
      throw new Error("PoolDiagTestAccess.resetPeak must never be called in production")
    }
    gauges[pool].peak = gauges[pool].held
  },
}
