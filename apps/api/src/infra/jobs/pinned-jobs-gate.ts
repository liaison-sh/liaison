// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * PINNED-JOB ADMISSION. Some background work holds one jobs-pool connection
 * for its whole run, sandboxed network I/O included: ambient (`atomic: true`)
 * app jobs, app event-subscription handlers, webhook retries and the import
 * runner's batch transactions. Nothing else bounds how many of them start at
 * once, and past the jobs pool's size the rest failed after
 * DB_ACQUIRE_TIMEOUT_MS on the acquire. They now wait here, first come first
 * served, BEFORE their transaction opens: at most `pinnedJobSlots` (planned
 * from the jobs pool, db/pool-plan.ts) run at once, and the pool keeps
 * JOBS_SESSION_RESERVE connections for session-mode jobs (one short
 * transaction per call), which never take a slot here.
 *
 * The wait has no timeout (a job's BullMQ lock keeps renewing while it
 * waits); a job's abort signal (the shutdown drain) ends it, and the job goes
 * back on its queue as on any shutdown; an event handler's wait ends when the
 * event bus gives up on the handler. Once admitted, the acquire timeout
 * still applies. Re-entrant: work that already holds a slot runs at once, but
 * only while that slot is held: work it started without awaiting (and that
 * outlives it) goes through admission like any other.
 * /diag and the boot's pool_plan line show the gate (`pinnedJobs`).
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { poolPlan } from "~/db/process-pool-plan"
import { jobsLogger } from "~/lib/logger"

const log = jobsLogger.child({ module: "pinned-jobs-gate" })

/** A waiter older than this logs `pinned_jobs_backlog`. */
export const PINNED_JOBS_BACKLOG_MS = 60_000

export interface PinnedJobsState {
  max: number
  held: number
  peak: number
  waiting: number
  /** The longest wait for admission since start, in ms. */
  maxWaitMs: number
}

interface Waiter {
  admit: () => void
  label: string
}

export class PinnedJobsGate {
  private held = 0
  private peak = 0
  private maxWaitMs = 0
  private readonly queue: Waiter[] = []
  /** The slot the current async context runs in; `live` turns false when it is released. */
  private readonly inside = new AsyncLocalStorage<{ live: boolean }>()

  constructor(
    readonly max: number,
    private readonly backlogMs: number = PINNED_JOBS_BACKLOG_MS,
  ) {}

  /** Runs `fn` once a slot is free (FIFO), holding it until `fn` settles. */
  async run<T>(label: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.inside.getStore()?.live) return fn()
    await this.acquire(label, signal)
    const slot = { live: true }
    try {
      return await this.inside.run(slot, fn)
    } finally {
      slot.live = false
      this.release()
    }
  }

  state(): PinnedJobsState {
    return {
      max: this.max,
      held: this.held,
      peak: this.peak,
      waiting: this.queue.length,
      maxWaitMs: Math.round(this.maxWaitMs),
    }
  }

  private take(waitedMs: number): void {
    this.held++
    this.peak = Math.max(this.peak, this.held)
    this.maxWaitMs = Math.max(this.maxWaitMs, waitedMs)
  }

  private acquire(label: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.held < this.max && this.queue.length === 0) {
      this.take(0)
      return Promise.resolve()
    }
    const askedAt = performance.now()
    return new Promise<void>((resolve, reject) => {
      const backlog = setTimeout(() => {
        log.warn(
          { alert: "pinned_jobs_backlog", label, waitedMs: this.backlogMs, ...this.state() },
          "a job holding a jobs connection for its whole run has waited over a minute for admission",
        )
      }, this.backlogMs)
      backlog.unref?.()
      const onAbort = () => {
        const i = this.queue.indexOf(waiter)
        if (i >= 0) this.queue.splice(i, 1)
        clearTimeout(backlog)
        reject(signal?.reason ?? new Error("pinned-job wait aborted"))
      }
      const waiter: Waiter = {
        label,
        admit: () => {
          clearTimeout(backlog)
          signal?.removeEventListener("abort", onAbort)
          this.take(performance.now() - askedAt)
          resolve()
        },
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.queue.push(waiter)
    })
  }

  private release(): void {
    this.held = Math.max(0, this.held - 1)
    const next = this.queue.shift()
    next?.admit()
  }
}

/** This process's gate, sized by its pool plan. */
export const pinnedJobsGate = new PinnedJobsGate(poolPlan.pinnedJobSlots)

/** Runs whole-run jobs-pool work behind this process's gate. */
export function withPinnedJobSlot<T>(
  label: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return pinnedJobsGate.run(label, fn, signal)
}
