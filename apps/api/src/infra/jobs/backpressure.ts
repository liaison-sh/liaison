// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Enqueue backpressure: refuse a job loudly before Redis runs out of memory.
//
// WHY. Redis runs `noeviction`: at `maxmemory` it refuses EVERY write, and the
// same Redis holds sessions, rate limits and the WebSocket and webhook replay
// buffers. A job storm (a large import fanned out through the event path)
// would therefore not just stall the queues, it would log everybody out. So an
// enqueue is refused, with `QueueBackpressureError`, when
//   - Redis memory is past the HARD ratio (every queue), or past the SOFT
//     ratio for queues that shed early (the kernel's bulk class), or
//   - the target queue's backlog (waiting + prioritized + delayed) is past
//     `JOB_QUEUE_MAX_DEPTH`.
// A refused enqueue surfaces where the work came from: an outbox consumer
// throws and the event stays in Postgres to be retried, an HTTP call fails
// visibly. Nothing is dropped silently.
//
// NO ROUND TRIP ON THE HOT PATH. The check reads a sample; a sample older than
// SAMPLE_TTL_MS triggers one background refresh (single flight: INFO memory
// plus four counters per queue in one pipeline) and the enqueue proceeds on the
// sample it has. A sample older than STALE_AFTER_MS (Redis unreachable) is
// ignored: then the enqueue itself fails, which is loud enough.
import type Redis from "ioredis"
import { env } from "~/lib/env"
import { jobsLogger as log } from "~/lib/logger"
import { KERNEL_QUEUE_CLASSES, kernelQueueClassOf } from "./queue-classes"
import { queueKey } from "./queue-health"

export type BackpressureReason = "redis-memory" | "queue-depth"

export class QueueBackpressureError extends Error {
  constructor(
    readonly queueName: string,
    readonly reason: BackpressureReason,
    detail: string,
  ) {
    super(`Queue ${queueName} refused a job (${reason}): ${detail}`)
    this.name = "QueueBackpressureError"
  }
}

export interface PressureSample {
  at: number
  usedMemory: number
  /** 0 when Redis has no `maxmemory` (local dev): memory is then never a reason. */
  maxMemory: number
  /** Backlog (waiting + prioritized + delayed) per queue sampled. */
  depths: Map<string, number>
}

const SAMPLE_TTL_MS = 5_000
const STALE_AFTER_MS = 60_000
const REFUSAL_LOG_EVERY_MS = 10_000

let sample: PressureSample | null = null
let refreshing: Promise<void> | null = null
let client: Redis | null = null
const sampledQueues = new Set<string>()
const lastRefusalLog = new Map<string, number>()
let refusals = 0

/** Bind the Redis client the sampler reads (the BullMQ connection). */
export function bindBackpressureClient(redis: Redis): void {
  client = redis
}

function parseInfo(info: string, field: string): number {
  const m = info.match(new RegExp(`^${field}:(\\d+)`, "m"))
  return m ? Number(m[1]) : 0
}

async function refresh(): Promise<void> {
  if (!client) return
  const queues = [...sampledQueues]
  const p = client.pipeline()
  p.info("memory")
  for (const q of queues) {
    p.llen(queueKey(q, "wait"))
    p.zcard(queueKey(q, "prioritized"))
    p.zcard(queueKey(q, "delayed"))
  }
  const res = (await p.exec()) ?? []
  const info = String(res[0]?.[1] ?? "")
  const depths = new Map<string, number>()
  queues.forEach((q, i) => {
    const base = 1 + i * 3
    let d = 0
    for (let k = 0; k < 3; k++) d += Number(res[base + k]?.[1] ?? 0)
    depths.set(q, d)
  })
  sample = {
    at: Date.now(),
    usedMemory: parseInfo(info, "used_memory"),
    maxMemory: parseInfo(info, "maxmemory"),
    depths,
  }
}

function refreshInBackground(): void {
  if (refreshing || !client) return
  refreshing = refresh()
    .catch((err) => log.warn({ err }, "Queue backpressure sample failed"))
    .finally(() => {
      refreshing = null
    })
}

function shedsAtSoftMemory(queueName: string): boolean {
  const cls = kernelQueueClassOf(queueName)
  return cls ? KERNEL_QUEUE_CLASSES[cls].shedAtSoftMemory : false
}

function refuse(queueName: string, reason: BackpressureReason, detail: string): never {
  refusals++
  const key = `${queueName}:${reason}`
  const last = lastRefusalLog.get(key) ?? 0
  if (Date.now() - last > REFUSAL_LOG_EVERY_MS) {
    lastRefusalLog.set(key, Date.now())
    log.error({ queue: queueName, reason, detail, refusals }, "Queue backpressure: enqueue refused")
  }
  throw new QueueBackpressureError(queueName, reason, detail)
}

/**
 * Throw `QueueBackpressureError` when the last sample says this enqueue would
 * push Redis or the queue past its bound. Synchronous and round-trip free.
 */
export function assertEnqueueAllowed(queueName: string, now: number = Date.now()): void {
  sampledQueues.add(queueName)
  if (!sample || now - sample.at > SAMPLE_TTL_MS) refreshInBackground()
  const s = sample
  if (!s || now - s.at > STALE_AFTER_MS) return

  if (s.maxMemory > 0) {
    const ratio = s.usedMemory / s.maxMemory
    const limit = shedsAtSoftMemory(queueName)
      ? env.JOB_REDIS_MEMORY_SOFT_RATIO
      : env.JOB_REDIS_MEMORY_HARD_RATIO
    if (ratio >= limit) {
      refuse(
        queueName,
        "redis-memory",
        `Redis at ${(ratio * 100).toFixed(1)}% of maxmemory (limit ${(limit * 100).toFixed(0)}%)`,
      )
    }
  }
  const depth = s.depths.get(queueName)
  if (depth !== undefined && depth >= env.JOB_QUEUE_MAX_DEPTH) {
    refuse(queueName, "queue-depth", `${depth} jobs queued (limit ${env.JOB_QUEUE_MAX_DEPTH})`)
  }
}

/** For /diag: the last sample and how many enqueues were refused since boot. */
export function getBackpressureState(): {
  redisMemoryRatio: number | null
  softRatio: number
  hardRatio: number
  maxDepth: number
  refusedSinceBoot: number
  sampledAt: string | null
} {
  return {
    redisMemoryRatio:
      sample && sample.maxMemory > 0
        ? Math.round((sample.usedMemory / sample.maxMemory) * 1000) / 1000
        : null,
    softRatio: env.JOB_REDIS_MEMORY_SOFT_RATIO,
    hardRatio: env.JOB_REDIS_MEMORY_HARD_RATIO,
    maxDepth: env.JOB_QUEUE_MAX_DEPTH,
    refusedSinceBoot: refusals,
    sampledAt: sample ? new Date(sample.at).toISOString() : null,
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const BackpressureTestAccess = {
  setSample(next: PressureSample | null): void {
    sample = next
  },
  refreshNow(): Promise<void> {
    return refresh()
  },
  reset(): void {
    sample = null
    refreshing = null
    sampledQueues.clear()
    lastRefusalLog.clear()
    refusals = 0
  },
}
