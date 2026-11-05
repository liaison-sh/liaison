// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Backlog and queue age per BullMQ queue, for /diag and for enqueue
// backpressure.
//
// THE NUMBER THAT MATTERS IS AGE, NOT DEPTH. Six thousand cheap jobs can drain
// in a minute; one cron waiting two minutes is already a missed sweep. So each
// queue reports the age of its OLDEST RUNNABLE job, measured from the moment
// it became runnable (`timestamp + delay`, which also covers a scheduler tick
// minted long before its fire time), and a queue is `stale` when that age is
// over its class's threshold. The watchdog alerts on `stale`.
//
// HOW IT STAYS CHEAP. Two pipelined round trips per call, whatever the
// backlog: counts plus the oldest candidates, then their timestamps. The wait
// list is FIFO with the oldest job at its tail (BullMQ RPOPLPUSHes from the
// right). The prioritized set is scored `priority * 2^32 + counter`, so the
// oldest job of one priority is the first member of that priority's score
// band; the priorities in use are few and known (queue-classes.ts), so one
// ZRANGEBYSCORE per band finds the oldest of each.
import type Redis from "ioredis"
import { bullPrefix } from "~/lib/redis"
import {
  isKernelQueueName,
  KERNEL_JOBS,
  KERNEL_QUEUE_CLASSES,
  kernelQueueClassOf,
  LEGACY_KERNEL_QUEUE,
} from "./queue-classes"

/** Alert threshold for queues outside the kernel classes (app queues, the legacy drain). */
export const DEFAULT_ALERT_AFTER_SEC = 600

export interface QueueHealth {
  queue: string
  waiting: number
  prioritized: number
  delayed: number
  active: number
  /** Age in seconds of the oldest job that could run now, or null when none waits. */
  oldestWaitingAgeSec: number | null
  alertAfterSec: number
  stale: boolean
}

export function queueKey(queueName: string, suffix: string): string {
  return `${bullPrefix}:${queueName}:${suffix}`
}

export function alertAfterSecFor(queueName: string): number {
  const cls = kernelQueueClassOf(queueName)
  return cls ? KERNEL_QUEUE_CLASSES[cls].alertAfterSec : DEFAULT_ALERT_AFTER_SEC
}

/** The priority bands a queue can hold: the kernel table's, or none for an app queue. */
function priorityBands(queueName: string): number[] {
  const cls = kernelQueueClassOf(queueName)
  if (!cls && queueName !== LEGACY_KERNEL_QUEUE) return []
  const bands = new Set<number>()
  for (const spec of Object.values(KERNEL_JOBS)) {
    if (spec.priority && (queueName === LEGACY_KERNEL_QUEUE || spec.queueClass === cls)) {
      bands.add(spec.priority)
    }
  }
  return [...bands]
}

const BAND = 0x100000000

/**
 * Backlog and oldest-runnable age for each queue, in two round trips. A queue
 * that does not exist reads as all zeros.
 */
export async function readQueueHealth(
  client: Redis,
  queueNames: readonly string[],
  now: number = Date.now(),
): Promise<QueueHealth[]> {
  const first = client.pipeline()
  const bands = new Map<string, number[]>()
  for (const q of queueNames) {
    first.llen(queueKey(q, "wait"))
    first.zcard(queueKey(q, "prioritized"))
    first.zcard(queueKey(q, "delayed"))
    first.llen(queueKey(q, "active"))
    first.lindex(queueKey(q, "wait"), -1)
    const b = priorityBands(q)
    bands.set(q, b)
    for (const p of b) {
      first.zrangebyscore(queueKey(q, "prioritized"), p * BAND, (p + 1) * BAND - 1, "LIMIT", 0, 1)
    }
  }
  const res = ((await first.exec()) ?? []).map(([err, v]) => (err ? null : v))

  let i = 0
  const partial: Array<{ q: string; counts: number[]; candidates: string[] }> = []
  for (const q of queueNames) {
    const counts = res.slice(i, i + 4).map((v) => Number(v ?? 0))
    const candidates: string[] = []
    const tail = res[i + 4]
    if (typeof tail === "string" && !tail.startsWith("0:")) candidates.push(tail)
    i += 5
    for (const _ of bands.get(q) ?? []) {
      const ids = res[i++]
      if (Array.isArray(ids) && typeof ids[0] === "string") candidates.push(ids[0])
    }
    partial.push({ q, counts, candidates })
  }

  const second = client.pipeline()
  for (const { q, candidates } of partial) {
    for (const id of candidates) second.hmget(queueKey(q, id), "timestamp", "delay")
  }
  const times = ((await second.exec()) ?? []).map(([err, v]) => (err ? null : v))

  let t = 0
  return partial.map(({ q, counts, candidates }) => {
    let oldest: number | null = null
    for (const _ of candidates) {
      const pair = times[t++] as [string | null, string | null] | null
      const ts = Number(pair?.[0])
      if (!Number.isFinite(ts) || ts <= 0) continue
      const runnableAt = ts + (Number(pair?.[1]) || 0)
      const age = Math.max(0, Math.floor((now - runnableAt) / 1000))
      oldest = oldest === null ? age : Math.max(oldest, age)
    }
    const alertAfterSec = alertAfterSecFor(q)
    return {
      queue: q,
      waiting: counts[0] ?? 0,
      prioritized: counts[1] ?? 0,
      delayed: counts[2] ?? 0,
      active: counts[3] ?? 0,
      oldestWaitingAgeSec: oldest,
      alertAfterSec,
      stale: oldest !== null && oldest > alertAfterSec,
    }
  })
}

/** The queues /diag always reports: every kernel class, the legacy drain, then the rest seen. */
export function diagQueueNames(knownQueues: Iterable<string>): string[] {
  const names = new Set<string>([
    ...Object.values(KERNEL_QUEUE_CLASSES).map((c) => c.queueName),
    LEGACY_KERNEL_QUEUE,
  ])
  for (const q of knownQueues) names.add(q)
  return [...names].sort((a, b) => {
    const ka = isKernelQueueName(a) ? 0 : 1
    const kb = isKernelQueueName(b) ? 0 : 1
    return ka - kb || a.localeCompare(b)
  })
}
