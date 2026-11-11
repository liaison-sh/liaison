// SPDX-License-Identifier: FSL-1.1-ALv2
// An in-memory host for `createStepsCore` (bridge/steps.ts): versioned state
// documents, a recorded queue, a settable clock. Tests drive runs of one job
// through it the way the job worker would.
import {
  createStepsCore,
  type StepJob,
  type StepMarker,
  type StepState,
} from "~/modules/apps/sandbox/bridge/steps"

export interface QueuedJob {
  payload: Record<string, unknown>
  delayMs: number
  jobId?: string
}

export class MemoryStepsHost {
  now = 1_000_000
  readonly docs = new Map<string, { state: StepState; version: number }>()
  readonly queue: QueuedJob[] = []
  /** Enqueues dropped as duplicates of a pending id (BullMQ deduplication). */
  deduped = 0
  private ids = 0
  /** Make the next `write` of this step lose its compare-and-set. */
  failNextWrite = new Set<string>()
  /** Make every enqueue throw (a queue that refuses). */
  enqueueFails = false

  constructor(
    readonly jobName = "sync",
    readonly timeoutMs = 60_000,
  ) {}

  core(payload: Record<string, unknown> = {}, opts: { atomic?: boolean; noJob?: boolean } = {}) {
    const job: StepJob | undefined = opts.noJob
      ? undefined
      : { name: this.jobName, payload, timeoutMs: this.timeoutMs, atomic: opts.atomic ?? false }
    return createStepsCore({
      job,
      canCommitNow: true,
      read: async (name) => {
        const d = this.docs.get(name)
        return d ? { state: structuredClone(d.state), version: d.version } : null
      },
      write: async (name, state, ifVersion) => {
        if (this.failNextWrite.delete(name)) return false
        const cur = this.docs.get(name)
        if ((cur?.version ?? 0) !== ifVersion) return false
        this.docs.set(name, { state: structuredClone(state), version: ifVersion + 1 })
        return true
      },
      enqueueSelf: async (markers: Record<string, StepMarker>, o) => {
        if (this.enqueueFails) throw new Error("queue refused")
        if (o.jobId && this.queue.some((q) => q.jobId === o.jobId)) {
          this.deduped++
          return
        }
        this.queue.push({
          payload: { ...payload, _steps: markers },
          delayMs: o.delayMs,
          ...(o.jobId ? { jobId: o.jobId } : {}),
        })
      },
      now: () => this.now,
      newId: () => `id${++this.ids}`,
    })
  }

  /** The next queued job (FIFO), removed from the queue. */
  take(): QueuedJob {
    const next = this.queue.shift()
    if (!next) throw new Error("the queue is empty")
    return next
  }

  /** Bridge methods (`_steps_begin`, `_steps_save`) as the shims call them: JSON in, JSON out. */
  bridge(payload: Record<string, unknown> = {}): Record<string, (...a: any[]) => Promise<string>> {
    const core = this.core(payload)
    return {
      _steps_begin: async (name: string, opts: unknown) =>
        JSON.stringify(await core.begin(name, opts)),
      _steps_save: async (name: string, token: string, input: unknown) =>
        JSON.stringify(await core.save(name, token, input)),
    }
  }
}
