// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The durable origin of the agent turns a job runs (S10, M4).
 *
 * A job's turns are recorded with `origin_ref = job:<queue>:<job id>:<job
 * timestamp>:<n>`, n counting the turns this run of the job started. A
 * re-run of the same job (a stalled job BullMQ hands to another worker, a job
 * handed back at shutdown) has the same id and timestamp, so its n-th turn
 * meets the first run's n-th turn instead of starting a second one. A new job
 * that reuses an id (a Redis reset, a deterministic id enqueued again later)
 * has another timestamp, so it never matches an old turn.
 */
import { AsyncLocalStorage } from "node:async_hooks"

interface JobOrigin {
  ref: string | null
  turns: number
  fair?: JobFairFrame
}

/**
 * The fairness token the running job holds (fairness.ts), set by the worker
 * once the job is admitted. A job it enqueues for the same org and queue that
 * it then waits for (a sub-run) is minted as nested, so the wait cannot
 * deadlock on the org's cap. Server state only: no job data feeds it.
 */
export interface JobFairFrame {
  queue: string
  orgId: string
  jobId: string
  admitted: boolean
}

const store = new AsyncLocalStorage<JobOrigin>()

export function jobOriginRef(
  queueName: string,
  job: { id?: string | null; timestamp?: number },
): string | null {
  if (!job.id || job.timestamp === undefined) return null
  return `job:${queueName}:${job.id}:${job.timestamp}`
}

/** Run `fn` as the job `ref` (and, when admitted by the fairness gate, its token frame). */
export function runAsJob<T>(
  ref: string | null,
  fn: () => Promise<T>,
  fair?: JobFairFrame,
): Promise<T> {
  return ref || fair ? store.run({ ref, turns: 0, fair }, fn) : fn()
}

/** The fairness frame of the job running in this async context, if any. */
export function currentJobFairFrame(): JobFairFrame | undefined {
  return store.getStore()?.fair
}

/** The origin of the next turn the current job starts, or null outside a job. */
export function nextJobTurnOriginRef(): string | null {
  const origin = store.getStore()
  if (!origin?.ref) return null
  origin.turns++
  return `${origin.ref}:${origin.turns}`
}
