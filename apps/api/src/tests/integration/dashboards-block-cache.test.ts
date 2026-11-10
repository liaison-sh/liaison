// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dashboard block's cache on the real Redis: a second view is served from
// it, a forced refresh runs the source again and a second one inside 30 s is
// refused for that block, the entry expires with the block's TTL (a tool
// source at most 900 s), and another permission set never reads it.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import type { UserContext } from "~/db/rls"
import { redis } from "~/lib/redis"
import { toolRegistry } from "~/modules/apps/app-registries"
import { blockCacheKey, redisBlockCacheStore } from "~/modules/dashboards/cache"
import { createDashboard, getBlockData } from "~/modules/dashboards/service"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "dshcache"
const READ = `${APP}:rows:read`
const WRITE = "kernel:dashboards:write"

let orgId = ""
let owner = ""
let calls = 0
let dashboardId = ""

const as = (scopes: string[]): UserContext => ({
  actorType: "user",
  userId: owner,
  orgId,
  scopes,
  dimensionGrants: {},
})

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Dashboard Cache Org" })).orgId
  owner = (await minimal.person(orgId)).id
  toolRegistry.set([orgId, APP, "rows_list"], {
    appName: APP,
    name: "rows_list",
    description: "List rows",
    requiredScopes: [READ],
    readOnly: true,
    params: z.object({}),
    handler: async () => {
      calls++
      return [{ n: 1 }, { n: 2 }]
    },
  })
  dashboardId = (
    await createDashboard(as([WRITE, READ]), {
      title: "Cache",
      visibility: "personal",
      spec: {
        v: 1,
        blocks: [
          {
            id: "total",
            type: "metric",
            title: "Total",
            source: { kind: "tool", tool: `${APP}:rows_list` },
            map: { value: "n" },
            refreshSec: 86_400,
          },
        ],
      },
    })
  ).id
})

afterAll(async () => {
  await releaseTestLock()
})

describe("the block cache on Redis", () => {
  it("hits, refreshes once per 30 s, caps a tool source's TTL at 900 s", async () => {
    const viewer = as([WRITE, READ])
    calls = 0
    expect(await getBlockData(viewer, dashboardId, "total")).toMatchObject({
      ok: true,
      cached: false,
      data: { value: 3 },
    })
    expect(await getBlockData(viewer, dashboardId, "total")).toMatchObject({
      ok: true,
      cached: true,
    })
    expect(calls).toBe(1)

    const key = blockCacheKey(viewer, {
      dashboardId,
      version: 1,
      blockId: "total",
      resolvedSource: { kind: "tool", tool: `${APP}:rows_list`, params: {} },
    })
    const ttl = await redis.ttl(key)
    expect(ttl).toBeGreaterThan(800)
    expect(ttl).toBeLessThanOrEqual(900)

    expect(await getBlockData(viewer, dashboardId, "total", { refresh: true })).toMatchObject({
      ok: true,
      cached: false,
    })
    expect(calls).toBe(2)
    expect(await getBlockData(viewer, dashboardId, "total", { refresh: true })).toMatchObject({
      ok: false,
      error: "rate_limited",
    })
    expect(calls).toBe(2)
  })

  it("another permission set is another entry", async () => {
    calls = 0
    expect(
      await getBlockData(as([WRITE, READ, "kernel:other"]), dashboardId, "total"),
    ).toMatchObject({
      ok: true,
      cached: false,
    })
    expect(calls).toBe(1)
  })

  it("the store's NX lock answers once per window", async () => {
    const key = `dash:test:${crypto.randomUUID()}`
    expect(await redisBlockCacheStore.setIfAbsent(key, 30)).toBe(true)
    expect(await redisBlockCacheStore.setIfAbsent(key, 30)).toBe(false)
    await redis.del(key)
  })
})
