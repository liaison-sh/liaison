// SPDX-License-Identifier: FSL-1.1-ALv2
// Manifest JOB handlers (scheduled + on-demand) must execute in the
// out-of-process sandbox worker pool, like manifest event handlers do -- an
// in-process QuickJS job (e.g. a mail full-history sync page) stalls the host
// event loop in multi-second synchronous chunks. Mirrors
// runtime-event-worker.test.ts with the real engine end to end:
// registerApps -> enqueueAppJob -> BullMQ worker -> sandbox -> bridge -> DB.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { getWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import testManifest from "../../../test-support/apps/test/app.manifest.json"

const ORG = "00000000-0000-0000-0000-000000160002"
// Must match SPIN_MS in __fixtures__/event-spin/handler-bundle.ts.
const SPIN_MS = 1500

async function pollUntil(cond: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

async function jobLogged(marker: string): Promise<boolean> {
  const rows = await sql`
    SELECT id FROM app_test.event_log
    WHERE org_id = ${ORG} AND entity_id = ${marker} LIMIT 1`
  return rows.length > 0
}

describe("manifest job handlers execute in the sandbox worker pool", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Job Worker Org', 'job-worker-org')
      ON CONFLICT (id) DO NOTHING`
    // The shared test Redis accumulates STALE repeat-scheduler jobs for
    // app-test from every past run's orgs (the orchestrator's FLUSHDB pretest
    // doesn't run here). Dozens of them drain first, each burning retries on
    // "app not installed", and starve this test's enqueued job past its poll
    // window. Wipe the app-test queue state before registering fresh.
    //
    // BullMQ keys live on `redisBullMQ` (no ioredis keyPrefix -- BullMQ owns
    // its own `bullPrefix`, which already bakes in REDIS_PREFIX), not on the
    // shared `redis` client: a bare `redis.keys("bull:app-test:*")` sends an
    // unprefixed pattern to the server and silently matches nothing once a
    // namespaced test run is in play, leaving the stale jobs in place.
    const { redisBullMQ, bullPrefix } = await import("~/lib/redis")
    const staleKeys = await redisBullMQ.keys(`${bullPrefix}:app-test:*`)
    if (staleKeys.length > 0) await redisBullMQ.del(...staleKeys)
    await initSandboxPool()
    const manifest = {
      ...testManifest,
      // Reuse the event-spin fixture bundle; point the scheduled job at its
      // CPU-burning handler (enqueueAppJob triggers it directly -- the cron
      // never fires during the test).
      jobs: {
        processItems: {
          // Valid cron that effectively never fires during a test run (Jan 1,
          // 05:00); the test triggers the handler directly via enqueueAppJob.
          schedule: "0 5 1 1 *",
          handler: "processItemsSpin",
        },
      },
      _format: "manifest",
      _bundlePath: new URL("./__fixtures__/event-spin/handler-bundle.ts", import.meta.url).pathname,
    }
    await registerApps([manifest as any], ORG)
  })

  afterAll(async () => {
    await teardownAppRegistrations(ORG, "test")
    resetAppRegistries()
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    await sql`DELETE FROM app_test.event_log WHERE org_id = ${ORG}`.catch(() => {})
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("a CPU-burning job handler occupies a WORKER and does not stall the host event loop", async () => {
    const gaps: number[] = []
    let prev = Date.now()
    const lagProbe = setInterval(() => {
      const now = Date.now()
      gaps.push(now - prev)
      prev = now
    }, 25)

    let workerBusySeen = false
    const busyProbe = setInterval(() => {
      try {
        if (getWorkerPool().stats().busy > 0) workerBusySeen = true
      } catch {
        // pool not initialized yet -- what the in-process path looks like
      }
    }, 25)

    try {
      await enqueueAppJob("test", "processItems", { orgId: ORG, marker: "job-worker-spin" })
      // Generous window: first execution also pays worker-pool spawn.
      expect(await pollUntil(() => jobLogged("job-worker-spin"), 25_000)).toBe(true)
    } finally {
      clearInterval(lagProbe)
      clearInterval(busyProbe)
    }

    // Routed through the worker pool (fails when the handler runs in-process).
    expect(workerBusySeen).toBe(true)
    // Host loop stayed responsive: no tick gap anywhere near the spin window.
    expect(Math.max(...gaps)).toBeLessThan(SPIN_MS / 3)
  }, 40_000)
})
