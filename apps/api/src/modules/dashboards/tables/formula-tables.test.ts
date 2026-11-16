// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Formula columns on real Postgres: a row read computes them after the lookup values are in
// (stock - sold + cumsum(expected), a lookup and a months column), in the grid's read, an
// agent's kernel__tables_query and a table block source; tables_get gives a months-shaped
// formula its window; a save refuses unknown keys, text columns and cycles; a write, a filter
// or a sort naming one is refused. The lookup's cache runs on a fake store.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { z } from "zod"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { type BlockCacheStore, BlockCacheTestAccess } from "~/modules/dashboards/cache"
import { runSource } from "~/modules/dashboards/execute"
import { dayIn } from "~/modules/dashboards/relative-dates"
import { monthWindow } from "~/modules/dashboards/tables/columns"
import {
  createTable,
  getTable,
  listRows,
  READ_SCOPE,
  updateTable,
  WRITE_SCOPE,
  writeRows,
} from "~/modules/dashboards/tables/service"
import { registerDashboardTools } from "~/modules/dashboards/tools"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "fmtest"
const ORDERS_SCOPE = `${APP}:orders:read`

let orgId = ""
let ownerId = ""

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

async function held(): Promise<UserContext> {
  const perms = await withSystemDb("formula-test-perms", (tx) =>
    loadEffectivePermissions(tx as never, ownerId, orgId),
  )
  return {
    actorType: "user",
    userId: ownerId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants ?? {},
    roles: perms.roles,
  }
}

const COLUMNS = [
  { key: "item", label: "Item", type: "text" },
  { key: "code", label: "Code", type: "text" },
  { key: "stock", label: "Stock", type: "number" },
  {
    key: "sold",
    label: "Sold, not shipped",
    type: "lookup",
    lookup: {
      source: { tool: `${APP}:orders_read`, rowsPath: "orders" },
      match: { field: "sku", on: "code" },
      value: "qty",
      valueType: "number",
    },
  },
  { key: "expected", label: "Expected", type: "months", horizon: 3 },
  {
    key: "free",
    label: "Free",
    type: "formula",
    formula: { expr: "stock - sold" },
    emphasis: "negative",
  },
  {
    key: "projected",
    label: "Projected",
    type: "formula",
    formula: { expr: "free + cumsum(expected)" },
    horizon: 3,
    emphasis: "negative",
  },
]

let current = ""
let window: string[] = []

async function stockTable(): Promise<string> {
  const owner = await held()
  const t = await createTable(owner, {
    name: `Stock ${crypto.randomUUID().slice(0, 6)}`,
    columns: COLUMNS,
  })
  await writeRows(owner, t.id, [
    {
      op: "add",
      cells: {
        item: "Widget",
        code: "W-1",
        stock: 5,
        expected: { [window[0]!]: 10, [window[2]!]: 4 },
      },
    },
    { op: "add", cells: { item: "Display panel", code: "D-1", stock: 2 } },
    { op: "add", cells: { item: "Spare", code: "S-1" } },
  ])
  return t.id
}

const byItem = (rows: { cells: Record<string, unknown> }[]) =>
  Object.fromEntries(rows.map((r) => [String(r.cells.item), r.cells]))

beforeAll(async () => {
  await acquireTestLock()
  const org = await minimal.secondOrg({ name: "Formula Columns Org" })
  orgId = org.orgId
  ownerId = (await minimal.person(orgId, { name: "Formula Owner" })).id
  for (const scope of [READ_SCOPE, WRITE_SCOPE, ORDERS_SCOPE])
    await minimal.grantScope(ownerId, scope)
  toolRegistry.set([orgId, APP, "orders_read"], {
    appName: APP,
    name: "orders_read",
    description: "Units sold, not shipped yet",
    requiredScopes: [ORDERS_SCOPE],
    readOnly: true,
    params: z.object({}).passthrough(),
    handler: async () => ({
      orders: [
        { sku: "W-1", qty: 8 },
        { sku: "S-1", qty: 1 },
      ],
    }),
  })
  registerDashboardTools(orgId)
  await registerKernelAgentTools(orgId)
  // The org has no timezone set: its months are UTC's.
  current = dayIn("UTC", new Date()).slice(0, 7)
  window = monthWindow({ horizon: 3 }, current)
}, 60_000)

afterEach(() => BlockCacheTestAccess.setStore(null))
afterAll(releaseTestLock)

describe("reading a table with formula columns", () => {
  it("computes after the lookup: a number, and months with cumsum over the formula's window", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await stockTable()
    const cells = byItem((await listRows(await held(), id)).rows)
    // Widget: 5 - 8 = -3; projected -3 + 10, + 0, + 4.
    expect(cells.Widget?.free).toBe(-3)
    expect(cells.Widget?.projected).toEqual({
      [window[0]!]: 7,
      [window[1]!]: 7,
      [window[2]!]: 11,
    })
    // Display panel: no sold value (no matching order) -> both empty; never a wrong number.
    expect(cells["Display panel"]?.free).toBeUndefined()
    expect(cells["Display panel"]?.projected).toBeUndefined()
    // Spare: no stock -> empty.
    expect(cells.Spare?.free).toBeUndefined()
  })

  it("tables_get gives the months-shaped formula its window, the number one none", async () => {
    const info = await getTable(await held(), await stockTable())
    const col = (k: string) => info.columns.find((c) => c.key === k)
    expect(col("projected")?.months).toEqual(window)
    expect(col("free")?.months).toBeUndefined()
  })

  it("an agent's tables_query and a table block source read the computed cells", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await stockTable()
    const owner = await held()
    const threadId = await minimal.thread(orgId, ownerId, { title: "formula read" })
    const read = await executeTool<{ rows: Array<{ cells: Record<string, unknown> }> }>({
      toolName: "kernel:tables_query",
      orgId,
      actor: owner,
      params: { tableId: id },
      threadId,
      origin: "in-app-agent",
      stepBundleId: null,
    })
    expect(JSON.stringify(read)).toContain('"free":-3')
    const out = await runSource(
      { kind: "table", table: id, where: {} },
      { viewer: owner, dashboardId: null },
      { blockId: "stock" },
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const rows = Object.fromEntries((out.read.rows ?? []).map((r) => [String(r.item), r]))
    expect(rows.Widget).toMatchObject({ free: -3, projected: { [window[2]!]: 11 } })
  })

  it("refuses to filter, sort on or write a formula column", async () => {
    const id = await stockTable()
    const owner = await held()
    await expect(listRows(owner, id, { sort: "free" })).rejects.toThrow("formula column")
    await expect(listRows(owner, id, { where: { free: 3 } })).rejects.toThrow("formula column")
    const [row] = (await listRows(owner, id)).rows
    await expect(
      writeRows(owner, id, [
        { op: "update", id: row!.id, ifVersion: row!.version, cells: { free: 5 } },
      ]),
    ).rejects.toThrow("formula column")
  })
})

describe("saving a formula column", () => {
  it("refuses an unknown key, a text column, a cycle and a syntax error", async () => {
    const owner = await held()
    const save = (expr: string, extra: unknown[] = []) =>
      createTable(owner, {
        name: `Bad ${crypto.randomUUID().slice(0, 6)}`,
        columns: [
          { key: "item", label: "Item", type: "text" },
          { key: "stock", label: "Stock", type: "number" },
          { key: "f", label: "F", type: "formula", formula: { expr } },
          ...extra,
        ],
      })
    await expect(save("stock - nope")).rejects.toThrow("'nope' is not a column of this table")
    await expect(save("stock + item")).rejects.toThrow("'item' is a text column")
    await expect(save("stock +")).rejects.toThrow("ends too early")
    await expect(
      save("g + 1", [{ key: "g", label: "G", type: "formula", formula: { expr: "f * 2" } }]),
    ).rejects.toThrow("in a circle")
  })

  it("refuses dropping a column a formula reads; adds a formula to an existing table", async () => {
    const owner = await held()
    const id = await stockTable()
    await expect(
      updateTable(owner, id, { ifVersion: 1, columns: { drop: ["stock"] } }),
    ).rejects.toThrow("'stock' is not a column of this table")
    const info = await updateTable(owner, id, {
      ifVersion: 1,
      columns: {
        add: [{ key: "double", label: "Double", type: "formula", formula: { expr: "stock * 2" } }],
      },
    })
    expect(info.columns.find((c) => c.key === "double")?.formula?.expr).toBe("stock * 2")
    BlockCacheTestAccess.setStore(fakeStore())
    expect(byItem((await listRows(owner, id)).rows).Widget?.double).toBe(10)
  })
})
