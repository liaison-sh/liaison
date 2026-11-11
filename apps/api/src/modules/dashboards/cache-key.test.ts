// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A block's cache key changes with anything the row policies read for the viewer: scopes,
// dimension grants AND roles (a contact shared with a role is visible only to its holders),
// so a viewer removed from a role is never answered with figures read while they held it.

import { afterEach, describe, expect, it } from "bun:test"
import {
  type BlockCacheStore,
  BlockCacheTestAccess,
  CUSTOM_WINDOW_RUNS,
  isUncacheable,
  markUncacheable,
  permissionHash,
  takeCustomWindowRun,
  VIEWER_WINDOW_RUNS,
} from "~/modules/dashboards/cache"

const base = { scopes: ["kernel:contacts:read"], dimensionGrants: {} }

describe("permissionHash", () => {
  it("moves when the viewer's roles change, whatever their order", () => {
    const sales = permissionHash({ ...base, roles: ["r-sales", "r-member"] })
    expect(permissionHash({ ...base, roles: ["r-member", "r-sales"] })).toBe(sales)
    expect(permissionHash({ ...base, roles: ["r-member"] })).not.toBe(sales)
    expect(permissionHash({ ...base })).toBe(permissionHash({ ...base, roles: [] }))
  })
})

describe("run budget", () => {
  const viewer = { orgId: "o", userId: "u", scopes: [], dimensionGrants: {} }
  const counting = (): BlockCacheStore => {
    const data = new Map<string, string>()
    return {
      async get(k) {
        return data.get(k) ?? null
      },
      async set(k, v) {
        data.set(k, v)
      },
      async setIfAbsent() {
        return true
      },
      async increment(k) {
        const n = Number(data.get(k) ?? 0) + 1
        data.set(k, String(n))
        return n
      },
    }
  }
  const down: BlockCacheStore = {
    get: async () => Promise.reject(new Error("down")),
    set: async () => Promise.reject(new Error("down")),
    setIfAbsent: async () => Promise.reject(new Error("down")),
    increment: async () => Promise.reject(new Error("down")),
  }
  afterEach(() => {
    BlockCacheTestAccess.setStore(null)
    BlockCacheTestAccess.resetLocal()
  })

  it("caps one viewer across sources, not only per source", async () => {
    BlockCacheTestAccess.setStore(counting())
    let granted = 0
    for (let source = 0; source < 10; source++) {
      for (let i = 0; i < CUSTOM_WINDOW_RUNS; i++) {
        if (await takeCustomWindowRun(viewer, "d", `blk:${source}`)) granted++
      }
    }
    expect(granted).toBe(VIEWER_WINDOW_RUNS)
  })

  it("stays bounded while Redis is down", async () => {
    BlockCacheTestAccess.setStore(down)
    let granted = 0
    for (let i = 0; i < CUSTOM_WINDOW_RUNS * 3; i++) {
      if (await takeCustomWindowRun(viewer, "d", "blk:a")) granted++
    }
    expect(granted).toBe(CUSTOM_WINDOW_RUNS)
  })

  it("remembers a result it could not keep, in Redis or, Redis down, in this process", async () => {
    BlockCacheTestAccess.setStore(counting())
    expect(await isUncacheable("k1")).toBe(false)
    await markUncacheable("k1", 60)
    BlockCacheTestAccess.resetLocal()
    expect(await isUncacheable("k1")).toBe(true)
    BlockCacheTestAccess.setStore(down)
    await markUncacheable("k2", 60)
    expect(await isUncacheable("k2")).toBe(true)
  })
})
