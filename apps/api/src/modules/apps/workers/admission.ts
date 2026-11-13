// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Admission for runs on the Workers executor. The isolate costs this server
// nothing while it runs, but its bridge does: every run holds a registry entry
// and its bridge calls, and a run whose bridge holds a database transaction
// (atomic tools, primary webhook delivery, ambient jobs and events) keeps a
// pool connection open across internet round trips for its whole duration.
//
//   top-level runs  at most PER_ORG in flight per org; the rest wait in one
//                   FIFO queue (bounded by the run's own timeout, and by its
//                   caller's abort signal)
//   lanes           a run is interactive (a person or an agent waits on it)
//                   or background (jobs, events, syncs; run-limits.ts
//                   runLaneOf). Background runs may hold at most
//                   BACKGROUND_PER_ORG of their org's slots (PER_ORG less an
//                   interactive reserve) and HOLDS_TX_BACKGROUND of the
//                   holdsTx slots, so a burst of an org's long jobs never
//                   starves its tool calls. Within a lane the queue is FIFO;
//                   an interactive run passes queued background runs.
//   holdsTx runs    at most HOLDS_TX_GLOBAL in flight across the process, the
//                   worker pool's background cap (maxSize - reserved
//                   interactive), so Workers never holds more transactions
//                   open than the pool could; top-level ones queue for it.
//                   Background ones hold at most that less the interactive
//                   reserve (APP_WORKER_POOL_RESERVED_INTERACTIVE).
//   nested runs     NEVER queue: the parent holds its own slot while it waits
//                   for the child, so a queued child can wait on its own
//                   parent (worker-pool.ts executeNested has the same rule).
//                   They take no per-org or holdsTx slot from the queue's
//                   point of view, are counted, and are bounded by a breadth
//                   per parent execution; past it they are refused at once.

import { sandboxCancelledError } from "~/lib/failure-severity"
import { rootLogger } from "~/lib/logger"
import type { RunLane } from "~/modules/apps/run-limits"

const log = rootLogger.child({ module: "apps-workers-admission" })

export const WORKERS_MAX_IN_FLIGHT_PER_ORG = 16
export const WORKERS_MAX_NESTED_BREADTH_PER_PARENT = 8
/** Of an org's in-flight slots, the ones background runs may not hold. */
export const WORKERS_INTERACTIVE_RESERVE_PER_ORG = 4

/** The worker pool's interactive reserve with its own defaults (worker-pool.ts). */
function poolReservedInteractive(maxSize: number): number {
  const reserved = Number(process.env.APP_WORKER_POOL_RESERVED_INTERACTIVE) || 1
  return Math.max(0, Math.min(reserved, maxSize - 1))
}

/** The worker pool's background cap with its own defaults (worker-pool.ts). */
export function poolBackgroundCap(): number {
  const maxSize = Number(process.env.APP_WORKER_POOL_MAX) || 8
  return Math.max(1, maxSize - poolReservedInteractive(maxSize))
}

/** Of the holdsTx slots, the ones background runs may hold: less the interactive reserve. */
export function holdsTxBackgroundCap(): number {
  const maxSize = Number(process.env.APP_WORKER_POOL_MAX) || 8
  return Math.max(1, poolBackgroundCap() - poolReservedInteractive(maxSize))
}

const UNKEYED_PARENT = "(unkeyed parent)"

export interface AdmissionLimits {
  perOrg: number
  /** Of perOrg, what background runs may hold (at most perOrg). */
  backgroundPerOrg: number
  nestedBreadthPerParent: number
  holdsTxGlobal: number
  /** Of holdsTxGlobal, what background runs may hold (at most holdsTxGlobal). */
  holdsTxBackground: number
}

export type LaneCounts = Record<RunLane, number>

export interface AdmissionRequest {
  orgId: string
  /** The run's lane (default interactive); a nested run's is its parent's business. */
  lane?: RunLane
  holdsTx: boolean
  nested: boolean
  nestedParentKey?: string
  /** How long a top-level run may wait in the queue. */
  waitMs: number
  signal?: AbortSignal
  appName?: string
}

interface Waiter {
  req: AdmissionRequest
  admit: () => void
}

export class WorkersAdmission {
  private limits: AdmissionLimits
  private readonly perOrg = new Map<string, number>()
  private readonly backgroundPerOrg = new Map<string, number>()
  private holdsTx = 0
  private holdsTxBackground = 0
  private readonly nestedByParent = new Map<string, number>()
  private readonly queue: Waiter[] = []
  /** Top-level runs that waited in the queue, and those that timed out there, per lane. */
  private readonly waited: LaneCounts = { interactive: 0, background: 0 }
  private readonly timedOut: LaneCounts = { interactive: 0, background: 0 }

  constructor(limits?: Partial<AdmissionLimits>) {
    this.limits = {
      perOrg: WORKERS_MAX_IN_FLIGHT_PER_ORG,
      backgroundPerOrg: WORKERS_MAX_IN_FLIGHT_PER_ORG - WORKERS_INTERACTIVE_RESERVE_PER_ORG,
      nestedBreadthPerParent: WORKERS_MAX_NESTED_BREADTH_PER_PARENT,
      holdsTxGlobal: poolBackgroundCap(),
      holdsTxBackground: holdsTxBackgroundCap(),
      ...limits,
    }
  }

  /** Tests: change the limits (queued runs are re-examined). */
  setLimits(limits: Partial<AdmissionLimits>): void {
    this.limits = { ...this.limits, ...limits }
    this.drain()
  }

  getLimits(): AdmissionLimits {
    return { ...this.limits }
  }

  /** In-flight counters (tests, diagnostics). */
  stats(): {
    orgs: Record<string, number>
    holdsTx: number
    queued: number
    nested: number
    lanes: {
      background: { orgs: Record<string, number>; holdsTx: number }
      queued: LaneCounts
      waited: LaneCounts
      timedOut: LaneCounts
    }
  } {
    let nested = 0
    for (const n of this.nestedByParent.values()) nested += n
    const queued: LaneCounts = { interactive: 0, background: 0 }
    for (const w of this.queue) queued[laneOf(w.req)]++
    return {
      orgs: Object.fromEntries(this.perOrg),
      holdsTx: this.holdsTx,
      queued: this.queue.length,
      nested,
      lanes: {
        background: {
          orgs: Object.fromEntries(this.backgroundPerOrg),
          holdsTx: this.holdsTxBackground,
        },
        queued,
        waited: { ...this.waited },
        timedOut: { ...this.timedOut },
      },
    }
  }

  /** Resolves with the release function once the run may start. */
  acquire(req: AdmissionRequest): Promise<() => void> {
    if (req.signal?.aborted) return Promise.reject(sandboxCancelledError())
    if (req.nested) {
      try {
        return Promise.resolve(this.admitNested(req))
      } catch (err) {
        return Promise.reject(err)
      }
    }
    // Never jump ahead of a queued run of the same lane competing for the
    // same slot (an interactive run may pass queued background ones).
    const lane = laneOf(req)
    const behind = this.queue.some(
      (w) =>
        laneOf(w.req) === lane && (w.req.orgId === req.orgId || (req.holdsTx && w.req.holdsTx)),
    )
    if (!behind && this.fits(req)) return Promise.resolve(this.take(req))
    this.waited[lane]++
    return new Promise<() => void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const leave = () => {
        const i = this.queue.indexOf(waiter)
        if (i !== -1) this.queue.splice(i, 1)
        if (timer) clearTimeout(timer)
        req.signal?.removeEventListener("abort", onAbort)
      }
      const onAbort = () => {
        leave()
        reject(sandboxCancelledError())
      }
      const waiter: Waiter = {
        req,
        admit: () => {
          leave()
          resolve(this.take(req))
        },
      }
      timer = setTimeout(
        () => {
          leave()
          this.timedOut[lane]++
          log.warn(
            { orgId: req.orgId, app: req.appName, lane, runHoldsTx: req.holdsTx, ...this.stats() },
            "Workers run timed out waiting for admission",
          )
          reject(new Error("Queued sandbox request timed out waiting for a free worker"))
          // A waiter that left may unblock the next one (FIFO head).
          this.drain()
        },
        Math.max(0, req.waitMs),
      )
      req.signal?.addEventListener("abort", onAbort, { once: true })
      this.queue.push(waiter)
    })
  }

  private fits(req: AdmissionRequest): boolean {
    if ((this.perOrg.get(req.orgId) ?? 0) >= this.limits.perOrg) return false
    if (req.holdsTx && this.holdsTx >= this.limits.holdsTxGlobal) return false
    if (laneOf(req) === "background") {
      if ((this.backgroundPerOrg.get(req.orgId) ?? 0) >= this.limits.backgroundPerOrg) return false
      if (req.holdsTx && this.holdsTxBackground >= this.limits.holdsTxBackground) return false
    }
    return true
  }

  private take(req: AdmissionRequest): () => void {
    const background = laneOf(req) === "background"
    bump(this.perOrg, req.orgId, 1)
    if (background) bump(this.backgroundPerOrg, req.orgId, 1)
    if (req.holdsTx) this.holdsTx++
    if (req.holdsTx && background) this.holdsTxBackground++
    let released = false
    return () => {
      if (released) return
      released = true
      bump(this.perOrg, req.orgId, -1)
      if (background) bump(this.backgroundPerOrg, req.orgId, -1)
      if (req.holdsTx) this.holdsTx--
      if (req.holdsTx && background) this.holdsTxBackground--
      this.drain()
    }
  }

  private admitNested(req: AdmissionRequest): () => void {
    const key = req.nestedParentKey ?? UNKEYED_PARENT
    const outstanding = this.nestedByParent.get(key) ?? 0
    if (outstanding >= this.limits.nestedBreadthPerParent) {
      log.error(
        { orgId: req.orgId, app: req.appName, parentKey: key, outstanding },
        "Nested Workers dispatch refused: per-parent breadth reached",
      )
      const err = new Error(
        `Sandbox reentrancy limit reached: nested tool call refused (per-parent breadth ${this.limits.nestedBreadthPerParent})`,
      )
      err.name = "SandboxReentrancyLimit"
      throw err
    }
    this.nestedByParent.set(key, outstanding + 1)
    // Counted (so top-level runs see the load) but never blocked by the caps.
    this.perOrg.set(req.orgId, (this.perOrg.get(req.orgId) ?? 0) + 1)
    if (req.holdsTx) this.holdsTx++
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (this.nestedByParent.get(key) ?? 1) - 1
      if (left > 0) this.nestedByParent.set(key, left)
      else this.nestedByParent.delete(key)
      const n = (this.perOrg.get(req.orgId) ?? 1) - 1
      if (n > 0) this.perOrg.set(req.orgId, n)
      else this.perOrg.delete(req.orgId)
      if (req.holdsTx) this.holdsTx--
      this.drain()
    }
  }

  /** Admit queued runs in order; a head that does not fit does not block others of other orgs. */
  private drain(): void {
    for (let i = 0; i < this.queue.length; ) {
      const w = this.queue[i] as Waiter
      if (this.fits(w.req)) {
        w.admit() // splices itself out
      } else {
        i++
      }
    }
  }
}

function laneOf(req: Pick<AdmissionRequest, "lane">): RunLane {
  return req.lane ?? "interactive"
}

/** Add `by` to a per-org count, dropping the key at zero. */
function bump(map: Map<string, number>, key: string, by: number): void {
  const n = (map.get(key) ?? 0) + by
  if (n > 0) map.set(key, n)
  else map.delete(key)
}

/** The process's admission (the Workers executor's). */
export const workersAdmission = new WorkersAdmission()
