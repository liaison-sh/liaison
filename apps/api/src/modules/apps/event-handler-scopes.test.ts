// SPDX-License-Identifier: FSL-1.1-ALv2
// A vouched-for app's system event handler and approval poll run on a
// privileged transaction, as the app: a scope check in the database (a task
// number's `app_projects.app_has_scope('projects:tasks:write')`) reads the
// scopes the app's manifest declares, and refuses when it declares none
// (runtime.ts: the privileged event branch and the poll wrapper; db/privileged.ts
// setPrivilegedContext; migration 0210). Each check runs on the very
// transaction the handler gets.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { sql } from "~/db/connection"
import * as privilegedModule from "~/db/privileged"
import {
  initEventBus,
  _publishEventInternal as publishEvent,
  resetEventBus,
} from "~/infra/events/event-bus"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import testManifest from "../../../test-support/apps/test/app.manifest.json"

const ORG = "00000000-0000-0000-0000-000000160b01"
const BUNDLE = new URL("../../../test-support/apps/test/handler-bundle.ts", import.meta.url)
  .pathname
const DECLARED = ["test:items:write", "projects:tasks:write"]

interface Seen {
  ok: boolean
  scopes: string | null
}

/** What a scope check reads on `tx`: the task-number check and the raw context. */
async function readScopes(tx: { execute: (q: never) => Promise<unknown> }): Promise<Seen> {
  const [row] = extractRows<{ ok: boolean; scopes: string | null }>(
    await tx.execute(
      drizzleSql`SELECT app_projects.app_has_scope('projects:tasks:write') AS ok,
                        rls_ctx.scopes() AS scopes` as never,
    ),
  )
  return { ok: row!.ok, scopes: row!.scopes }
}

async function pollUntil(cond: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
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

/** The fixture app as a first-party install (privileged), declaring `scopes`, with a polled tool. */
async function register(scopes: string[] | undefined) {
  const tools = {
    ...testManifest.tools,
    gatedProduce: { ...testManifest.tools.gatedProduce, pollHandler: "listItems" },
  }
  await registerApps(
    [
      {
        ...testManifest,
        tools,
        ...(scopes ? { scopes } : {}),
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

describe("a privileged app handler acts with the scopes its manifest declares", () => {
  let seen: Seen[] = []
  let privSpy: ReturnType<typeof spyOn>

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Event Scopes Org', 'event-scopes-org') ON CONFLICT (id) DO NOTHING`
    resetEventBus()
    initEventBus()
    await initSandboxPool()
    const realPriv = privilegedModule.withPrivilegedDb
    // The handler's own transaction: read what a scope check sees, then run it.
    privSpy = spyOn(privilegedModule, "withPrivilegedDb").mockImplementation(((
      orgId: string,
      reason: string,
      fn: (tx: never) => Promise<unknown>,
      opts: never,
    ) =>
      realPriv(
        orgId,
        reason,
        async (tx) => {
          if (reason.startsWith("event:test:")) seen.push(await readScopes(tx as never))
          return fn(tx as never)
        },
        opts,
      )) as never)
  })

  afterEach(async () => {
    await teardownAppRegistrations(ORG, "test")
    resetAppRegistries()
    seen = []
  })

  afterAll(async () => {
    privSpy.mockRestore()
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    await sql`DELETE FROM app_test.event_log WHERE org_id = ${ORG}`.catch(() => {})
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("the event handler reads the declared scopes", async () => {
    await register(DECLARED)
    await publishEvent(systemEvent("evt-scopes-declared") as never)
    expect(await pollUntil(async () => seen.length > 0, 25_000)).toBe(true)
    expect(seen[0]).toEqual({ ok: true, scopes: DECLARED.join(",") })
  }, 30_000)

  it("the event handler of an app that declares no scope is refused", async () => {
    await register(undefined)
    await publishEvent(systemEvent("evt-scopes-none") as never)
    expect(await pollUntil(async () => seen.length > 0, 25_000)).toBe(true)
    expect(seen[0]).toEqual({ ok: false, scopes: "__none__" })
  }, 30_000)

  async function pollAndRead(): Promise<Seen> {
    const entry = toolRegistry.get([ORG, "test", "gatedProduce"]) as {
      poll?: (ctx: { orgId: string; userId: string; tx: unknown }, ref: unknown) => Promise<unknown>
    }
    expect(typeof entry?.poll).toBe("function")
    // The approval-poll job hands the poll a privileged transaction (poll-output.ts).
    return privilegedModule.withPrivilegedDb(ORG, "test-poll-call", async (tx) => {
      await entry.poll!({ orgId: ORG, userId: "system", tx }, "ext-1")
      return readScopes(tx as never)
    })
  }

  it("the poll reads the declared scopes", async () => {
    await register(DECLARED)
    expect(await pollAndRead()).toEqual({ ok: true, scopes: DECLARED.join(",") })
  }, 30_000)

  it("the poll of an app that declares no scope is refused", async () => {
    await register(undefined)
    expect(await pollAndRead()).toEqual({ ok: false, scopes: "__none__" })
  }, 30_000)
})
