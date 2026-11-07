// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's data store tools (modules/data-store/tools.ts) on real Postgres:
// the tools' scopes, reads reaching declared agent-readable collections only and
// each under its own read scope (a caller with kernel:data:read alone sees no
// app collection), the read tainting the turn with that scope, and writes
// reaching the agent's own namespace only.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import { withRlsContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { appStoreDeclarationsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { getDocument, setDocument } from "~/modules/data-store/service"
import {
  DataToolParams,
  handleDataCollectionsList,
  handleDataDelete,
  handleDataGet,
  handleDataQuery,
  handleDataSet,
  handleDataUpdate,
  registerDataStoreTools,
  SINK_KERNEL_APP_DOCUMENTS,
} from "~/modules/data-store/tools"
import { LiveIndexTestAccess } from "~/modules/search/live-index-queue"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "storetools"
const ORDERS_SCOPE = `${APP}:orders:read`
const DATA_READ = "kernel:data:read"

let ORG = ""
let USER = ""

function inOrg<T>(fn: (tx: RlsClient) => Promise<T>): Promise<T> {
  return withRlsContext(
    { actorType: "user", userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
    fn,
  )
}

/** Run a handler as a caller holding `scopes`, in a turn frame; returns the result and the turn's taint. */
async function call<P, R>(
  handler: (
    params: P,
    ctx: { orgId: string; userId: string; db: RlsClient; scopes: string[] },
  ) => Promise<R>,
  params: P,
  scopes: string[],
): Promise<{ result: R; taint: string[] }> {
  const runId = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator()
  const frame: RunContext = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator,
    discoveredTools: new Set<string>(),
  }
  const result = await runContextStore.run(frame, () =>
    inOrg((db) => handler(params, { orgId: ORG, userId: USER, db, scopes })),
  )
  return { result, taint: [...turnScopeAccumulator.snapshot()] }
}

beforeAll(async () => {
  await acquireTestLock()
  const org = await minimal.secondOrg({ name: "Store Tools Org" })
  ORG = org.orgId
  USER = org.adminUserId
  appStoreDeclarationsRegistry.set([ORG, APP], {
    orders: {
      readScope: ORDERS_SCOPE,
      searchable: { labelField: "title", fields: ["title", "customer"] },
      agentReadable: true,
    },
    // Declared but not for the agent: the app's own view reads it, tools do not.
    ledger: { readScope: ORDERS_SCOPE },
  })
  const app = { orgId: ORG, app: APP, userId: null }
  await inOrg(async (tx) => {
    await setDocument(tx, app, "orders", "o1", { title: "Order one", total: 120 })
    await setDocument(tx, app, "orders", "o2", { title: "Order two", total: 80 })
    await setDocument(tx, app, "ledger", "l1", { title: "Private ledger line" })
    // Undeclared: the app's own sync state.
    await setDocument(tx, app, "sync_state", "cursor", { cursor: "abc" })
  })
})

afterEach(() => {
  toolRegistry.deleteByPrefix([ORG])
})

afterAll(async () => {
  appStoreDeclarationsRegistry.deleteByPrefix([ORG])
  // The writes above queued search requests; nothing flushes them here.
  await LiveIndexTestAccess.clear()
  await releaseTestLock()
})

describe("registration", () => {
  it("registers the read tools under kernel:data:read and the writes under kernel:data:write", () => {
    registerDataStoreTools(ORG)
    const scopes = (name: string) => toolRegistry.get([ORG, "kernel", name])?.requiredScopes
    for (const name of ["data_collections_list", "data_query", "data_get"]) {
      expect(scopes(name)).toEqual([DATA_READ])
      expect(toolRegistry.get([ORG, "kernel", name])?.readOnly).toBe(true)
    }
    expect(toolRegistry.get([ORG, "kernel", "data_query"])?.taintSource).toBe(true)
    expect(toolRegistry.get([ORG, "kernel", "data_get"])?.taintSource).toBe(true)
    for (const name of ["data_set", "data_update", "data_delete"]) {
      const def = toolRegistry.get([ORG, "kernel", name])
      expect(def?.requiredScopes).toEqual(["kernel:data:write"])
      expect(def?.writesToTable).toBe(SINK_KERNEL_APP_DOCUMENTS)
      expect(def?.sinkReadScope).toBe(DATA_READ)
    }
  })
})

describe("reads", () => {
  it("lists only declared agent-readable collections whose read scope the caller holds", async () => {
    await inOrg((tx) =>
      setDocument(tx, { orgId: ORG, app: "agent", userId: USER }, "notes", "n1", {
        title: "A note",
      }),
    )
    const full = await call(handleDataCollectionsList, {}, [DATA_READ, ORDERS_SCOPE])
    const names = (r: typeof full.result) =>
      "collections" in r ? r.collections.map((c) => `${c.app}/${c.collection}`) : []
    expect(names(full.result)).toEqual([`${APP}/orders`, "agent/notes"])
    const ordersRow = "collections" in full.result ? full.result.collections[0] : null
    expect(ordersRow?.docs).toBe(2)

    const bare = await call(handleDataCollectionsList, {}, [DATA_READ])
    expect(names(bare.result)).toEqual(["agent/notes"])
  })

  it("refuses a collection whose read scope the caller lacks, and taints nothing", async () => {
    const q = await call(handleDataQuery, { app: APP, collection: "orders" }, [DATA_READ])
    expect(q.result).toMatchObject({ error: { code: "not_found" } })
    expect(q.taint).toEqual([])
    const g = await call(handleDataGet, { app: APP, collection: "orders", id: "o1" }, [DATA_READ])
    expect(g.result).toMatchObject({ error: { code: "not_found" } })
  })

  it("reads a readable collection and taints the turn with its read scope", async () => {
    const q = await call(
      handleDataQuery,
      { app: APP, collection: "orders", query: { where: { total: { gte: 100 } } } },
      [DATA_READ, ORDERS_SCOPE],
    )
    expect("items" in q.result ? q.result.items.map((i) => i.id) : null).toEqual(["o1"])
    expect(q.taint).toContain(ORDERS_SCOPE)

    const g = await call(handleDataGet, { app: APP, collection: "orders", id: "o2" }, [
      DATA_READ,
      ORDERS_SCOPE,
    ])
    expect(g.result).toMatchObject({ document: { id: "o2", data: { title: "Order two" } } })
    expect(g.taint).toContain(ORDERS_SCOPE)
  })

  it("never reaches an undeclared collection or one not declared agent-readable", async () => {
    const scopes = [DATA_READ, ORDERS_SCOPE, `${APP}:*`]
    for (const collection of ["sync_state", "ledger"]) {
      const q = await call(handleDataQuery, { app: APP, collection }, scopes)
      expect(q.result).toMatchObject({ error: { code: "not_found" } })
    }
    const g = await call(
      handleDataGet,
      { app: APP, collection: "sync_state", id: "cursor" },
      scopes,
    )
    expect(g.result).toMatchObject({ error: { code: "not_found" } })
  })
})

describe("writes", () => {
  it("write params take no app: an app key is refused by the schema", () => {
    expect(
      DataToolParams.set.safeParse({ app: APP, collection: "orders", id: "x", data: {} }).success,
    ).toBe(false)
    expect(
      DataToolParams.update.safeParse({ app: APP, collection: "orders", id: "o1", patch: {} })
        .success,
    ).toBe(false)
    expect(
      DataToolParams.delete.safeParse({ app: APP, collection: "orders", id: "o1" }).success,
    ).toBe(false)
    expect(DataToolParams.set.safeParse({ collection: "notes", id: "x", data: {} }).success).toBe(
      true,
    )
  })

  it("cannot write another app's collection, even past the schema", async () => {
    const scopes = ["kernel:data:write"]
    const set = await call(
      handleDataSet,
      { app: APP, collection: "orders", id: "o1", data: { title: "Hijacked" } },
      scopes,
    )
    expect(set.result).toMatchObject({ error: { code: "not_allowed" } })
    const del = await call(handleDataDelete, { app: APP, collection: "orders", id: "o1" }, scopes)
    expect(del.result).toMatchObject({ error: { code: "not_allowed" } })
    const upd = await call(
      handleDataUpdate,
      { app: APP, collection: "orders", id: "o1", patch: { title: "x" } },
      scopes,
    )
    expect(upd.result).toMatchObject({ error: { code: "not_allowed" } })
    const still = await inOrg((tx) =>
      getDocument(tx, { orgId: ORG, app: APP, userId: null }, "orders", "o1"),
    )
    expect(still?.data.title).toBe("Order one")
  })

  it("writes, merges, version-checks and deletes in the agent's own namespace", async () => {
    const scopes = ["kernel:data:write"]
    const set = await call(
      handleDataSet,
      { collection: "leads", id: "acme", data: { title: "Acme", stage: "new" } },
      scopes,
    )
    expect(set.result).toMatchObject({ document: { id: "acme", version: 1 } })
    const upd = await call(
      handleDataUpdate,
      { collection: "leads", id: "acme", patch: { stage: "won" }, ifVersion: 1 },
      scopes,
    )
    expect(upd.result).toMatchObject({
      document: { version: 2, data: { title: "Acme", stage: "won" } },
    })
    const stale = await call(
      handleDataUpdate,
      { collection: "leads", id: "acme", patch: { stage: "lost" }, ifVersion: 1 },
      scopes,
    )
    expect(stale.result).toMatchObject({ error: { code: "version_conflict" } })
    const stored = await inOrg((tx) =>
      getDocument(tx, { orgId: ORG, app: "agent", userId: null }, "leads", "acme"),
    )
    expect(stored?.data.stage).toBe("won")
    const del = await call(handleDataDelete, { collection: "leads", id: "acme" }, scopes)
    expect(del.result).toEqual({ deleted: true })
  })
})
