// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 deep-review — Track B1 (CLUSTER 4 sandbox security + CLUSTER 6
// kernel read affordance). Negative-path / contract tests that would have
// caught the cross-tenant escalation and the missing reconcile bridge:
//
//   1. enqueueJob pins the bridge's trusted orgId — a sandbox cannot override
//      it with a victim org in the payload (cross-tenant escalation).
//   2. bulk_fetchToBlob is capability-gated (bulk.fetch) and DNS-pinned.
//   3. kernel_findContactsByExternalId / listContactsByExternalId list the
//      calling app's externally-linked kernel.contacts (reconcile backstop).
//   4. db_findMany orderBy keys and db_insert/db_update fields are validated
//      against the manifest schema (no opt-in field validation).
//
// `~/infra/jobs/jobs` is mocked so we can capture exactly what payload the
// bridge enqueues without standing up Redis/BullMQ. mock.module is PROCESS
// wide and survives this file, so this test lives in the `integration-mocked`
// suite with the other three kernel-module mockers rather than in the flat
// unit process it used to share with every sandbox test.
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

// HERMETICITY (mock.module global-leak class): spread the REAL module so the
// stub is COMPLETE (only `enqueueAppJob` is overridden — every other export of
// `~/infra/jobs/jobs` stays real for later importers) and re-install the real
// module in `afterAll`. See `mock-module-hygiene.test.ts` for the guard.
const realJobs = await import("~/infra/jobs/jobs")
// Eager snapshot: `realJobs` is a LIVE namespace view, so mock.module patches
// it in place — spreading it inside the restore factory would re-install the
// mock. Snapshot the real exports BEFORE the mock so afterAll truly restores.
const realJobsModule = { ...realJobs }

const enqueued: Array<{ appName: string; jobName: string; payload: any }> = []
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  enqueueAppJob: async (appName: string, jobName: string, payload: unknown) => {
    enqueued.push({ appName, jobName, payload })
    return "job-id"
  },
}))

afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})

const { createRpcBridge, SandboxBridgeTestAccess } = await import(
  "~/modules/apps/sandbox/rpc-bridge"
)

const BRIDGE_ORG = "00000000-0000-0000-0000-0000000b1001"
const VICTIM_ORG = "00000000-0000-0000-0000-0000000b1666"
const TEST_USER = "00000000-0000-0000-0000-0000000b1002"

const mockTx: any = {
  execute: async () => [],
  queueEvent: async () => {},
  // The sandbox bridge runs each call in a savepoint of the same transaction.
  transaction: (fn: (sp: unknown) => Promise<unknown>) => fn(mockTx),
}

beforeEach(() => {
  enqueued.length = 0
})

describe("enqueueJob — orgId pinning (CLUSTER 4, cross-tenant escalation)", () => {
  it("pins the bridge orgId even when a (system-actor) sandbox payload tries to override it", async () => {
    // Webhook handlers run as the bare "system" actor — exactly the unprotected
    // path. A handler reached via a webhook must not be able to enqueue a job
    // against an arbitrary victim org.
    const bridge = createRpcBridge("shopify", "system", BRIDGE_ORG, mockTx, {
      name: "shopify",
      schema: {},
      capabilities: [],
    } as any)

    await bridge.enqueueJob(
      "reconcile-customers",
      JSON.stringify({ orgId: VICTIM_ORG, cursor: "abc" }),
    )

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].payload.orgId).toBe(BRIDGE_ORG)
    expect(enqueued[0].payload.orgId).not.toBe(VICTIM_ORG)
    // Non-org fields are preserved.
    expect(enqueued[0].payload.cursor).toBe("abc")
  })

  it("pins the bridge orgId on the user-actor path too and still propagates _userId", async () => {
    const bridge = createRpcBridge(
      "shopify",
      TEST_USER,
      BRIDGE_ORG,
      mockTx,
      { name: "shopify", schema: {}, capabilities: [] } as any,
      ["shopify:*"],
    )

    await bridge.enqueueJob("scan-unfulfilled-orders", JSON.stringify({ orgId: VICTIM_ORG }))

    expect(enqueued[0].payload.orgId).toBe(BRIDGE_ORG)
    expect(enqueued[0].payload._userId).toBe(TEST_USER)
    expect(enqueued[0].payload._callerScopes).toEqual(["shopify:*"])
  })

  it("stamps orgId even when the payload omits it entirely", async () => {
    const bridge = createRpcBridge("shopify", "system", BRIDGE_ORG, mockTx, {
      name: "shopify",
      schema: {},
      capabilities: [],
    } as any)

    await bridge.enqueueJob("reconcile-customers", JSON.stringify({}))

    expect(enqueued[0].payload.orgId).toBe(BRIDGE_ORG)
  })

  it("a job enqueued from an event handler runs as the app, not as whoever caused the event", async () => {
    // The event's actor may hold none of the app's scopes (a mailbox reconnect
    // by someone without mail access). Stamped on the job with the handler's
    // `<app>:*` snapshot, the worker found no overlap and failed every attempt.
    const { createEventHandlerBridge } = await import("~/modules/apps/sandbox/event-handler-bridge")
    const bridge = createEventHandlerBridge({
      appName: "mail",
      actorId: TEST_USER,
      orgId: BRIDGE_ORG,
      txDb: mockTx,
      manifest: { name: "mail", schema: {}, capabilities: [] } as any,
      actorType: "user",
    })

    await bridge.enqueueJob("gmail-incremental-sync", JSON.stringify({ accountId: "a-1" }))

    expect(enqueued[0].payload.orgId).toBe(BRIDGE_ORG)
    expect(enqueued[0].payload.accountId).toBe("a-1")
    expect(enqueued[0].payload._userId).toBeUndefined()
    expect(enqueued[0].payload._callerScopes).toBeUndefined()
  })
})

describe("bulk_fetchToBlob — capability gating (CLUSTER 4)", () => {
  it("returns CAPABILITY_NOT_DECLARED when bulk.fetch is not declared", async () => {
    const bridge = createRpcBridge("shopify", TEST_USER, BRIDGE_ORG, mockTx, {
      name: "shopify",
      schema: {},
      capabilities: [], // no bulk.fetch
    } as any)
    const r = JSON.parse(await bridge.bulk_fetchToBlob("https://example.com/bulk.jsonl"))
    expect(r.error?.code).toBe("CAPABILITY_NOT_DECLARED")
  })

  it("rejects a URL outside the manifest network allowlist even with the capability", async () => {
    const bridge = createRpcBridge("shopify", TEST_USER, BRIDGE_ORG, mockTx, {
      name: "shopify",
      schema: {},
      capabilities: ["bulk.fetch"],
      network: { allowedDomains: ["*.myshopify.com"] },
    } as any)
    const r = JSON.parse(await bridge.bulk_fetchToBlob("https://evil.example.com/x.jsonl"))
    // validateSandboxFetchUrl throws "Domain not in allowlist" before any fetch.
    expect(r.error).toBeDefined()
    expect(String(r.error.message)).toMatch(/not in allowlist/i)
  })

  it("bulk_iterateJsonl_next is also capability-gated", async () => {
    const bridge = createRpcBridge("shopify", TEST_USER, BRIDGE_ORG, mockTx, {
      name: "shopify",
      schema: {},
      capabilities: [],
    } as any)
    const r = JSON.parse(await bridge.bulk_iterateJsonl_next("blob-1"))
    expect(r.error?.code).toBe("CAPABILITY_NOT_DECLARED")
  })

  it("bulk_deleteBlob is also capability-gated", async () => {
    const bridge = createRpcBridge("shopify", TEST_USER, BRIDGE_ORG, mockTx, {
      name: "shopify",
      schema: {},
      capabilities: [],
    } as any)
    const r = JSON.parse(await bridge.bulk_deleteBlob("blob-1"))
    expect(r.error?.code).toBe("CAPABILITY_NOT_DECLARED")
  })
})

describe("kernel contacts read affordance (CLUSTER 6, reconcile backstop)", () => {
  function bridgeWithContacts(rows: Array<{ id: string; external_id: unknown }>) {
    const seen: { count: number } = { count: 0 }
    const tx = {
      execute: async () => {
        seen.count += 1
        return rows
      },
      queueEvent: async () => {},
    } as any
    const bridge = createRpcBridge("shopify", "system", BRIDGE_ORG, tx, {
      name: "shopify",
      schema: {},
      capabilities: [],
    } as any)
    return { bridge, seen }
  }

  it("listContactsByExternalId returns the calling app's linked contacts", async () => {
    const { bridge, seen } = bridgeWithContacts([
      { id: "c1", external_id: "gid://shopify/Customer/1" },
      { id: "c2", external_id: "gid://shopify/Customer/2" },
    ])
    const r = JSON.parse(await bridge.listContactsByExternalId(50))
    expect(seen.count).toBe(1)
    expect(r.contacts).toEqual([
      { id: "c1", externalId: "gid://shopify/Customer/1" },
      { id: "c2", externalId: "gid://shopify/Customer/2" },
    ])
    // Page was short (< limit) → no further cursor.
    expect(r.nextCursor).toBeNull()
  })

  it("kernel_findContactsByExternalId exposes the same data (kernel-convention name)", async () => {
    const { bridge } = bridgeWithContacts([{ id: "c1", external_id: "x" }])
    const r = JSON.parse(await bridge.kernel_findContactsByExternalId(50))
    expect(r.contacts).toEqual([{ id: "c1", externalId: "x" }])
  })

  it("returns a keyset nextCursor when a full page is returned", async () => {
    // Limit 2, exactly 2 rows back → cursor = last id.
    const { bridge } = bridgeWithContacts([
      { id: "c1", external_id: "a" },
      { id: "c2", external_id: "b" },
    ])
    const r = JSON.parse(await bridge.listContactsByExternalId(2))
    expect(r.nextCursor).toBe("c2")
  })

  it("coerces a non-string external id to null (defensive)", async () => {
    const { bridge } = bridgeWithContacts([{ id: "c1", external_id: null }])
    const r = JSON.parse(await bridge.listContactsByExternalId(50))
    expect(r.contacts[0].externalId).toBeNull()
  })
})

describe("db field & orderBy validation (CLUSTER 4 hardening)", () => {
  const manifestWithFields = {
    name: "shopify",
    schema: {
      order_cache: {
        fields: { external_id: "string", total: "number", market: "string" },
      },
      schemaless_thing: {}, // declares no fields
    },
    capabilities: [],
  } as any

  it("db_insert rejects writes to an entity that declares no fields", async () => {
    const bridge = createRpcBridge("shopify", TEST_USER, BRIDGE_ORG, mockTx, manifestWithFields)
    await expect(
      bridge.db_insert("schemaless_thing", JSON.stringify({ anything: 1 })),
    ).rejects.toThrow(/declares no fields and is not writable/i)
  })

  it("db_insert rejects an undeclared column on a fielded entity", async () => {
    const bridge = createRpcBridge("shopify", TEST_USER, BRIDGE_ORG, mockTx, manifestWithFields)
    await expect(
      bridge.db_insert("order_cache", JSON.stringify({ secret_internal_col: "x" })),
    ).rejects.toThrow(/Unknown field "secret_internal_col"/i)
  })

  it("db_findMany rejects an undeclared orderBy key", async () => {
    const bridge = createRpcBridge("shopify", TEST_USER, BRIDGE_ORG, mockTx, manifestWithFields)
    await expect(
      bridge.db_findMany("order_cache", JSON.stringify({ orderBy: { secret_col: "desc" } })),
    ).rejects.toThrow(/Unknown orderBy field "secret_col"/i)
  })

  it("db_findMany accepts a declared orderBy key and the implicit id", async () => {
    const tx = { execute: async () => [], queueEvent: async () => {} } as any
    const bridge = createRpcBridge("shopify", TEST_USER, BRIDGE_ORG, tx, manifestWithFields)
    await expect(
      bridge.db_findMany("order_cache", JSON.stringify({ orderBy: { total: "asc", id: "desc" } })),
    ).resolves.toBeDefined()
  })

  it("db_findMany rejects an undeclared select field", async () => {
    const bridge = createRpcBridge("shopify", TEST_USER, BRIDGE_ORG, mockTx, manifestWithFields)
    await expect(
      bridge.db_findMany("order_cache", JSON.stringify({ select: ["total", "secret_col"] })),
    ).rejects.toThrow(/Unknown select field "secret_col"/i)
  })

  it("db_findMany projects exactly the selected declared columns, never SELECT *", async () => {
    // Flatten a drizzle SQL object to its text so the projection is asserted on
    // the statement that reaches Postgres, not on the option that was parsed.
    const sqlText = (q: any): string => {
      if (!q) return ""
      if (Array.isArray(q.queryChunks)) return q.queryChunks.map(sqlText).join("")
      if (Array.isArray(q.value)) return q.value.join("")
      if (typeof q.value === "string") return q.value
      return "?"
    }
    const statements: string[] = []
    const tx = {
      execute: async (q: any) => {
        statements.push(sqlText(q))
        return []
      },
      queueEvent: async () => {},
    } as any
    const bridge = createRpcBridge("shopify", TEST_USER, BRIDGE_ORG, tx, manifestWithFields)
    await bridge.db_findMany(
      "order_cache",
      JSON.stringify({ select: ["id", "external_id", "total"], where: { market: "fr" } }),
    )
    expect(statements.length).toBe(1)
    expect(statements[0]).toMatch(/^SELECT "id", "external_id", "total" FROM /)
    expect(statements[0]).not.toContain("SELECT *")
  })
})

afterEach(() => {
  SandboxBridgeTestAccess.setFetch(null)
})
