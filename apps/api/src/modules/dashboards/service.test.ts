// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Dashboards on real Postgres: who may create, see and edit (RLS plus the share
// and admin scopes), what a saved block may read, and a block run as the
// VIEWER: their scopes decide each block, a write is refused even when its
// manifest lies, and a tool gated after the save no longer runs. The cache runs
// on a fake store here (the Redis lane: tests/integration/dashboards-block-cache.test.ts).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { dashboardViewerStates, pendingEvents } from "~/db/schema/kernel"
import { READ_ONLY_RUN_BLOCKED_CODE } from "~/modules/agent/runtime/read-only-run"
import { customAppOrgKey } from "~/modules/apps/app-org-scope"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import {
  type BlockCacheStore,
  BlockCacheTestAccess,
  MAX_IN_FLIGHT,
  Semaphore,
} from "~/modules/dashboards/cache"
import {
  createDashboard,
  DashboardError,
  deleteDashboard,
  editDashboard,
  getBlockData,
  getDashboard,
  getViewerRange,
  listDashboards,
  setViewerRange,
  updateDashboard,
} from "~/modules/dashboards/service"
import { setDocument } from "~/modules/data-store/service"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "dshtest"
const ALPHA = `${APP}:alpha:read`
const BETA = `${APP}:beta:read`
const WRITE = "kernel:dashboards:write"
const SHARE = "kernel:dashboards:share"
const ADMIN = "kernel:dashboards:admin"

let orgId = ""
let owner = ""
let other = ""
let alphaCalls = 0
let pagedCalls = 0
let brokenCalls = 0
/** The params each run of the dated tool received. */
const datedParams: Record<string, unknown>[] = []
/** What the lying tool's bridge write answered, per run. */
const lieAttempts: string[] = []

const as = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId,
  scopes,
  dimensionGrants: {},
})

const ORDERS = [
  { day: "2026-11-01", total: "10" },
  { day: "2026-11-01", total: "5" },
  { day: "2026-11-02", total: "7" },
]

function toolBlock(id: string, tool: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "line",
    title: id,
    source: { kind: "tool", tool },
    map: { groupBy: { field: "day", bucket: "day" }, y: "total", agg: "sum" },
    ...extra,
  }
}

const spec = (...blocks: unknown[]) => ({ v: 1, blocks })

function registerTestTools() {
  toolRegistry.set([orgId, APP, "alpha_read"], {
    appName: APP,
    name: "alpha_read",
    description: "Read the alpha orders",
    requiredScopes: [ALPHA],
    readOnly: true,
    params: z.object({}),
    handler: async () => {
      alphaCalls++
      return { items: ORDERS }
    },
  })
  toolRegistry.set([orgId, APP, "beta_read"], {
    appName: APP,
    name: "beta_read",
    description: "Read the beta orders",
    requiredScopes: [BETA],
    readOnly: true,
    params: z.object({}),
    handler: async () => ORDERS,
  })
  toolRegistry.set([orgId, APP, "items_write"], {
    appName: APP,
    name: "items_write",
    description: "Write an item",
    requiredScopes: [ALPHA],
    writesToTable: `app_${APP}.items`,
    params: z.object({}),
    handler: async () => ({ written: true }),
  })
  // Paged: page one is rows with a cursor, page two answers no row list at all.
  toolRegistry.set([orgId, APP, "paged_read"], {
    appName: APP,
    name: "paged_read",
    description: "Read orders page by page",
    requiredScopes: [ALPHA],
    readOnly: true,
    params: z.object({ cursor: z.string().optional() }),
    handler: async (p: unknown) => {
      pagedCalls++
      return (p as { cursor?: string }).cursor
        ? { status: "done" }
        : { items: ORDERS, nextCursor: "p2" }
    },
  })
  // A source whose params carry date tokens: it records what it was called with.
  toolRegistry.set([orgId, APP, "dated_read"], {
    appName: APP,
    name: "dated_read",
    description: "Read orders over a date range",
    requiredScopes: [ALPHA],
    readOnly: true,
    params: z.object({ period: z.object({ since: z.string() }), query: z.string() }),
    handler: async (p: unknown) => {
      datedParams.push(p as Record<string, unknown>)
      return { items: ORDERS }
    },
  })
  // A source that always fails, counted, for the failure cache.
  toolRegistry.set([orgId, APP, "broken_read"], {
    appName: APP,
    name: "broken_read",
    description: "A read whose service is down",
    requiredScopes: [ALPHA],
    readOnly: true,
    params: z.object({}),
    handler: async () => {
      brokenCalls++
      throw new Error("upstream unavailable")
    },
  })
  // The LIE: declared readOnly, and its handler writes through the sandbox bridge.
  toolRegistry.set([orgId, APP, "sneaky_read"], {
    appName: APP,
    name: "sneaky_read",
    description: "Claims to read; writes",
    requiredScopes: [ALPHA],
    readOnly: true,
    params: z.object({}),
    handler: async (_p: unknown, ctx: { userId: string; db: RlsClient; scopes: string[] }) => {
      const bridge = createRpcBridge(
        APP,
        ctx.userId,
        orgId,
        ctx.db,
        { name: APP, trusted: true, schema: { items: { fields: { title: "string" } } } } as never,
        ctx.scopes,
        "user",
      )
      try {
        await bridge.db_insert("items", JSON.stringify({ title: "written by a view" }))
        lieAttempts.push("written")
      } catch (err) {
        lieAttempts.push((err as { code?: string }).code ?? "throw")
      }
      return ORDERS
    },
  })
}

/** A cache store in memory, which can be made to fail like a Redis outage. */
function fakeStore() {
  const data = new Map<string, string>()
  const ttls = new Map<string, number>()
  const state = { down: false }
  const store: BlockCacheStore = {
    async get(k) {
      if (state.down) throw new Error("ECONNREFUSED")
      return data.get(k) ?? null
    },
    async set(k, v, ttl) {
      if (state.down) throw new Error("ECONNREFUSED")
      data.set(k, v)
      ttls.set(k, ttl)
    },
    async increment(k) {
      if (state.down) throw new Error("ECONNREFUSED")
      const n = Number(data.get(k) ?? 0) + 1
      data.set(k, String(n))
      return n
    },
    async setIfAbsent(k) {
      if (state.down) throw new Error("ECONNREFUSED")
      if (data.has(k)) return false
      data.set(k, "1")
      return true
    },
  }
  return { store, data, ttls, state }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Dashboards Service Org" })).orgId
  owner = (await minimal.person(orgId, { name: "Dana Owner" })).id
  other = (await minimal.person(orgId)).id
  registerTestTools()
})

afterEach(() => BlockCacheTestAccess.setStore(null))

afterAll(async () => {
  await releaseTestLock()
})

describe("who creates, sees and edits", () => {
  it("a personal dashboard is its owner's; org needs share, which creates it directly", async () => {
    const personal = await createDashboard(as(owner, [WRITE, ALPHA]), {
      title: "Mine",
      visibility: "personal",
      spec: spec(toolBlock("a", `${APP}:alpha_read`)),
    })
    await expect(
      createDashboard(as(owner, [WRITE, ALPHA]), {
        title: "Ours",
        visibility: "org",
        spec: spec(),
      }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" })
    const shared = await createDashboard(as(owner, [WRITE, SHARE]), {
      title: "Ours",
      visibility: "org",
      spec: spec(),
    })
    expect(shared).toMatchObject({
      visibility: "org",
      ownerUserId: owner,
      version: 1,
      canEdit: true,
    })

    const listed = await listDashboards(as(other, [WRITE]))
    const seen = listed.map((d) => d.id)
    expect(seen).toContain(shared.id)
    // The list names each dashboard's owner, for "by <name>" in the sidebar.
    expect(listed.find((d) => d.id === shared.id)?.ownerName).toBe("Dana Owner")
    expect(seen).not.toContain(personal.id)
    await expect(getDashboard(as(other, [ADMIN]), personal.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })

    // Someone else's org dashboard: read-only without admin, editable with it.
    expect((await getDashboard(as(other, [WRITE, SHARE]), shared.id)).canEdit).toBe(false)
    await expect(
      updateDashboard(as(other, [WRITE, SHARE]), shared.id, { title: "Taken" }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" })
    const renamed = await updateDashboard(as(other, [WRITE, ADMIN]), shared.id, { title: "Team" })
    expect(renamed).toMatchObject({ title: "Team", version: 2 })
    await expect(
      updateDashboard(as(owner, [WRITE, SHARE]), shared.id, { title: "Old", ifVersion: 1 }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" })

    // Switching one's own personal dashboard to org needs share as well.
    await expect(
      updateDashboard(as(owner, [WRITE, ALPHA]), personal.id, { visibility: "org" }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" })
    await deleteDashboard(as(owner, [WRITE]), personal.id)
    await expect(getDashboard(as(owner, [WRITE]), personal.id)).rejects.toBeInstanceOf(
      DashboardError,
    )
  })
})

/** The outbox rows queued for one dashboard, oldest first. */
async function dashboardEvents(dashboardId: string) {
  const rows = await withSystemDb("dashboards-events-test", (db) =>
    db
      .select({ seq: pendingEvents.seq, payload: pendingEvents.payload })
      .from(pendingEvents)
      .where(
        and(
          eq(pendingEvents.orgId, orgId),
          sql`${pendingEvents.payload}->>'entity' = 'dashboard'`,
          sql`${pendingEvents.payload}->>'entityId' = ${dashboardId}`,
        ),
      ),
  )
  return rows
    .sort((a, b) => a.seq - b.seq)
    .map((r) => r.payload as { action: string; data: Record<string, unknown> })
}

describe("live updates", () => {
  it("queues a created, updated and deleted event with ids and visibility only, never the title", async () => {
    const d = await createDashboard(as(owner, [WRITE, SHARE]), {
      title: "Secret plans",
      visibility: "personal",
      spec: spec(),
    })
    await updateDashboard(as(owner, [WRITE, SHARE]), d.id, { visibility: "org" })
    await updateDashboard(as(owner, [WRITE, SHARE]), d.id, { visibility: "personal" })
    await deleteDashboard(as(owner, [WRITE, SHARE]), d.id)

    const events = await dashboardEvents(d.id)
    expect(events.map((e) => e.action)).toEqual(["created", "updated", "updated", "deleted"])
    expect(events.map((e) => e.data)).toEqual([
      { dashboardId: d.id, visibility: "personal", ownerUserId: owner, version: 1 },
      {
        dashboardId: d.id,
        visibility: "org",
        previousVisibility: "personal",
        ownerUserId: owner,
        version: 2,
      },
      {
        dashboardId: d.id,
        visibility: "personal",
        previousVisibility: "org",
        ownerUserId: owner,
        version: 3,
      },
      { dashboardId: d.id, visibility: "personal", ownerUserId: owner, version: 3 },
    ])
    expect(JSON.stringify(events)).not.toContain("Secret plans")
  })

  it("a refused write queues nothing", async () => {
    const d = await createDashboard(as(owner, [WRITE, SHARE]), {
      title: "Shared",
      visibility: "org",
      spec: spec(),
    })
    await expect(
      updateDashboard(as(other, [WRITE, SHARE]), d.id, { title: "Taken" }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" })
    expect((await dashboardEvents(d.id)).map((e) => e.action)).toEqual(["created"])
  })
})

describe("what a saved block may read", () => {
  const save = (blocks: unknown[], scopes = [WRITE, ALPHA]) =>
    createDashboard(as(owner, scopes), {
      title: "S",
      visibility: "personal",
      spec: spec(...blocks),
    })

  it("refuses a tool that writes, an unknown tool, a kernel tool off the list and one the author cannot call", async () => {
    const problems = async (blocks: unknown[], scopes?: string[]) => {
      try {
        await save(blocks, scopes)
        return []
      } catch (err) {
        return (err as DashboardError).problems
      }
    }
    expect((await problems([toolBlock("w", `${APP}:items_write`)]))[0]).toContain("not_allowed")
    expect((await problems([toolBlock("u", `${APP}:nope`)]))[0]).toContain("unknown_tool")
    expect((await problems([toolBlock("k", "kernel:create_skill")]))[0]).toContain("not_allowed")
    expect((await problems([toolBlock("b", `${APP}:beta_read`)]))[0]).toContain("no_access")
    expect(await problems([toolBlock("ok", `${APP}:alpha_read`)])).toEqual([])
  })

  it("an org's own custom app feeds a dashboard under the same rules; another org's never does", async () => {
    const own = `dshcustom-o${customAppOrgKey(orgId)}`
    const foreign = "dshcustom-o00000000"
    for (const app of [own, foreign]) {
      toolRegistry.set([orgId, app, "orders_read"], {
        appName: app,
        name: "orders_read",
        description: "Read the custom app's orders",
        requiredScopes: [ALPHA],
        readOnly: true,
        params: z.object({}),
        handler: async () => ORDERS,
      })
    }
    try {
      await expect(save([toolBlock("c", `${own}:orders_read`)])).resolves.toBeDefined()
      await expect(save([toolBlock("f", `${foreign}:orders_read`)])).rejects.toMatchObject({
        problems: [expect.stringContaining("unknown_tool")],
      })
    } finally {
      toolRegistry.delete([orgId, own, "orders_read"])
      toolRegistry.delete([orgId, foreign, "orders_read"])
    }
  })

  it("refuses an invalid spec, naming the field", async () => {
    await expect(
      save([{ ...toolBlock("t", `${APP}:alpha_read`), type: "table" }]),
    ).rejects.toMatchObject({
      code: "INVALID_SPEC",
      problems: expect.arrayContaining([expect.stringContaining("map.columns")]),
    })
  })
})

describe("a block runs as its viewer", () => {
  let dashboardId = ""

  beforeAll(async () => {
    const d = await createDashboard(as(owner, [WRITE, SHARE, ALPHA, BETA]), {
      title: "Sales",
      visibility: "org",
      spec: spec(
        toolBlock("alpha", `${APP}:alpha_read`),
        toolBlock("beta", `${APP}:beta_read`),
        toolBlock("sneaky", `${APP}:sneaky_read`),
      ),
    })
    dashboardId = d.id
  })

  it("a viewer without the tool's scope gets no_access for that block, the other renders", async () => {
    BlockCacheTestAccess.setStore(fakeStore().store)
    const viewer = as(other, [ALPHA])
    const alpha = await getBlockData(viewer, dashboardId, "alpha")
    expect(alpha).toMatchObject({
      ok: true,
      cached: false,
      data: { kind: "line", labels: ["2026-11-01", "2026-11-02"], series: [{ values: [15, 7] }] },
    })
    expect(await getBlockData(viewer, dashboardId, "beta")).toMatchObject({
      ok: false,
      error: "no_access",
    })
  })

  it("a manifest that marks a writing tool readOnly is refused its write at the bridge", async () => {
    BlockCacheTestAccess.setStore(fakeStore().store)
    lieAttempts.length = 0
    await getBlockData(as(other, [ALPHA]), dashboardId, "sneaky")
    expect(lieAttempts).toEqual([READ_ONLY_RUN_BLOCKED_CODE])
  })

  it("a tool that became gated after the save renders not_allowed, and the core never parks it", async () => {
    BlockCacheTestAccess.setStore(fakeStore().store)
    const def = toolRegistry.get([orgId, APP, "beta_read"])!
    toolRegistry.set([orgId, APP, "beta_read"], { ...def, gated: true })
    try {
      expect(await getBlockData(as(other, [BETA]), dashboardId, "beta")).toMatchObject({
        ok: false,
        error: "not_allowed",
      })
      // The core answers a "dashboard" call to a gated tool the same way, without an approval.
      const env = await executeToolCore({
        toolName: `${APP}:beta_read`,
        orgId,
        actor: as(other, [BETA]),
        params: {},
        origin: "dashboard",
      })
      expect(env).toMatchObject({ error: { code: "not_allowed" } })
    } finally {
      toolRegistry.set([orgId, APP, "beta_read"], def)
    }
  })

  it("the core refuses a dashboard call to a write, whatever the caller", async () => {
    const env = await executeToolCore({
      toolName: `${APP}:items_write`,
      orgId,
      actor: as(other, [ALPHA]),
      params: {},
      origin: "dashboard",
    })
    expect(env).toMatchObject({ error: { code: "not_allowed" } })
  })
})

describe("a paged source", () => {
  it("keeps the rows already read when a later page has no row list", async () => {
    BlockCacheTestAccess.setStore(fakeStore().store)
    const viewer = as(owner, [WRITE, ALPHA])
    const d = await createDashboard(viewer, {
      title: "Paged",
      visibility: "personal",
      spec: spec(toolBlock("paged", `${APP}:paged_read`)),
    })
    pagedCalls = 0
    const out = await getBlockData(viewer, d.id, "paged")
    expect(pagedCalls).toBe(2)
    expect(out).toMatchObject({
      ok: true,
      data: { kind: "line", labels: ["2026-11-01", "2026-11-02"], series: [{ values: [15, 7] }] },
    })
  })
})

describe("a store-backed block", () => {
  it("reads a declared collection under its read scope, as the viewer", async () => {
    BlockCacheTestAccess.setStore(fakeStore().store)
    await withRlsContext(as(owner, ["kernel:data:write"]), async (tx) => {
      const caller = { orgId, app: "agent", userId: owner }
      await setDocument(tx, caller, "deals", "d1", { title: "Acme", stage: "won", amount: 1200 })
      await setDocument(tx, caller, "deals", "d2", { title: "Globex", stage: "won", amount: 300 })
      await setDocument(tx, caller, "deals", "d3", { title: "Initech", stage: "lost", amount: 50 })
    })
    const d = await createDashboard(as(owner, [WRITE, "kernel:data:read"]), {
      title: "Deals",
      visibility: "personal",
      spec: spec({
        id: "won",
        type: "bar",
        title: "Amount by stage",
        source: { kind: "store", app: "agent", collection: "deals", query: {} },
        map: { x: "stage", y: "amount" },
      }),
    })
    expect(await getBlockData(as(owner, [WRITE, "kernel:data:read"]), d.id, "won")).toMatchObject({
      ok: true,
      data: { kind: "bar", labels: ["won", "lost"], series: [{ values: [1500, 50] }] },
    })
    expect(await getBlockData(as(owner, [WRITE]), d.id, "won")).toMatchObject({
      ok: false,
      error: "no_access",
    })
    // A collection no app declares is its app's alone.
    await expect(
      createDashboard(as(owner, [WRITE, "kernel:data:read"]), {
        title: "Hidden",
        visibility: "personal",
        spec: spec({
          id: "h",
          type: "metric",
          title: "H",
          source: { kind: "store", app: APP, collection: "secrets", query: {} },
          map: { agg: "count" },
        }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_SPEC" })
  })
})

describe("the block cache", () => {
  let dashboardId = ""
  beforeAll(async () => {
    dashboardId = (
      await createDashboard(as(owner, [WRITE, ALPHA]), {
        title: "Cached",
        visibility: "personal",
        spec: spec(toolBlock("alpha", `${APP}:alpha_read`)),
      })
    ).id
  })

  it("hits, refreshes once per 30 s, keys on the viewer's permissions", async () => {
    const fake = fakeStore()
    BlockCacheTestAccess.setStore(fake.store)
    const viewer = as(owner, [WRITE, ALPHA])
    alphaCalls = 0
    expect(await getBlockData(viewer, dashboardId, "alpha")).toMatchObject({
      ok: true,
      cached: false,
    })
    expect(await getBlockData(viewer, dashboardId, "alpha")).toMatchObject({
      ok: true,
      cached: true,
    })
    expect(alphaCalls).toBe(1)
    expect(await getBlockData(viewer, dashboardId, "alpha", { refresh: true })).toMatchObject({
      ok: true,
      cached: false,
    })
    expect(alphaCalls).toBe(2)
    expect(await getBlockData(viewer, dashboardId, "alpha", { refresh: true })).toMatchObject({
      ok: false,
      error: "rate_limited",
    })
    // Another permission set is another key: nothing cached for it yet.
    expect(
      await getBlockData(as(owner, [WRITE, ALPHA, "kernel:x"]), dashboardId, "alpha"),
    ).toMatchObject({ ok: true, cached: false })
    expect(alphaCalls).toBe(3)
  })

  it("Redis down: computed uncached, never failed", async () => {
    const fake = fakeStore()
    fake.state.down = true
    BlockCacheTestAccess.setStore(fake.store)
    alphaCalls = 0
    const viewer = as(owner, [WRITE, ALPHA])
    expect(await getBlockData(viewer, dashboardId, "alpha")).toMatchObject({
      ok: true,
      cached: false,
    })
    expect(await getBlockData(viewer, dashboardId, "alpha")).toMatchObject({
      ok: true,
      cached: false,
    })
    expect(alphaCalls).toBe(2)
  })

  it("a failed block is kept briefly: the next view does not re-run it, a refresh does", async () => {
    const { store, data } = fakeStore()
    BlockCacheTestAccess.setStore(store)
    const viewer = as(owner, [WRITE, ALPHA])
    const d = await createDashboard(viewer, {
      title: "Broken",
      visibility: "personal",
      spec: spec(toolBlock("broken", `${APP}:broken_read`)),
    })
    brokenCalls = 0
    const first = await getBlockData(viewer, d.id, "broken")
    expect(first).toMatchObject({ ok: false, error: "source_failed" })
    expect(await getBlockData(viewer, d.id, "broken")).toMatchObject({
      ok: false,
      error: "source_failed",
    })
    expect(brokenCalls).toBe(1)
    expect([...data.keys()].some((k) => k.endsWith(":failed"))).toBe(true)
    await getBlockData(viewer, d.id, "broken", { refresh: true })
    expect(brokenCalls).toBe(2)
  })

  it("an abandoned read stops paging, and its outcome is not cached", async () => {
    const { store, data } = fakeStore()
    BlockCacheTestAccess.setStore(store)
    const viewer = as(owner, [WRITE, ALPHA])
    const d = await createDashboard(viewer, {
      title: "Abandoned",
      visibility: "personal",
      spec: spec(toolBlock("paged", `${APP}:paged_read`)),
    })
    pagedCalls = 0
    const gone = new AbortController()
    gone.abort()
    const out = await getBlockData(viewer, d.id, "paged", { signal: gone.signal })
    expect(out).toMatchObject({ ok: false, error: "source_failed" })
    expect(pagedCalls).toBe(0)
    expect(data.size).toBe(0)
  })

  it("date tokens resolve at each run, and the cache key moves with the dates", async () => {
    const { store, data } = fakeStore()
    BlockCacheTestAccess.setStore(store)
    const viewer = as(owner, [WRITE, ALPHA])
    const params = {
      period: { since: "{{today-30d}}" },
      query: "WHERE date BETWEEN '{{startOfMonth}}' AND '{{today}}'",
    }
    const d = await createDashboard(viewer, {
      title: "Rolling",
      visibility: "personal",
      spec: spec(
        toolBlock("rolling", `${APP}:dated_read`, {
          source: { kind: "tool", tool: `${APP}:dated_read`, params },
        }),
      ),
    })
    // The saved spec keeps the tokens as written.
    expect((await getDashboard(viewer, d.id)).spec.blocks[0]!.source).toMatchObject({ params })

    datedParams.length = 0
    const day1 = new Date("2026-11-10T12:00:00Z")
    const day2 = new Date("2026-11-11T12:00:00Z")
    expect(await getBlockData(viewer, d.id, "rolling", { now: day1 })).toMatchObject({
      ok: true,
      cached: false,
    })
    expect(await getBlockData(viewer, d.id, "rolling", { now: day1 })).toMatchObject({
      ok: true,
      cached: true,
    })
    expect(await getBlockData(viewer, d.id, "rolling", { now: day2 })).toMatchObject({
      ok: true,
      cached: false,
    })
    expect(datedParams).toEqual([
      {
        period: { since: "2026-10-11" },
        query: "WHERE date BETWEEN '2026-11-01' AND '2026-11-10'",
      },
      {
        period: { since: "2026-10-12" },
        query: "WHERE date BETWEEN '2026-11-01' AND '2026-11-11'",
      },
    ])
    expect([...data.keys()].filter((k) => k.includes(`:${d.id}:`)).length).toBe(2)
  })

  it("refuses an unknown date token at save", async () => {
    const viewer = as(owner, [WRITE, ALPHA])
    const err = await createDashboard(viewer, {
      title: "Bad token",
      visibility: "personal",
      spec: spec(
        toolBlock("bad", `${APP}:dated_read`, {
          source: { kind: "tool", tool: `${APP}:dated_read`, params: { since: "{{tomorrow}}" } },
        }),
      ),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DashboardError)
    expect((err as DashboardError).code).toBe("INVALID_SPEC")
    expect((err as DashboardError).problems.join(" ")).toContain("unknown date token {{tomorrow}}")
  })

  it("at most MAX_IN_FLIGHT block runs at once", async () => {
    const sem = new Semaphore(MAX_IN_FLIGHT)
    let running = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 10 }, () =>
        sem.run(async () => {
          running++
          peak = Math.max(peak, running)
          await new Promise((r) => setTimeout(r, 5))
          running--
        }),
      ),
    )
    expect(peak).toBe(MAX_IN_FLIGHT)
  })
})

/** A failed query's database message (drizzle wraps it as the cause). */
const dbError = (e: unknown) => String((e as { cause?: unknown } | null)?.cause ?? e)

describe("the dashboard time range", () => {
  const rangeParams = {
    period: { since: "{{range.from}}" },
    query: "WHERE date BETWEEN '{{range.from}}' AND '{{range.to}}'",
  }
  const fixedParams = { period: { since: "{{today-90d}}" }, query: "open" }
  const metric = (id: string, params: Record<string, unknown>) => ({
    id,
    type: "metric",
    title: id,
    source: { kind: "tool", tool: `${APP}:dated_read`, params },
    map: { value: "total", agg: "sum", target: 40 },
  })
  const now = new Date("2026-11-10T12:00:00Z")
  let dashboardId = ""
  beforeAll(async () => {
    dashboardId = (
      await createDashboard(as(owner, [WRITE, SHARE, ALPHA]), {
        title: "Ranged",
        visibility: "org",
        spec: { v: 1, blocks: [metric("sales", rangeParams), metric("open", fixedParams)] },
      })
    ).id
  })

  it("a range block reads the default range and once more the same period last year", async () => {
    const { store, data } = fakeStore()
    BlockCacheTestAccess.setStore(store)
    const viewer = as(owner, [WRITE, ALPHA])
    datedParams.length = 0
    const out = await getBlockData(viewer, dashboardId, "sales", { now })
    expect(out).toMatchObject({
      ok: true,
      cached: false,
      window: { mode: "dashboard", preset: "last30d", from: "2026-10-12", to: "2026-11-10" },
      compareWindow: { mode: "lastYear", from: "2025-10-12", to: "2025-11-10" },
      data: { kind: "metric", value: 22, previous: 22, target: 40 },
    })
    expect(datedParams).toEqual([
      {
        period: { since: "2026-10-12" },
        query: "WHERE date BETWEEN '2026-10-12' AND '2026-11-10'",
      },
      {
        period: { since: "2025-10-12" },
        query: "WHERE date BETWEEN '2025-10-12' AND '2025-11-10'",
      },
    ])
    // Both runs are cached apart, each under a key naming its range.
    const keys = [...data.keys()].filter((k) => k.includes(`:${dashboardId}:`))
    expect(keys.some((k) => k.includes(":2026-10-12..2026-11-10:"))).toBe(true)
    expect(keys.some((k) => k.includes(":2025-10-12..2025-11-10:"))).toBe(true)
    // A second view reads both from the cache.
    datedParams.length = 0
    expect(await getBlockData(viewer, dashboardId, "sales", { now })).toMatchObject({
      ok: true,
      cached: true,
      data: { previous: 22 },
    })
    expect(datedParams).toEqual([])
  })

  it("the viewer's range and comparison change the run; none runs once", async () => {
    BlockCacheTestAccess.setStore(fakeStore().store)
    const viewer = as(owner, [WRITE, ALPHA])
    datedParams.length = 0
    const out = await getBlockData(viewer, dashboardId, "sales", {
      now,
      range: { preset: "lastMonth" },
      compare: "none",
    })
    expect(out).toMatchObject({
      ok: true,
      window: { mode: "dashboard", preset: "lastMonth", from: "2026-10-01", to: "2026-10-31" },
      compareWindow: null,
    })
    expect(out.ok && out.data.kind === "metric" && out.data.previous).toBeUndefined()
    expect(datedParams).toHaveLength(1)
    datedParams.length = 0
    await getBlockData(viewer, dashboardId, "sales", {
      now,
      range: { preset: "custom", from: "2026-11-01", to: "2026-11-07" },
      compare: "previousPeriod",
    })
    expect(datedParams.map((p) => (p.period as { since: string }).since)).toEqual([
      "2026-11-01",
      "2026-10-25",
    ])
  })

  it("keeps a comparison run for hours, and Refresh re-runs only the current window", async () => {
    const { store, ttls } = fakeStore()
    BlockCacheTestAccess.setStore(store)
    const viewer = as(owner, [WRITE, ALPHA])
    await getBlockData(viewer, dashboardId, "sales", { now })
    const ttlOf = (range: string) =>
      [...ttls].find(([k]) => k.includes(`:${dashboardId}:`) && k.includes(range))?.[1]
    expect(ttlOf(":2025-10-12..2025-11-10:")).toBe(6 * 3600)
    expect(ttlOf(":2026-10-12..2026-11-10:")).toBeLessThanOrEqual(900)
    datedParams.length = 0
    expect(await getBlockData(viewer, dashboardId, "sales", { now, refresh: true })).toMatchObject({
      ok: true,
      data: { previous: 22 },
    })
    expect(datedParams).toHaveLength(1)
  })

  it("custom ranges not in the cache are budgeted per viewer and block; presets never are", async () => {
    BlockCacheTestAccess.setStore(fakeStore().store)
    const viewer = as(owner, [WRITE, ALPHA])
    const custom = (day: number) =>
      getBlockData(viewer, dashboardId, "sales", {
        now,
        range: {
          preset: "custom",
          from: "2026-10-01",
          to: `2026-10-${String(day).padStart(2, "0")}`,
        },
        compare: "none",
      })
    for (let day = 2; day <= 13; day++) expect((await custom(day)).ok).toBe(true)
    // A range already in the cache costs nothing; a new one past the budget is refused.
    expect(await custom(13)).toMatchObject({ ok: true, cached: true })
    expect(await custom(14)).toMatchObject({ ok: false, error: "rate_limited" })
    for (const preset of ["last7d", "lastMonth", "qtd", "ytd"] as const) {
      expect(
        (await getBlockData(viewer, dashboardId, "sales", { now, range: { preset } })).ok,
      ).toBe(true)
    }
    // Another viewer has a budget of their own.
    expect(
      (
        await getBlockData(as(other, [WRITE, ALPHA]), dashboardId, "sales", {
          now,
          range: { preset: "custom", from: "2026-10-01", to: "2026-10-14" },
          compare: "none",
        })
      ).ok,
    ).toBe(true)
  })

  it("a fixed block keeps its own dates, names them, and is never compared", async () => {
    BlockCacheTestAccess.setStore(fakeStore().store)
    datedParams.length = 0
    const out = await getBlockData(as(owner, [WRITE, ALPHA]), dashboardId, "open", {
      now,
      range: { preset: "lastMonth" },
    })
    expect(out).toMatchObject({
      ok: true,
      window: { mode: "fixed", dates: [{ token: "{{today-90d}}", date: "2026-08-12" }] },
      compareWindow: null,
    })
    expect(datedParams).toHaveLength(1)
  })

  it("the record names each block's mode and the range the viewer opens on", async () => {
    const view = await getDashboard(as(other, [ALPHA]), dashboardId, undefined, now)
    expect(view.blockTimeRange).toEqual({ sales: "dashboard", open: "fixed" })
    expect(view.usesTimeRange).toBe(true)
    expect(view.defaultRange).toEqual({ timeRange: { preset: "last30d" }, compare: "lastYear" })
    expect(view.range).toMatchObject({
      saved: false,
      window: { from: "2026-10-12", to: "2026-11-10" },
      compareWindow: { from: "2025-10-12", to: "2025-11-10" },
    })
  })

  it("each person's remembered range is theirs alone (RLS)", async () => {
    const mine = as(owner, [WRITE, ALPHA])
    const theirs = as(other, [ALPHA])
    await setViewerRange(mine, dashboardId, { timeRange: { preset: "qtd" }, compare: "none" })
    await setViewerRange(theirs, dashboardId, {
      timeRange: { preset: "custom", from: "2026-01-01", to: "2026-03-31" },
      compare: "previousPeriod",
    })
    // An upsert, not a second row.
    await setViewerRange(mine, dashboardId, { timeRange: { preset: "ytd" }, compare: "none" })
    expect(await getViewerRange(mine, dashboardId)).toEqual({
      timeRange: { preset: "ytd" },
      compare: "none",
    })
    const view = await getDashboard(theirs, dashboardId, undefined, now)
    expect(view.range).toMatchObject({
      saved: true,
      compare: "previousPeriod",
      window: { from: "2026-01-01", to: "2026-03-31" },
      compareWindow: { from: "2025-10-03", to: "2025-12-31" },
    })
    // The row policies: each person reads only their own row, and cannot write another's.
    const seen = await withRlsContext(theirs, (t) => t.select().from(dashboardViewerStates))
    expect(seen.map((r) => r.userId)).toEqual([other])
    const forged = await withRlsContext(theirs, (t) =>
      t.insert(dashboardViewerStates).values({
        orgId,
        dashboardId,
        userId: owner,
        timeRange: { preset: "mtd" },
        compare: "none",
      }),
    ).catch((e: unknown) => e)
    expect(dbError(forged)).toContain("row-level security")
    const touched = await withRlsContext(theirs, (t) =>
      t
        .update(dashboardViewerStates)
        .set({ compare: "lastYear" })
        .where(eq(dashboardViewerStates.userId, owner))
        .returning(),
    )
    expect(touched).toEqual([])
  })

  it("no remembered range on a dashboard one cannot see", async () => {
    const personal = await createDashboard(as(owner, [WRITE, ALPHA]), {
      title: "Mine only",
      visibility: "personal",
      spec: spec(),
    })
    const err = await setViewerRange(as(other, [ALPHA]), personal.id, {
      timeRange: { preset: "mtd" },
      compare: "none",
    }).catch((e: unknown) => e)
    expect((err as DashboardError).code).toBe("NOT_FOUND")
    const forged = await withRlsContext(as(other, [ALPHA]), (t) =>
      t.insert(dashboardViewerStates).values({
        orgId,
        dashboardId: personal.id,
        userId: other,
        timeRange: { preset: "mtd" },
        compare: "none",
      }),
    ).catch((e: unknown) => e)
    expect(dbError(forged)).toContain("row-level security")
  })
})

describe("editing by operations", () => {
  const metric = (id: string) => ({
    id,
    type: "metric",
    title: id,
    source: { kind: "tool", tool: `${APP}:alpha_read` },
    map: { agg: "count" },
  })

  it("applies the whole list as one new version, or nothing", async () => {
    const author = as(owner, [WRITE, ALPHA])
    const d = await createDashboard(author, {
      title: "Edited",
      visibility: "personal",
      spec: spec(metric("a"), metric("b")),
    })
    const edited = await editDashboard(author, d.id, {
      ifVersion: d.version,
      operations: [
        { op: "addBlock", block: metric("c"), position: 0 },
        { op: "removeBlock", blockId: "a" },
        { op: "setTitle", title: "Edited twice" },
        { op: "setTimeRange", timeRange: { preset: "mtd" } },
      ],
    })
    expect(edited.version).toBe(d.version + 1)
    expect(edited.title).toBe("Edited twice")
    expect(edited.spec.blocks.map((b) => b.id)).toEqual(["c", "b"])
    expect(edited.spec.timeRange).toEqual({ preset: "mtd" })

    // An operation that cannot apply, or a result that is not a valid spec: nothing changes.
    const unknown = await editDashboard(author, d.id, {
      ifVersion: edited.version,
      operations: [
        { op: "setTitle", title: "Never" },
        { op: "removeBlock", blockId: "zz" },
      ],
    }).catch((e: unknown) => e)
    expect((unknown as DashboardError).code).toBe("INVALID_SPEC")
    expect((unknown as DashboardError).problems).toEqual(["operations.1: no block 'zz'"])
    const invalid = await editDashboard(author, d.id, {
      ifVersion: edited.version,
      operations: [{ op: "updateBlock", blockId: "b", changes: { type: "table" } }],
    }).catch((e: unknown) => e)
    expect((invalid as DashboardError).code).toBe("INVALID_SPEC")
    const after = await getDashboard(author, d.id)
    expect(after.version).toBe(edited.version)
    expect(after.title).toBe("Edited twice")
  })

  it("refuses an edit written against an older version", async () => {
    const author = as(owner, [WRITE, ALPHA])
    const d = await createDashboard(author, {
      title: "Raced",
      visibility: "personal",
      spec: spec(metric("a")),
    })
    await updateDashboard(author, d.id, { title: "Someone else saved" })
    const err = await editDashboard(author, d.id, {
      ifVersion: d.version,
      operations: [{ op: "setTitle", title: "Late" }],
    }).catch((e: unknown) => e)
    expect((err as DashboardError).code).toBe("VERSION_CONFLICT")
  })
})
