// SPDX-License-Identifier: FSL-1.1-ALv2
// e2e-own-server: boot-time drift recovery after a restart is the subject. As
// a shared lane's third file its post-restart reindex missed the 60 s budget
// (it passes alone in a lane and on its own server; the cause is not pinned:
// the lane keeps BullMQ state across files), so it gets a fresh worker
// (packages/test-helpers/src/e2e-lane.ts).
// [Phase 10 BE-1] Search drift recovery
// ---------------------------------------------------------------------------
// Spec refs: S4, V6.
//
// Verifies that when the canonical search index is missing at boot, Phase 10
// boot recreates it, enqueues a `search-reindex-full` job, and the route-gate
// flips from 503 → 200 with searchable rows visible after the worker drains.
//
// Mechanism:
//  1. Seed users + threads through the world builder, then create a thread
//     whose title contains a deterministic token ("USB detection report").
//  2. Wait for the indexer to ingest at least that thread (poll /api/search).
//  3. Use a worker-prefixed MeiliSearch client (constructed in-test) to delete
//     the index out from under the running server.
//  4. Call `env.restart()` — the spawned server re-runs `runPhase10Boot()`
//     which detects the missing index, creates it, applies settings, and
//     enqueues the full reindex.
//  5. Poll /api/search?q=USB until status flips back to 200 and the seeded
//     thread reappears in the hits.
//
// This regression catches: drift detection not enqueueing a reindex, settings
// task not awaited, route gate not flipping back to ready, full reindex
// silently dropping rows.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api } from "@liaison/test-helpers"
import { Queue } from "bullmq"
import IORedis from "ioredis"
import { MeiliSearch } from "meilisearch"
import { setupScenario, teardownScenario } from "./setup"

const USB_TITLE = "USB detection report"
// The rebuild job's queue and logical id (queue-classes.ts, search/reindex.ts).
const REBUILD_QUEUE = "kernel-bulk"
const REBUILD_JOB = "search-reindex-full"
const POLL_BUDGET_MS = 60_000
const POLL_TICK_MS = 250

function meiliClient(): MeiliSearch {
  return new MeiliSearch({
    host: process.env.MEILISEARCH_HOST ?? "http://localhost:7700",
    apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
  })
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  budgetMs: number,
  tickMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + budgetMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v !== null) return v
    } catch (err) {
      last = err
    }
    await Bun.sleep(tickMs)
  }
  throw new Error(`pollUntil(${label}) timed out after ${budgetMs}ms; last error: ${String(last)}`)
}

describe("Search drift recovery", () => {
  let env: WorkerEnv
  let world: TestWorld
  let usbThreadId: string

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 701,
      org: { name: "Drift Recovery Org" },
      populate: {
        users: { count: 12 },
        threads: { count: 25, participants: "random(2-5)", messages: "random(0-2)" },
      },
    })
    env = result.env
    world = result.world

    // Seed a deterministic searchable thread to validate the post-recovery query.
    const [partner] = await world.addUsers([{ name: "USB Reporter" }])
    const created = await world.threads.create(world.admin, {
      participantIds: [partner.id],
      title: USB_TITLE,
      initialMessage: { content: "Investigating the USB detection failure." },
    })
    usbThreadId = created.id

    // Wait for initial indexing so we know the index is populated.
    await pollUntil(
      async () => {
        const res = await api(env.serverUrl, `/api/search?q=USB&limit=5`, {
          token: world.admin.token,
        })
        if (res.status !== 200) return null
        const hit = res.body?.data?.threads?.find((t: any) => t.id === usbThreadId)
        return hit ? true : null
      },
      30_000,
      POLL_TICK_MS,
      "initial USB indexing",
    )
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  it("recreates the missing index and reindexes on restart", async () => {
    const indexName = `${env.meiliIndexPrefix}liaison_search`
    const meili = meiliClient()
    let handedBackJobId: string | undefined
    const rebuildRedis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,
    })
    const rebuildQueue = new Queue(REBUILD_QUEUE, {
      connection: rebuildRedis,
      prefix: `${env.redisPrefix}bull`,
    })

    // Restart the spawned server, deleting the Meili index BETWEEN the
    // proc kill and the new spawn so the old indexer pump cannot race the
    // deletion. Phase 10 boot then hits the "index_not_found" recovery
    // branch (creates the index, applies settings, enqueues full reindex).
    await env.restart({
      timeoutMs: 60_000,
      between: async () => {
        const deleteTask = await meili.deleteIndex(indexName).catch(() => null)
        if (deleteTask && deleteTask.taskUid != null) {
          await meili.tasks.waitForTask(deleteTask.taskUid)
        }
        // A rebuild still running when a process stops is handed back to its
        // queue (jobs.ts, jobs-hand-back), so the next boot finds it waiting
        // before it has registered the job's handler. Leave one there, as the
        // stopped process would have: the boot's own request dedups onto it.
        const left = await rebuildQueue.add(
          REBUILD_JOB,
          { reason: "handed_back" },
          {
            deduplication: { id: REBUILD_JOB },
            attempts: 10,
            backoff: { type: "exponential", delay: 60_000 },
          },
        )
        handedBackJobId = left.id
      },
    })

    // 3. Poll the API: drift recovery flips `isSearchReady` to true and the
    //    full-reindex worker re-upserts every row. Bound 60 s.
    const hits = await pollUntil(
      async () => {
        const res = await api(env.serverUrl, `/api/search?q=USB&limit=5`, {
          token: world.admin.token,
        })
        if (res.status !== 200) return null
        const t = res.body?.data?.threads?.find((row: any) => row.id === usbThreadId)
        return t ? res.body.data : null
      },
      POLL_BUDGET_MS,
      POLL_TICK_MS,
      "post-restart USB hit",
    )

    expect(hits).toBeDefined()
    expect(Array.isArray(hits.threads)).toBe(true)
    const usbThread = hits.threads.find((t: any) => t.id === usbThreadId)
    expect(usbThread).toBeDefined()
    expect(usbThread.title).toContain("USB")

    // 4. Server-side: the Meili index now exists again and has documents.
    const stats = await meili.index(indexName).getStats()
    expect(stats.numberOfDocuments).toBeGreaterThanOrEqual(1)

    // 5. The job waiting across the restart ran with its handler: the boot
    //    holds its workers until every handler is registered, so it never
    //    failed "No handler registered" into a retry a minute later.
    expect(handedBackJobId).toBeDefined()
    const job = await rebuildQueue.getJob(handedBackJobId as string)
    expect(job).toBeDefined()
    const runs = [job?.failedReason ?? "", ...(job?.stacktrace ?? [])].join("\n")
    expect(runs).not.toContain("No handler registered")
    await rebuildQueue.close()
    await rebuildRedis.quit()
  }, 180_000)
})
