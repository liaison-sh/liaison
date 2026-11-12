// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared datasets, filters and drill-down on real Postgres (the cache on a fake store):
// blocks of one dataset run its source once, together or one after the other; a filter value
// a param reads is a new key, a where-only filter runs nothing; the rows behind a figure come
// from the same cached read and keep the block's access; a filter's options; each person's
// remembered filter values; edit operations on datasets and filters.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import type { UserContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import {
  type BlockCacheStore,
  BlockCacheTestAccess,
  CUSTOM_WINDOW_RUNS,
} from "~/modules/dashboards/cache"
import { checkRecipients } from "~/modules/dashboards/export"
import {
  createDashboard,
  type DashboardError,
  editDashboard,
  getBlockData,
  getBlockRows,
  getDashboard,
  getFilterOptions,
  getViewerRange,
  setViewerRange,
} from "~/modules/dashboards/service"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "dshstep2"
const READ = `${APP}:orders:read`
const WRITE = "kernel:dashboards:write"

let orgId = ""
let owner = ""
let other = ""
/** The params of each run of the orders tool. */
const runs: Record<string, unknown>[] = []

const ORDERS = [
  { id: "o1", day: "2026-11-01", total: "10", market: "FR", channel: "b2b", secret: "x" },
  { id: "o2", day: "2026-11-01", total: "5", market: "DE", channel: "dtc", secret: "x" },
  { id: "o3", day: "2026-11-02", total: "20", market: "FR", channel: "dtc", secret: "x" },
  { id: "o4", day: "2026-11-03", total: "1", market: "US", channel: "b2b", secret: "x" },
]

const as = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId,
  scopes,
  dimensionGrants: {},
})

function fakeStore(): BlockCacheStore {
  const data = new Map<string, string>()
  return {
    async get(k) {
      return data.get(k) ?? null
    },
    async set(k, v) {
      data.set(k, v)
    },
    async setIfAbsent(k) {
      if (data.has(k)) return false
      data.set(k, "1")
      return true
    },
    async increment(k) {
      const n = Number(data.get(k) ?? 0) + 1
      data.set(k, String(n))
      return n
    },
  }
}

const SOURCE = {
  kind: "tool",
  tool: `${APP}:orders_read`,
  params: { market: "{{filter.market}}" },
}

const SPEC = {
  v: 1,
  datasets: { orders: SOURCE },
  filters: [
    {
      id: "market",
      label: "Market",
      type: "select",
      options: { fromDataset: "orders", field: "market" },
    },
    { id: "channel", label: "Channel", type: "multi", options: ["b2b", "dtc"] },
  ],
  blocks: [
    {
      id: "count",
      type: "metric",
      title: "Orders",
      dataset: "orders",
      map: { agg: "count", where: [{ field: "channel", op: "eq", value: { filter: "channel" } }] },
    },
    {
      id: "by-market",
      type: "bar",
      title: "By market",
      dataset: "orders",
      map: { x: "market", y: "total", link: "/orders/{{id}}" },
    },
    {
      id: "list",
      type: "table",
      title: "List",
      dataset: "orders",
      map: {
        columns: [{ field: "id", label: "Order" }],
        sort: { field: "total", dir: "desc" },
        link: { entity: "order", idField: "id" },
      },
    },
    { id: "note", type: "text", title: "Notes", text: "**B2B** = tagged b2b" },
  ],
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Dashboards Step2 Org" })).orgId
  owner = (await minimal.person(orgId)).id
  other = (await minimal.person(orgId)).id
  toolRegistry.set([orgId, APP, "orders_read"], {
    appName: APP,
    name: "orders_read",
    description: "Read orders",
    requiredScopes: [READ],
    readOnly: true,
    params: z.object({ market: z.string().optional() }),
    handler: async (p: unknown) => {
      const market = (p as { market?: string }).market
      runs.push(p as Record<string, unknown>)
      // A little wait, so blocks loaded together overlap.
      await new Promise((r) => setTimeout(r, 30))
      return { items: market ? ORDERS.filter((o) => o.market === market) : ORDERS }
    },
  })
})

afterEach(() => BlockCacheTestAccess.setStore(null))

afterAll(async () => {
  await releaseTestLock()
})

async function dashboard(spec: unknown = SPEC) {
  return (
    await createDashboard(as(owner, [WRITE, READ]), {
      title: "Step 2",
      visibility: "personal",
      spec,
    })
  ).id
}

describe("shared datasets", () => {
  it("blocks of one dataset run its source once, loaded together or one after the other", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await dashboard()
    const viewer = as(owner, [WRITE, READ])
    runs.length = 0
    const [count, bars, list] = await Promise.all([
      getBlockData(viewer, id, "count"),
      getBlockData(viewer, id, "by-market"),
      getBlockData(viewer, id, "list"),
    ])
    expect(runs).toHaveLength(1)
    expect(runs[0]).toEqual({}) // the empty filter dropped its param
    expect(count).toMatchObject({ ok: true, data: { kind: "metric", value: 4 } })
    expect(bars).toMatchObject({ ok: true, data: { labels: ["FR", "DE", "US"] } })
    expect(list).toMatchObject({
      ok: true,
      data: {
        kind: "table",
        rows: [{ id: "o3" }, { id: "o1" }, { id: "o2" }, { id: "o4" }],
        links: [
          { kind: "entity", app: APP, entityType: "order", id: "o3" },
          { kind: "entity", app: APP, entityType: "order", id: "o1" },
          { kind: "entity", app: APP, entityType: "order", id: "o2" },
          { kind: "entity", app: APP, entityType: "order", id: "o4" },
        ],
      },
    })
    await getBlockData(viewer, id, "count")
    expect(runs).toHaveLength(1)
    // Refresh all: the second block's refresh reuses the first's run.
    await getBlockData(viewer, id, "count", { refresh: true })
    await getBlockData(viewer, id, "list", { refresh: true })
    expect(runs).toHaveLength(2)
  })

  it("a layout or title edit never runs the source again; a map that reads a new field does", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await dashboard()
    const viewer = as(owner, [WRITE, READ])
    runs.length = 0
    await getBlockData(viewer, id, "count")
    expect(runs).toHaveLength(1)
    let version = (await getDashboard(viewer, id)).version
    for (const operations of [
      [{ op: "resizeBlock", blockId: "by-market", width: 2, height: 2 }],
      [{ op: "moveBlock", blockId: "list", position: 0 }],
      [{ op: "setTitle", title: "Renamed" }],
      [{ op: "updateBlock", blockId: "count", changes: { title: "All orders" } }],
    ] as const) {
      version = (
        await editDashboard(viewer, id, { ifVersion: version, operations: [...operations] })
      ).version
      expect(await getBlockData(viewer, id, "count")).toMatchObject({ ok: true, cached: true })
    }
    expect(runs).toHaveLength(1)
    // A map reading a field the cached rows do not keep is a new read.
    await editDashboard(viewer, id, {
      ifVersion: version,
      operations: [
        {
          op: "updateBlock",
          blockId: "list",
          changes: { map: { columns: [{ field: "secret", label: "S" }] } },
        },
      ],
    })
    await getBlockData(viewer, id, "list")
    expect(runs).toHaveLength(2)
  })

  it("a text block reads nothing", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await dashboard()
    runs.length = 0
    expect(await getBlockData(as(owner, [WRITE, READ]), id, "note")).toMatchObject({
      ok: true,
      data: { kind: "text", markdown: "**B2B** = tagged b2b" },
      window: { mode: "fixed", dates: [] },
    })
    expect(runs).toHaveLength(0)
  })
})

describe("filters", () => {
  it("a value a param reads is a new run; a where-only filter runs nothing", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await dashboard()
    const viewer = as(owner, [WRITE, READ])
    runs.length = 0
    expect(await getBlockData(viewer, id, "count", { filters: { market: ["FR"] } })).toMatchObject({
      data: { value: 2 },
    })
    expect(runs).toEqual([{ market: "FR" }])
    expect(
      await getBlockData(viewer, id, "count", { filters: { market: ["FR"], channel: ["b2b"] } }),
    ).toMatchObject({ cached: true, data: { value: 1, meta: { filteredRows: 1 } } })
    expect(runs).toHaveLength(1)
    await getBlockData(viewer, id, "count", { filters: { market: ["DE"] } })
    expect(runs).toHaveLength(2)
  })

  it("new filter values a param reads count toward the per-minute budget; a where-only one never", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await dashboard()
    const viewer = as(owner, [WRITE, READ])
    const outcomes: unknown[] = []
    for (let i = 0; i < CUSTOM_WINDOW_RUNS + 1; i++) {
      outcomes.push(await getBlockData(viewer, id, "count", { filters: { market: [`M${i}`] } }))
    }
    expect(outcomes.slice(0, CUSTOM_WINDOW_RUNS).every((o) => (o as { ok: boolean }).ok)).toBe(true)
    expect(outcomes[CUSTOM_WINDOW_RUNS]).toMatchObject({ ok: false, error: "rate_limited" })
    // A where-only filter, and the default values, read the cache or run unbudgeted.
    expect(
      await getBlockData(viewer, id, "count", { filters: { channel: ["b2b"] } }),
    ).toMatchObject({ ok: true })
  })

  it("refuses an unknown filter or a value outside its list", async () => {
    const id = await dashboard()
    const viewer = as(owner, [WRITE, READ])
    for (const filters of [{ nope: ["x"] }, { channel: ["retail"] }] as Record<
      string,
      string[]
    >[]) {
      const err = await getBlockData(viewer, id, "count", { filters }).catch((e: unknown) => e)
      expect((err as DashboardError).code).toBe("INVALID_REQUEST")
    }
  })

  it("lists a filter's options from its dataset, its own value left out", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await dashboard()
    const viewer = as(owner, [WRITE, READ])
    expect(await getFilterOptions(viewer, id, "market", { filters: { market: ["FR"] } })).toEqual({
      filterId: "market",
      ok: true,
      options: ["DE", "FR", "US"],
      truncated: false,
    })
    expect(await getFilterOptions(viewer, id, "channel", { q: "B2" })).toMatchObject({
      options: ["b2b"],
    })
    // As someone who may not read the source: refused, never listed.
    expect(await getFilterOptions(as(owner, [WRITE]), id, "market")).toMatchObject({
      ok: false,
      error: "no_access",
    })
  })

  it("each person's filter values are remembered apart from their range", async () => {
    const id = await dashboard()
    const mine = as(owner, [WRITE, READ])
    await setViewerRange(mine, id, { filters: { market: ["DE"], channel: ["b2b", "dtc"] } })
    expect(await getViewerRange(mine, id)).toEqual({
      timeRange: null,
      compare: null,
      filters: { market: ["DE"], channel: ["b2b", "dtc"] },
    })
    const view = await getDashboard(mine, id)
    expect(view.filters).toEqual({
      values: { market: ["DE"], channel: ["b2b", "dtc"] },
      saved: true,
    })
    expect(view.range.saved).toBe(false)
    await setViewerRange(mine, id, { timeRange: { preset: "mtd" }, compare: "none" })
    expect(await getViewerRange(mine, id)).toMatchObject({
      timeRange: { preset: "mtd" },
      filters: { market: ["DE"] },
    })
  })
})

describe("budget and remembered state", () => {
  it("a read too large to cache counts toward the budget on every run after the first", async () => {
    // Redis down for writes: no result is kept, so each read runs again and is budgeted.
    const store = fakeStore()
    BlockCacheTestAccess.setStore({ ...store, set: async () => Promise.reject(new Error("down")) })
    BlockCacheTestAccess.resetLocal()
    const id = await dashboard()
    const viewer = as(owner, [WRITE, READ])
    runs.length = 0
    const outcomes: unknown[] = []
    for (let i = 0; i < CUSTOM_WINDOW_RUNS + 3; i++) {
      outcomes.push(await getBlockData(viewer, id, "by-market"))
    }
    expect(runs).toHaveLength(CUSTOM_WINDOW_RUNS + 1)
    expect(outcomes.at(-1)).toMatchObject({ ok: false, error: "rate_limited" })
    BlockCacheTestAccess.resetLocal()
  })

  it("refuses filter values too long to remember, and keeps a comparison remembered alone", async () => {
    const id = await dashboard({
      ...SPEC,
      filters: [
        ...SPEC.filters,
        ...["sku", "ref"].map((fid) => ({
          id: fid,
          label: fid,
          type: "multi",
          options: { fromDataset: "orders", field: "id" },
        })),
      ],
    })
    const mine = as(owner, [WRITE, READ])
    const sku = Array.from(
      { length: 50 },
      (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(197)}`,
    )
    const err = await setViewerRange(mine, id, { filters: { sku, ref: sku } }).catch(
      (e: unknown) => e,
    )
    expect((err as DashboardError).code).toBe("INVALID_REQUEST")
    expect((err as DashboardError).message).toMatch(/too long to remember/)
    await setViewerRange(mine, id, { compare: "previousPeriod" })
    expect((await getDashboard(mine, id)).range).toMatchObject({
      compare: "previousPeriod",
      saved: true,
    })
  })
})

describe("drill-down", () => {
  it("the rows behind a bar come from the cached read, with their links", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await dashboard()
    const viewer = as(owner, [WRITE, READ])
    runs.length = 0
    await getBlockData(viewer, id, "by-market")
    const out = await getBlockRows(viewer, id, "by-market", { category: "FR" })
    expect(runs).toHaveLength(1)
    expect(out).toMatchObject({
      ok: true,
      cached: true,
      total: 2,
      nextOffset: null,
      links: [
        { kind: "path", href: "/orders/o1" },
        { kind: "path", href: "/orders/o3" },
      ],
    })
    if (!out.ok) throw new Error("refused")
    expect(out.columns.map((c) => c.field)).toEqual(["id", "market", "total"])
    // Only what the blocks read is kept from a row.
    expect(out.rows[0]).toEqual({ id: "o1", market: "FR", total: "10" })
    // The names of every field the rows carry (never their values): what a filter can read.
    expect(out.fields).toEqual(["channel", "day", "id", "market", "secret", "total"])
    const paged = await getBlockRows(viewer, id, "count", { limit: 3 })
    expect(paged).toMatchObject({ total: 4, nextOffset: 3, limit: 3 })
    const one = await getBlockRows(viewer, id, "list", { row: 0 })
    expect(one).toMatchObject({ total: 1, rows: [{ id: "o3" }] })
  })

  it("keeps the block's access, and a text block has no rows", async () => {
    const id = await dashboard()
    expect(
      await getBlockRows(as(owner, [WRITE]), id, "by-market", { category: "FR" }),
    ).toMatchObject({ ok: false, error: "no_access" })
    // A personal dashboard is nobody else's, its rows included.
    const err = await getBlockRows(as(other, [WRITE, READ]), id, "by-market").catch(
      (e: unknown) => e,
    )
    expect((err as DashboardError).code).toBe("NOT_FOUND")
    const text = await getBlockRows(as(owner, [WRITE, READ]), id, "note").catch((e: unknown) => e)
    expect((text as DashboardError).code).toBe("INVALID_REQUEST")
  })
})

describe("editing datasets and filters", () => {
  it("sets a dataset and a filter and points a block at them, in one version", async () => {
    const author = as(owner, [WRITE, READ])
    const id = await dashboard({
      v: 1,
      blocks: [
        {
          id: "a",
          type: "metric",
          title: "A",
          source: { kind: "tool", tool: `${APP}:orders_read` },
          map: { agg: "count" },
        },
      ],
    })
    const before = await getDashboard(author, id)
    const after = await editDashboard(author, id, {
      ifVersion: before.version,
      operations: [
        { op: "setDataset", id: "orders", source: SOURCE },
        { op: "setFilter", filter: { id: "market", label: "Market", type: "text" } },
        { op: "updateBlock", blockId: "a", changes: { source: null, dataset: "orders" } },
      ],
    })
    expect(after.spec.datasets as unknown).toEqual({ orders: { ...SOURCE } })
    expect(after.spec.blocks[0]).toMatchObject({ dataset: "orders" })
    // Removing a dataset a block still reads refuses the whole edit.
    const err = await editDashboard(author, id, {
      ifVersion: after.version,
      operations: [{ op: "removeDataset", id: "orders" }],
    }).catch((e: unknown) => e)
    expect((err as DashboardError).code).toBe("INVALID_SPEC")
  })
})

describe("snapshot recipients (step-3 review MED 4)", () => {
  it("refuses a recipient whose row access is narrower than the caller's; the same access passes", async () => {
    const author = as(owner, [WRITE, "kernel:dashboards:share"])
    const { id } = await createDashboard(author, {
      title: "Shared note",
      visibility: "org",
      spec: { v: 1, blocks: [{ id: "n", type: "text", title: "N", text: "hello" }] },
    })
    const wide: UserContext = { ...as(owner, []), dimensionGrants: { "*": ["*"] } }
    const [narrow] = await checkRecipients(wide, id, [other])
    expect(narrow).toMatchObject({ userId: other, mayReceive: false })
    expect(narrow?.reason).toMatch(/sees fewer rows/)
    const plain: UserContext = { ...as(owner, []), dimensionGrants: {}, roles: [] }
    const [same] = await checkRecipients(plain, id, [other])
    expect(same).toMatchObject({ userId: other, mayReceive: true })
  })
})
