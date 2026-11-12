// SPDX-License-Identifier: FSL-1.1-ALv2
// No sandboxed run holds a host transaction (run-wide-tx.ts): a sandboxed
// app's event handler and webhook delivery open a short transaction per bridge
// call, so nothing sits `idle in transaction` while the handler asks its
// provider. A listed exception still runs on one transaction (its failed run
// writes nothing), and the platform's own bookkeeping around a handler that
// fails part way stays right: the event is retried once, the inbox row goes
// back to `pending` for its replay.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { sql } from "~/db"
import {
  flushEventHandlers,
  initEventBus,
  _publishEventInternal as publishEvent,
  resetEventBus,
} from "~/infra/events/event-bus"
import * as jobsModule from "~/infra/jobs/jobs"
import { replayInboxDelivery } from "~/infra/jobs/webhook-inbox-jobs"
import { resetAppRegistries, webhookHandlers } from "~/modules/apps/app-registries"
import { RunWideTxTestAccess } from "~/modules/apps/run-wide-tx"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { runWebhookHandler } from "~/modules/webhooks/handler-run"
import { storeDelivery } from "~/modules/webhooks/inbox"
import { seedOrgRow } from "~/seed/factories/org/rows"
import testManifest from "../../../test-support/apps/test/app.manifest.json"

const ORG = "00000000-0000-0000-0000-000000217b02"
const BUNDLE = new URL("../../../test-support/apps/test/handler-bundle.ts", import.meta.url)
  .pathname

/** Backends of this database sitting in an open transaction, the caller's own excluded. */
async function idleInTransaction(): Promise<number> {
  const [r] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND state LIKE 'idle in transaction%'`
  return r!.n as number
}

async function logged(marker: string): Promise<string[]> {
  const rows = await sql<{ event_type: string }[]>`
    SELECT event_type FROM app_test.event_log WHERE org_id = ${ORG} AND entity_id = ${marker}
    ORDER BY event_type`
  return rows.map((r) => r.event_type)
}

/** The fixture app as a sandboxed first-party install, with probe handlers. */
async function register() {
  await registerApps(
    [
      {
        ...testManifest,
        events: {
          ...testManifest.events,
          subscribes: { "items:created": "providerThenWrite", "items:updated": "writeThenThrow" },
        },
        webhooks: {
          probe: { handler: "providerThenWrite", verify: "verifyTestSignature" },
          fails: { handler: "writeThenThrow", verify: "verifyTestSignature" },
        },
        network: { allowedDomains: ["run.provider.test"] },
        scopes: ["test:items:write"],
        trusted: false,
        _installed: true,
        _firstParty: true,
        _format: "manifest",
        _bundlePath: BUNDLE,
      } as never,
    ],
    ORG,
  )
}

function event(action: "created" | "updated", marker: string) {
  return {
    app: "test",
    entity: "items",
    action,
    entityId: marker,
    data: { marker },
    actorId: "system:test",
    actorType: "system",
    orgId: ORG,
    timestamp: new Date().toISOString(),
  }
}

describe("a sandboxed event handler or webhook delivery holds no transaction", () => {
  const openDuringFetch: number[] = []

  beforeAll(async () => {
    await seedOrgRow(
      { id: ORG, name: "Short Tx Org", slug: "short-tx-org" },
      { onConflict: "skip" },
    )
    resetEventBus()
    initEventBus()
    await initSandboxPool()
    SandboxBridgeTestAccess.setFetchInterceptsHost((h) => h === "run.provider.test")
    SandboxBridgeTestAccess.setFetch((async () => {
      openDuringFetch.push(await idleInTransaction())
      return Response.json({ ok: true })
    }) as unknown as typeof fetch)
  })

  beforeEach(async () => {
    openDuringFetch.length = 0
    // The replay's next wake is observed, not queued.
    spyOn(jobsModule, "enqueueAppJob").mockImplementation(async () => "stub")
    await register()
  })

  afterEach(async () => {
    RunWideTxTestAccess.clear()
    await teardownAppRegistrations(ORG, "test")
    resetAppRegistries()
    const { mock } = await import("bun:test")
    mock.restore()
  })

  afterAll(async () => {
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    await sql`DELETE FROM kernel.webhook_inbox WHERE org_id = ${ORG}`.catch(() => {})
    await sql`DELETE FROM app_test.event_log WHERE org_id = ${ORG}`.catch(() => {})
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("an event handler asks its provider with no transaction open, then writes", async () => {
    const marker = `evt-${randomUUID()}`
    await publishEvent(event("created", marker) as never)
    await flushEventHandlers()
    expect(openDuringFetch).toEqual([0])
    expect(await logged(marker)).toEqual(["probe"])
  }, 30_000)

  it("an event handler that fails part way keeps its writes, and the bus retries it once", async () => {
    const marker = `evt-${randomUUID()}`
    await publishEvent(event("updated", marker) as never)
    await flushEventHandlers()
    // Each call committed on its own: both attempts left both their writes.
    expect(await logged(marker)).toEqual(["first", "first", "second", "second"])
  }, 30_000)

  it("a listed handler still runs on one transaction: its failed run writes nothing", async () => {
    RunWideTxTestAccess.allow("test", "event:writeThenThrow")
    const marker = `evt-${randomUUID()}`
    await publishEvent(event("updated", marker) as never)
    await flushEventHandlers()
    expect(await logged(marker)).toEqual([])
  }, 30_000)

  it("a webhook delivery asks its provider with no transaction open, then writes", async () => {
    const marker = `hook-${randomUUID()}`
    const registration = webhookHandlers.get([ORG, "test", "probe"])
    if (!registration) throw new Error("probe webhook not registered")
    const out = await runWebhookHandler({
      registration,
      appName: "test",
      orgId: ORG,
      scopes: ["test:*"],
      userActorId: null,
      payload: { data: { marker } },
      headers: {},
    })
    expect(out).toEqual({ status: 200 })
    expect(openDuringFetch).toEqual([0])
    expect(await logged(marker)).toEqual(["probe"])
  }, 30_000)

  async function replayFailing(marker: string) {
    const stored = await storeDelivery(
      {
        orgId: ORG,
        appName: "test",
        endpointName: "fails",
        deliveryHash: createHash("sha256").update(marker).digest("hex"),
        dedupTtlSeconds: 3600,
        payload: { data: { marker } },
        headers: {},
        scopes: ["test:*"],
      },
      { claimLeaseMs: 60_000 },
    )
    if (!stored) throw new Error("not stored")
    await sql`UPDATE kernel.webhook_inbox SET due_at = now() - interval '1 second' WHERE id = ${stored.id}`
    await replayInboxDelivery({ orgId: ORG, inboxId: stored.id })
    const [row] = await sql<{ status: string; attempts: number; last_error: string | null }[]>`
      SELECT status, attempts, last_error FROM kernel.webhook_inbox WHERE id = ${stored.id}`
    return row
  }

  it("a webhook handler that fails part way: the inbox row waits for its replay, the writes stay", async () => {
    const marker = `hook-${randomUUID()}`
    const row = await replayFailing(marker)
    expect(row).toMatchObject({ status: "pending", attempts: 2 })
    expect(row?.last_error ?? "").toContain(`failed after writing ${marker}`)
    expect(await logged(marker)).toEqual(["first", "second"])
  }, 30_000)

  it("a listed webhook handler that fails part way writes nothing; the inbox row is the same", async () => {
    RunWideTxTestAccess.allow("test", "webhook:writeThenThrow")
    const marker = `hook-${randomUUID()}`
    const row = await replayFailing(marker)
    expect(row).toMatchObject({ status: "pending", attempts: 2 })
    expect(await logged(marker)).toEqual([])
  }, 30_000)
})
