// SPDX-License-Identifier: FSL-1.1-ALv2
// A system or cross-app event reaches an app's sandboxed handler through a bridge.
// For code the platform vouches for (in-tree, trusted, or the image's own catalog
// artifact) that bridge may sit on a privileged transaction; for any other install
// it sits on an RLS transaction as the app itself, so the app's code never holds a
// handle that bypasses row-level security.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db/connection"
import * as privilegedModule from "~/db/privileged"
import * as rlsModule from "~/db/rls"
import {
  initEventBus,
  _publishEventInternal as publishEvent,
  resetEventBus,
} from "~/infra/events/event-bus"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { hasPrivilegedBridge, registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import testManifest from "../../../test-support/apps/test/app.manifest.json"

const ORG = "00000000-0000-0000-0000-000000160a01"
const BUNDLE = new URL("../../../test-support/apps/test/handler-bundle.ts", import.meta.url)
  .pathname

async function pollUntil(cond: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

async function logged(entityId: string): Promise<boolean> {
  const rows = await sql`
    SELECT id FROM app_test.event_log WHERE org_id = ${ORG} AND entity_id = ${entityId} LIMIT 1`
  return rows.length > 0
}

function systemEvent(entityId: string) {
  return {
    app: "test",
    entity: "items",
    action: "created",
    entityId,
    data: { title: entityId },
    actorId: "system:test",
    actorType: "system",
    orgId: ORG,
    timestamp: new Date().toISOString(),
  }
}

async function register(extra: Record<string, unknown>) {
  await registerApps(
    [{ ...testManifest, ...extra, _format: "manifest", _bundlePath: BUNDLE } as never],
    ORG,
  )
}

describe("hasPrivilegedBridge", () => {
  it("vouches for trusted, in-tree and first-party catalog code only", () => {
    expect(hasPrivilegedBridge({})).toBe(true)
    expect(hasPrivilegedBridge({ trusted: true })).toBe(true)
    expect(hasPrivilegedBridge({ trusted: false, _firstParty: true })).toBe(true)
    expect(hasPrivilegedBridge({ trusted: false })).toBe(false)
    expect(hasPrivilegedBridge({ trusted: false, _publisherSigned: true })).toBe(false)
  })
})

describe("system event handlers and the privileged pool", () => {
  let privReasons: string[] = []
  let rlsActors: Array<{ actorType: string; scopes?: string[] }> = []
  let privSpy: ReturnType<typeof spyOn>
  let rlsSpy: ReturnType<typeof spyOn>

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Event Privilege Org', 'event-privilege-org') ON CONFLICT (id) DO NOTHING`
    resetEventBus()
    initEventBus()
    await initSandboxPool()
    const realPriv = privilegedModule.withPrivilegedDb
    const realRls = rlsModule.withRlsContext
    privSpy = spyOn(privilegedModule, "withPrivilegedDb").mockImplementation(((
      orgId: string,
      reason: string,
      fn: never,
      opts: never,
    ) => {
      privReasons.push(reason)
      return realPriv(orgId, reason, fn, opts)
    }) as never)
    rlsSpy = spyOn(rlsModule, "withRlsContext").mockImplementation(((
      ctx: { actorType: string; scopes?: string[] },
      fn: never,
      opts: never,
    ) => {
      rlsActors.push({ actorType: ctx.actorType, scopes: ctx.scopes })
      return realRls(ctx as never, fn, opts)
    }) as never)
  })

  afterEach(async () => {
    await teardownAppRegistrations(ORG, "test")
    resetAppRegistries()
    privReasons = []
    rlsActors = []
  })

  afterAll(async () => {
    privSpy.mockRestore()
    rlsSpy.mockRestore()
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    await sql`DELETE FROM app_test.event_log WHERE org_id = ${ORG}`.catch(() => {})
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("a third-party install's handler runs as the app under RLS, never privileged", async () => {
    await register({ trusted: false, _installed: true })
    await publishEvent(systemEvent("evt-priv-third-party") as never)
    expect(await pollUntil(() => logged("evt-priv-third-party"), 25_000)).toBe(true)
    expect(privReasons.filter((r) => r.startsWith("event:test:"))).toEqual([])
    expect(rlsActors).toContainEqual({ actorType: "system", scopes: ["test:*"] })
  }, 30_000)

  it("a first-party handler keeps its privileged transaction", async () => {
    await register({ trusted: false, _installed: true, _firstParty: true })
    await publishEvent(systemEvent("evt-priv-first-party") as never)
    expect(await pollUntil(() => logged("evt-priv-first-party"), 25_000)).toBe(true)
    expect(privReasons.some((r) => r.startsWith("event:test:"))).toBe(true)
  }, 30_000)
})
