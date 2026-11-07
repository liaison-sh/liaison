// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Dashboards on real Postgres: who may create, see and edit (RLS plus the share
// and admin scopes), what a saved block may read, and a block run as the
// VIEWER: their scopes decide each block, a write is refused even when its
// manifest lies, and a tool gated after the save no longer runs. The cache runs
// on a fake store here (the Redis lane: tests/integration/dashboards-block-cache.test.ts).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { READ_ONLY_RUN_BLOCKED_CODE } from "~/modules/agent/runtime/read-only-run"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import {
  type BlockCacheStore,
  MAX_IN_FLIGHT,
  Semaphore,
  setBlockCacheStoreForTests,
} from "~/modules/dashboards/cache"
import {
  createDashboard,
  DashboardError,
  deleteDashboard,
  getBlockData,
  getDashboard,
  listDashboards,
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
  const state = { down: false }
  const store: BlockCacheStore = {
    async get(k) {
      if (state.down) throw new Error("ECONNREFUSED")
      return data.get(k) ?? null
    },
    async set(k, v) {
      if (state.down) throw new Error("ECONNREFUSED")
      data.set(k, v)
    },
    async setIfAbsent(k) {
      if (state.down) throw new Error("ECONNREFUSED")
      if (data.has(k)) return false
      data.set(k, "1")
      return true
    },
  }
  return { store, data, state }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Dashboards Service Org" })).orgId
  owner = (await minimal.person(orgId)).id
  other = (await minimal.person(orgId)).id
  registerTestTools()
})

afterEach(() => setBlockCacheStoreForTests(null))

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

    const seen = (await listDashboards(as(other, [WRITE]))).map((d) => d.id)
    expect(seen).toContain(shared.id)
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
    setBlockCacheStoreForTests(fakeStore().store)
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
    setBlockCacheStoreForTests(fakeStore().store)
    lieAttempts.length = 0
    await getBlockData(as(other, [ALPHA]), dashboardId, "sneaky")
    expect(lieAttempts).toEqual([READ_ONLY_RUN_BLOCKED_CODE])
  })

  it("a tool that became gated after the save renders not_allowed, and the core never parks it", async () => {
    setBlockCacheStoreForTests(fakeStore().store)
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

describe("a store-backed block", () => {
  it("reads a declared collection under its read scope, as the viewer", async () => {
    setBlockCacheStoreForTests(fakeStore().store)
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
    setBlockCacheStoreForTests(fake.store)
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
    setBlockCacheStoreForTests(fake.store)
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
