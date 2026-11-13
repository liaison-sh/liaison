// SPDX-License-Identifier: FSL-1.1-ALv2
// A system or cross-app event reaches an app's sandboxed handler through a bridge.
// Only a core app (core/registry.ts: server code) may sit on a privileged
// transaction; every other app's bridge, first-party catalog apps and in-tree
// fixtures included, sits on an RLS transaction as the app itself, so the app's
// code never holds a handle that bypasses row-level security.
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
import { CORE_APP_NAMES, isCoreApp } from "~/modules/apps/core/registry"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
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

describe("isCoreApp", () => {
  it("is the seven core apps shipped in the image, whatever a descriptor claims", () => {
    expect([...CORE_APP_NAMES].sort()).toEqual([
      "calendar",
      "contacts",
      "knowledge",
      "mail",
      "mcp-manager",
      "projects",
      "tickets",
    ])
    for (const name of CORE_APP_NAMES) expect(isCoreApp({ name })).toBe(true)
    // A runtime install is never core, even under a core app's name.
    expect(isCoreApp({ name: "tickets", _installed: true })).toBe(false)
    // No field makes another app core: not trusted, not a platform or operator voucher.
    for (const claim of [
      {},
      { trusted: true },
      { _firstParty: true },
      { _publisherSigned: true },
    ]) {
      expect(isCoreApp({ name: "gitlab", ...claim })).toBe(false)
      expect(isCoreApp({ name: "database", _installed: true, ...claim })).toBe(false)
    }
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
    await register({ _installed: true })
    await publishEvent(systemEvent("evt-priv-third-party") as never)
    expect(await pollUntil(() => logged("evt-priv-third-party"), 25_000)).toBe(true)
    expect(privReasons.filter((r) => r.startsWith("event:test:"))).toEqual([])
    expect(rlsActors).toContainEqual({ actorType: "system", scopes: ["test:*"] })
  }, 30_000)

  it("a first-party catalog app's handler runs as the app under RLS too: no first-party privilege", async () => {
    await register({ _installed: true, _firstParty: true })
    await publishEvent(systemEvent("evt-priv-first-party") as never)
    expect(await pollUntil(() => logged("evt-priv-first-party"), 25_000)).toBe(true)
    expect(privReasons.filter((r) => r.startsWith("event:test:"))).toEqual([])
    expect(rlsActors).toContainEqual({ actorType: "system", scopes: ["test:*"] })
  }, 30_000)

  it("an in-tree app that is not core runs as the app under RLS", async () => {
    await register({})
    await publishEvent(systemEvent("evt-priv-in-tree") as never)
    expect(await pollUntil(() => logged("evt-priv-in-tree"), 25_000)).toBe(true)
    expect(privReasons.filter((r) => r.startsWith("event:test:"))).toEqual([])
    expect(rlsActors).toContainEqual({ actorType: "system", scopes: ["test:*"] })
  }, 30_000)
})
