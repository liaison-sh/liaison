// SPDX-License-Identifier: FSL-1.1-ALv2
// Manifest EVENT handlers must execute in the out-of-process sandbox worker
// pool, not on the main thread's in-process QuickJS pool. In-process execution
// made every event-handler run a synchronous main-thread chunk: a burst of
// outbox events (or one slow handler) stalled the HTTP event loop for seconds
// -- the prod "run-tool 504 / frozen UI" class. These tests pin, with the real
// engine end to end (registerApps -> event bus -> sandbox -> RPC bridge -> DB):
//   1. behavior: a published event still reaches the handler and its bridge
//      side effect lands (fire-and-forget semantics preserved);
//   2. isolation: a CPU-burning handler does NOT stall the host event loop;
//   3. routing: the execution occupies a sandbox WORKER while it runs.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import {
  initEventBus,
  _publishEventInternal as publishEvent,
  resetEventBus,
} from "~/infra/events/event-bus"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { getWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import testManifest from "../../../test-support/apps/test/app.manifest.json"

const ORG = "00000000-0000-0000-0000-000000160001"
// Must exceed the fixture bundle's SPIN_MS (3000) comfortably less than the
// dispatch timeout; see __fixtures__/event-spin/handler-bundle.ts.
const SPIN_MS = 3000

async function pollUntil(cond: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

async function eventLogged(entityId: string): Promise<boolean> {
  const rows = await sql`
    SELECT id FROM app_test.event_log
    WHERE org_id = ${ORG} AND entity_id = ${entityId} LIMIT 1`
  return rows.length > 0
}

describe("manifest event handlers execute in the sandbox worker pool", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Event Worker Org', 'event-worker-org')
      ON CONFLICT (id) DO NOTHING`
    resetEventBus()
    initEventBus()
    await initSandboxPool()
    const manifest = {
      ...testManifest,
      // The fixture bundle exports onItemCreatedSpin (renamed vs the kernel
      // test app's onItemCreated: both bundles are script-scope files in the
      // same TS program, so identical global function names collide).
      events: {
        ...testManifest.events,
        subscribes: { "items:created": "onItemCreatedSpin" },
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

  it("delivers the event and the handler's bridge side effect lands (behavior preserved)", async () => {
    await publishEvent({
      app: "test",
      entity: "items",
      action: "created",
      entityId: "evt-worker-behavior",
      data: { title: "behavior" },
      actorId: "system:test",
      actorType: "system",
      orgId: ORG,
      timestamp: new Date().toISOString(),
    } as any)

    // First execution also pays worker-pool spawn, hence the generous window.
    expect(await pollUntil(() => eventLogged("evt-worker-behavior"), 25_000)).toBe(true)
  }, 30_000)

  it("a CPU-burning handler occupies a WORKER and does not stall the host event loop", async () => {
    // Event-loop lag probe: with the handler in-process, its synchronous
    // QuickJS spin blocks these ticks for ~SPIN_MS; off-process they keep firing.
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
        // pool not initialized yet -- exactly what the in-process path looks like
      }
    }, 25)

    try {
      await publishEvent({
        app: "test",
        entity: "items",
        action: "created",
        entityId: "evt-worker-spin",
        data: { title: "spin" },
        actorId: "system:test",
        actorType: "system",
        orgId: ORG,
        timestamp: new Date().toISOString(),
      } as any)

      expect(await pollUntil(() => eventLogged("evt-worker-spin"), 25_000)).toBe(true)
    } finally {
      clearInterval(lagProbe)
      clearInterval(busyProbe)
    }

    // Routed through the worker pool (fails when the handler runs in-process).
    expect(workerBusySeen).toBe(true)
    // Host loop stayed responsive: no tick gap anywhere near the spin window.
    const maxGap = Math.max(...gaps)
    expect(maxGap).toBeLessThan(SPIN_MS / 3)
  }, 40_000)
})
