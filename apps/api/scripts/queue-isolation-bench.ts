// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Queue isolation + enqueue latency bench (design audit 2026-09-30, finding 1).
 *
 * Two numbers, both against a real Redis:
 *   1. How long a kernel cron job waits when BULK_JOBS bulk kernel jobs are
 *      already queued (each bulk job holds its slot BULK_JOB_MS). Before the
 *      queue classes, both shared one FIFO `app-kernel` queue, so the cron job
 *      waited for the whole backlog.
 *   2. The latency of `enqueueAppJob` with a jobId (the dedup path), sequential.
 *
 * SAFE BY CONSTRUCTION. It refuses to run unless NODE_ENV=test and REDIS_URL
 * names a database index other than 0, it writes every key under a prefix
 * unique to the run (REDIS_PREFIX=w1bench-<uuid>:), and its cleanup deletes
 * only keys under that prefix. Dev-only: .dockerignore keeps it out of the
 * production image.
 *
 *   NODE_ENV=test REDIS_URL=redis://localhost:6379/<n> bun --env-file=<env> \
 *     scripts/queue-isolation-bench.ts
 *
 * Nothing touches Postgres: the payloads carry no orgId, so the kernel worker
 * path never opens a transaction.
 */
import { randomUUID } from "node:crypto"

const BULK_JOBS = Number(process.env.BULK_JOBS ?? 5_000)
const BULK_JOB_MS = Number(process.env.BULK_JOB_MS ?? 20)
const ENQUEUES = Number(process.env.ENQUEUES ?? 1_000)
const BULK_JOB = "search-index-upsert"
const CRON_JOB = "local-claim-lapse-sweep"
const LATENCY_APP = "queuebench"

/** The Redis database index REDIS_URL names (0 when it names none). */
export function redisDbIndex(url: string): number {
  const path = new URL(url).pathname.replace(/^\//, "")
  return path === "" ? 0 : Number(path)
}

function refuseUnlessSafe(): void {
  const url = process.env.REDIS_URL ?? ""
  if (process.env.NODE_ENV !== "test") {
    throw new Error("queue-isolation-bench refuses to run unless NODE_ENV=test")
  }
  const db = url ? redisDbIndex(url) : 0
  if (!Number.isInteger(db) || db === 0) {
    throw new Error(
      "queue-isolation-bench refuses Redis database 0: point REDIS_URL at /<n>, n > 0",
    )
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

async function main(): Promise<void> {
  refuseUnlessSafe()
  const prefix = `w1bench-${randomUUID()}:`
  // Must be set before the redis module evaluates: it reads REDIS_PREFIX once.
  process.env.REDIS_PREFIX = prefix
  const jobs = await import("~/infra/jobs/jobs")
  const { redisBullMQ } = await import("~/lib/redis")
  jobs.hostJobWorkers()

  try {
    let bulkDone = 0
    jobs.registerJobWorker("kernel", BULK_JOB, async () => {
      await new Promise((r) => setTimeout(r, BULK_JOB_MS))
      bulkDone++
    })
    let cronWaitMs: number | null = null
    let bulkDoneWhenCronRan = 0
    const cronRan = new Promise<void>((resolve) => {
      jobs.registerJobWorker("kernel", CRON_JOB, async (payload: { t: number }) => {
        cronWaitMs = Date.now() - payload.t
        bulkDoneWhenCronRan = bulkDone
        resolve()
      })
    })
    jobs.registerJobWorker(LATENCY_APP, "noop", async () => {})

    // 1. Backlog, then one cron job behind it.
    for (let i = 0; i < BULK_JOBS; i++) {
      await jobs.enqueueAppJob("kernel", BULK_JOB, { i })
    }
    await jobs.enqueueAppJob("kernel", CRON_JOB, { t: Date.now() })
    await cronRan
    console.log(
      `cron wait behind ${BULK_JOBS} bulk jobs (${BULK_JOB_MS} ms each): ${cronWaitMs} ms ` +
        `(${bulkDoneWhenCronRan} bulk jobs had completed)`,
    )

    // 2. Enqueue latency with a jobId (delayed, so nothing runs meanwhile), then
    // the same ids again: the dedup hit path.
    for (const label of ["new id", "duplicate id"]) {
      const samples: number[] = []
      for (let i = 0; i < ENQUEUES; i++) {
        const t0 = performance.now()
        await jobs.enqueueAppJob(
          LATENCY_APP,
          "noop",
          { i },
          { jobId: `bench:${i}`, delay: 3_600_000 },
        )
        samples.push(performance.now() - t0)
      }
      const sorted = [...samples].sort((a, b) => a - b)
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length
      console.log(
        `enqueue with jobId (${label}), ${ENQUEUES} sequential: mean ${mean.toFixed(3)} ms, ` +
          `p50 ${percentile(sorted, 0.5).toFixed(3)} ms, p95 ${percentile(sorted, 0.95).toFixed(3)} ms`,
      )
    }
  } finally {
    // Clean up exactly what this run wrote: every key under its own prefix.
    await jobs.closeAllQueues()
    let cursor = "0"
    do {
      const [next, keys] = await redisBullMQ.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 1000)
      if (keys.length > 0) await redisBullMQ.unlink(...keys)
      cursor = next
    } while (cursor !== "0")
  }
  process.exit(0)
}

if (import.meta.main) await main()
