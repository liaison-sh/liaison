// SPDX-License-Identifier: FSL-1.1-ALv2
import { createWorkerEnv, TestWorld, type WorkerEnv } from "@liaison/test-helpers"

// Worker ID comes from WORKER_ID env var (set by parallel runner) or defaults to sequential counter.
let _seqCounter = 0

export async function setupScenario(opts?: {
  seed?: number
  org?: { name?: string }
  populate?: Parameters<TestWorld["populate"]>[0]
  serverEnv?: Record<string, string | undefined>
  portCount?: number
  /** Boot a server of this file's own even under a shared e2e lane (see e2e-lane.ts). */
  ownServer?: boolean
}): Promise<{ env: WorkerEnv; world: TestWorld }> {
  const workerId = process.env.WORKER_ID != null ? Number(process.env.WORKER_ID) : _seqCounter++
  const t0 = performance.now()
  const env = await createWorkerEnv(workerId, {
    serverEnv: opts?.serverEnv,
    portCount: opts?.portCount,
    ownServer: opts?.ownServer,
  })
  const t1 = performance.now()

  const world = await TestWorld.create(env.serverUrl, env.db, {
    seed: opts?.seed ?? workerId,
    org: opts?.org,
    schemaPrefix: env.schemaPrefix,
    existingAdmin: env.bootstrapped,
  })
  await env.waitForReady()
  const t2 = performance.now()

  if (opts?.populate) {
    await world.populate(opts.populate)
  }
  const t3 = performance.now()
  const drained = await waitForOutboxDrained(env)
  const t4 = performance.now()
  // One line per setup, so a slow file's log says where its setup went.
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`
  console.error(
    `[setupScenario] ${env.bootstrapped ? "lane" : "own server"}: env ${s(t1 - t0)}, world ${s(t2 - t1)}, populate ${s(t3 - t2)}, outbox ${s(t4 - t3)}${drained ? "" : " (not drained)"}`,
  )

  return { env, world }
}

/**
 * Wait until the outbox has processed every event the setup wrote.
 *
 * Creating the org, its users and a populated world queues hundreds of events,
 * and the outbox works through them at its own pace (every event runs the
 * durable consumers: audit, timeline, notifications, search). A scenario that
 * starts before that backlog is gone waits behind it for the one event it
 * caused, and a bounded wait for a websocket frame, a timeline entry or an app's
 * reaction to a connection then fails on a loaded machine for no fault of the
 * code under test. Bounded: a backlog that never drains is reported in the
 * setup line, and the scenario runs anyway.
 */
async function waitForOutboxDrained(env: WorkerEnv, timeoutMs = 90_000): Promise<boolean> {
  const table = `"${env.schemaPrefix ?? ""}kernel".pending_events`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [row] = (await env.db.sql.unsafe(
      `SELECT EXISTS (SELECT 1 FROM ${table} WHERE processed_at IS NULL AND failed_at IS NULL) AS pending`,
    )) as unknown as Array<{ pending: boolean }>
    if (!row?.pending) return true
    await Bun.sleep(100)
  }
  return false
}

export async function teardownScenario(env?: WorkerEnv, world?: TestWorld): Promise<void> {
  await world?.destroy()
  await env?.teardown()
}
