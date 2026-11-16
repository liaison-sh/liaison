// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Lookup columns on real Postgres (tables/lookup.ts): the read runs as the READER, once per
// table read per column, through the dashboard source path (its scopes, its cache, its taint).
// A reader who may not run the tool still gets every row, the column empty with a note. A save
// is refused when the saver could not read the lookup; a write naming one is refused. The cache
// runs on a fake store here, as in the dashboards service tests.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { z } from "zod"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { type BlockCacheStore, BlockCacheTestAccess } from "~/modules/dashboards/cache"
import { runSource } from "~/modules/dashboards/execute"
import type { Column } from "~/modules/dashboards/tables/columns"
import {
  createTable,
  listRows,
  READ_SCOPE,
  TableError,
  updateTable,
  WRITE_SCOPE,
  writeRows,
} from "~/modules/dashboards/tables/service"
import { registerDashboardTools } from "~/modules/dashboards/tools"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "lktest"
const STOCK_SCOPE = `${APP}:stock:read`

let orgId = ""
let ownerId = ""
let readerId = ""
let stockCalls = 0

const PRODUCTS = [
  { id: "P-1", sku: "W-1", inventory: { on_hand: "12" } },
  { id: "P-2", sku: "w-2", inventory: { on_hand: 3 } },
  { id: "P-3", sku: "W-2", inventory: { on_hand: 4 } },
]

function fakeStore(): BlockCacheStore {
  const data = new Map<string, string>()
  return {
    async get(k) {
      return data.get(k) ?? null
    },
    async set(k, v) {
      data.set(k, v)
    },
    async increment(k) {
      const n = Number(data.get(k) ?? 0) + 1
      data.set(k, String(n))
      return n
    },
    async setIfAbsent(k) {
      if (data.has(k)) return false
      data.set(k, "1")
      return true
    },
  }
}

async function held(userId: string): Promise<UserContext> {
  const perms = await withSystemDb("lookup-test-perms", (tx) =>
    loadEffectivePermissions(tx as never, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants ?? {},
    roles: perms.roles,
  }
}

const stock = (on: string, extra: Partial<Column["lookup"]> = {}): Column => ({
  key: "stock",
  label: "Stock",
  type: "lookup",
  lookup: {
    source: { tool: `${APP}:stock_read`, params: {}, rowsPath: "products" },
    match: { field: "id", on },
    value: "inventory.on_hand",
    valueType: "number",
    ...extra,
  },
})

const waiting: Column = {
  key: "waiting",
  label: "Waiting",
  type: "lookup",
  lookup: {
    source: { tool: `${APP}:stock_read` },
    match: { field: "sku", on: "code" },
    value: "inventory.on_hand",
    valueType: "number",
  },
}

/** A table of three items (two linked to a product, one without), shared with the org. */
async function itemsTable(): Promise<string> {
  const owner = await held(ownerId)
  const t = await createTable(owner, {
    name: `Stock ${crypto.randomUUID().slice(0, 6)}`,
    columns: [
      { key: "name", label: "Name", type: "text" },
      { key: "product", label: "Product", type: "link", linkTo: { app: APP } },
      { key: "code", label: "Code", type: "text" },
      stock("product"),
      waiting,
    ],
    orgAccess: "viewer",
  })
  const link = (id: string) => ({ app: APP, entityType: "product", id, label: id })
  await writeRows(owner, t.id, [
    { op: "add", cells: { name: "Widget", product: link("P-1"), code: "W-1" } },
    { op: "add", cells: { name: "Panel", product: link("P-2"), code: "W-2" } },
    { op: "add", cells: { name: "Spare part" } },
  ])
  return t.id
}

const byName = (rows: { cells: Record<string, unknown> }[]) =>
  Object.fromEntries(rows.map((r) => [String(r.cells.name), r.cells]))

beforeAll(async () => {
  await acquireTestLock()
  const org = await minimal.secondOrg({ name: "Lookup Columns Org" })
  orgId = org.orgId
  ownerId = (await minimal.person(orgId, { name: "Stock Owner" })).id
  readerId = (await minimal.person(orgId, { name: "Plain Reader" })).id
  for (const scope of [READ_SCOPE, WRITE_SCOPE, STOCK_SCOPE])
    await minimal.grantScope(ownerId, scope)
  await minimal.grantScope(readerId, READ_SCOPE)
  toolRegistry.set([orgId, APP, "stock_read"], {
    appName: APP,
    name: "stock_read",
    description: "Read the products' stock",
    requiredScopes: [STOCK_SCOPE],
    readOnly: true,
    params: z.object({}).passthrough(),
    handler: async () => {
      stockCalls++
      return { products: PRODUCTS }
    },
  })
  registerDashboardTools(orgId)
  await registerKernelAgentTools(orgId)
}, 60_000)

afterEach(() => BlockCacheTestAccess.setStore(null))
afterAll(releaseTestLock)

describe("reading a table with lookup columns", () => {
  it("joins the tool's rows to each row: a link by id, a code by text, several rows added up", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await itemsTable()
    const before = stockCalls
    const page = await listRows(await held(ownerId), id)
    expect(page.columnNotes).toBeUndefined()
    const cells = byName(page.rows)
    expect(cells.Widget).toMatchObject({ stock: 12, waiting: 12 })
    expect(cells.Panel).toMatchObject({ stock: 3, waiting: 7 })
    expect(cells["Spare part"]?.stock).toBeUndefined()
    expect(cells["Spare part"]?.waiting).toBeUndefined()
    // Two columns of one tool and params differ in their source (rowsPath): two reads, once each.
    expect(stockCalls - before).toBe(2)
    // A second read within the cache's life runs no tool.
    const again = await listRows(await held(ownerId), id)
    expect(byName(again.rows).Panel).toMatchObject({ stock: 3, waiting: 7 })
    expect(stockCalls - before).toBe(2)
  })

  it("a reader who may not run the tool gets every row, the column empty with a note", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await itemsTable()
    const before = stockCalls
    const page = await listRows(await held(readerId), id)
    expect(page.rows).toHaveLength(3)
    for (const r of page.rows) {
      expect(r.cells.stock).toBeUndefined()
      expect(r.cells.waiting).toBeUndefined()
    }
    expect(page.columnNotes?.stock).toContain(STOCK_SCOPE)
    expect(page.columnNotes?.waiting).toContain(STOCK_SCOPE)
    expect(stockCalls).toBe(before)
  })

  it("a table block source reads the lookup cells as the viewer", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await itemsTable()
    const out = await runSource(
      { kind: "table", table: id, where: {} },
      { viewer: await held(ownerId), dashboardId: null },
      { blockId: "stock" },
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const rows = Object.fromEntries((out.read.rows ?? []).map((r) => [String(r.name), r]))
    expect(rows.Panel).toMatchObject({ stock: 3, waiting: 7 })
    expect(out.read.fieldLabels?.stock).toBe("Stock")
  })

  it("refuses to filter or sort on a lookup column", async () => {
    const id = await itemsTable()
    const owner = await held(ownerId)
    await expect(listRows(owner, id, { sort: "stock" })).rejects.toThrow("lookup column")
    await expect(listRows(owner, id, { where: { stock: 3 } })).rejects.toThrow("lookup column")
  })
})

describe("an agent's read of a lookup column", () => {
  async function agentRead(userId: string, tableId: string) {
    const actor = await held(userId)
    const accumulator = createTurnScopeAccumulator({ orgId })
    const runId = crypto.randomUUID()
    const threadId = await minimal.thread(orgId, userId, { title: `lookup ${runId}` })
    const frame: RunContext = {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      humanTurn: true,
      effectiveScope: actor.scopes,
      turnScopeAccumulator: accumulator,
    }
    const result = await runContextStore.run(frame, () =>
      executeTool({
        toolName: "kernel:tables_query",
        orgId,
        actor,
        params: { tableId },
        threadId,
        origin: "in-app-agent",
        stepBundleId: null,
      }),
    )
    return { result, taint: accumulator.snapshot() }
  }

  it("taints the turn as calling the tool would, a cached read too", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await itemsTable()
    const first = await agentRead(ownerId, id)
    expect(JSON.stringify(first.result)).toContain('"waiting":7')
    expect(first.taint).toContain(STOCK_SCOPE)
    const before = stockCalls
    const cached = await agentRead(ownerId, id)
    expect(stockCalls).toBe(before)
    expect(cached.taint).toContain(STOCK_SCOPE)
  })

  it("tells the agent why a column is empty", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await itemsTable()
    const { result, taint } = await agentRead(readerId, id)
    const text = JSON.stringify(result)
    expect(text).toContain("columnNotes")
    expect(text).toContain("Spare part")
    expect(taint).not.toContain(STOCK_SCOPE)
  })
})

describe("saving and writing a lookup column", () => {
  it("refuses a tool that is no source of this workspace, or one the saver may not run", async () => {
    const owner = await held(ownerId)
    const base = [{ key: "product", label: "Product", type: "link" }]
    const missing = stock("product", { source: { tool: `${APP}:nope_read` } })
    await expect(
      createTable(owner, {
        name: `Bad ${crypto.randomUUID().slice(0, 6)}`,
        columns: [...base, missing],
      }),
    ).rejects.toThrow("not a tool of this workspace")
    const writer = await held(readerId)
    await expect(
      createTable(
        { ...writer, scopes: [...writer.scopes, WRITE_SCOPE] },
        { name: `Bad ${crypto.randomUUID().slice(0, 6)}`, columns: [...base, stock("product")] },
      ),
    ).rejects.toThrow(STOCK_SCOPE)
    await expect(
      createTable(owner, {
        name: `Bad ${crypto.randomUUID().slice(0, 6)}`,
        columns: [...base, stock("nowhere")],
      }),
    ).rejects.toThrow("is not a column of this table")
  })

  it("refuses a write naming it, and dropping the column it matches on", async () => {
    const id = await itemsTable()
    const owner = await held(ownerId)
    const [row] = (await listRows(owner, id)).rows
    await expect(
      writeRows(owner, id, [
        { op: "update", id: row!.id, ifVersion: row!.version, cells: { stock: 5 } },
      ]),
    ).rejects.toThrow("cannot be written")
    const info = (await listRows(owner, id)).rows.length
    expect(info).toBe(3)
    const err = await updateTable(owner, id, { ifVersion: 1, columns: { drop: ["code"] } }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(TableError)
    expect((err as TableError).message).toContain("matches on 'code'")
  })
})
