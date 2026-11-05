// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S58 (batch-5 F3): the session events disk cache is one database per server
// and user, opened for whoever is signed in; it is deleted on sign-out, on a
// refused refresh (no sign-out) and on an account switch; a server switch
// never opens the other server's database; removing a server deletes all of
// that server's databases.

import type { NodeSessionEvent } from "@liaison/shared"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { log } from "~/lib/logger"
import { _teardownAuth, clearAuth, setTokens } from "~/modules/auth/auth-store"
import { deleteSessionCachesOf, sessionCacheDbName } from "./session-cache-db"
import { registerSessionCacheLifecycle } from "./session-cache-lifecycle"
import { _resetDiskCache, clearDiskCache, diskCache, flushDiskCache } from "./session-disk-cache"
import { resetSessionStore, sessionStore, setSessionStoreApi, watchSession } from "./session-store"

const SERVER_GLOBAL = "__LIAISON_SERVER_ADDRESS__"
const A = "https://a.liaison.test"
const B = "https://b.liaison.test"

const b64 = (value: object) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

function signInAs(userId: string): void {
  setTokens(
    `${b64({ alg: "none" })}.${b64({
      userId,
      orgId: "org-1",
      name: userId,
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.x`,
  )
}

function onServer(address: string): void {
  ;(globalThis as Record<string, unknown>)[SERVER_GLOBAL] = address
}

function event(seq: number): NodeSessionEvent {
  const at = new Date(Date.UTC(2026, 9, 15, 12, 0, seq)).toISOString()
  return { seq, at, receivedAt: at, type: "assistant_text", payload: { text: `secret ${seq}` } }
}

async function cacheOne(): Promise<void> {
  diskCache.write("s1", "", [event(1), event(2)], [10, 10], 0, 2)
  await flushDiskCache()
}

const cached = async () => (await diskCache.read("s1", "", 1, 2))?.events.length ?? 0

async function names(): Promise<string[]> {
  const factory = (globalThis as { indexedDB: IDBFactory }).indexedDB
  return (await factory.databases()).map((d) => d.name ?? "").sort()
}

let unregister: () => void = () => undefined

beforeEach(async () => {
  const g = globalThis as Record<string, unknown>
  g.indexedDB = new IDBFactory()
  g.IDBKeyRange = IDBKeyRange
  await _resetDiskCache()
  unregister = registerSessionCacheLifecycle()
  onServer(A)
})

afterEach(async () => {
  resetSessionStore()
  unregister()
  clearAuth()
  await _resetDiskCache()
  const g = globalThis as Record<string, unknown>
  delete g.indexedDB
  delete g.IDBKeyRange
  delete g[SERVER_GLOBAL]
})

afterAll(() => _teardownAuth())

describe("S58 (batch-5 F3): whose session events cache it is", () => {
  it("S58: one database per server and user, and nothing cached while nobody is signed in", async () => {
    await cacheOne()
    expect(await names()).toEqual([])
    signInAs("u1")
    await cacheOne()
    expect(await cached()).toBe(2)
    expect(await names()).toEqual([sessionCacheDbName(A, "u1")])
  })

  it("S58: a refresh the server refused (no sign-out) deletes the cache: the same user signing in again finds nothing (P4)", async () => {
    signInAs("u1")
    await cacheOne()
    expect(await cached()).toBe(2)
    clearAuth()
    expect(await diskCache.read("s1", "", 1, 2)).toBeNull()
    await flushDiskCache()
    signInAs("u1")
    expect(await cached()).toBe(0)
    expect(await diskCache.readOne("s1", "", 1)).toBeNull()
  })

  it("S58: another server never reads the cache of the server it switched from, which stays its own", async () => {
    signInAs("u1")
    await cacheOne()
    onServer(B)
    expect(await cached()).toBe(0)
    expect(await diskCache.readOne("s1", "", 1)).toBeNull()
    onServer(A)
    expect(await cached()).toBe(2)
  })

  it("S58: another user signing in on the same server (an account switch) deletes the previous user's cache", async () => {
    signInAs("u1")
    await cacheOne()
    signInAs("u2")
    expect(await cached()).toBe(0)
    await flushDiskCache()
    expect(await names()).not.toContain(sessionCacheDbName(A, "u1"))
    signInAs("u1")
    expect(await cached()).toBe(0)
  })

  it("S58: removing a server deletes every user's cache of that server and no other", async () => {
    signInAs("u1")
    await cacheOne()
    onServer(B)
    await cacheOne()
    await _resetDiskCache()
    const factory = (globalThis as { indexedDB: IDBFactory }).indexedDB
    expect(await deleteSessionCachesOf(`${A}/`, factory)).toEqual([sessionCacheDbName(A, "u1")])
    expect(await names()).toEqual([sessionCacheDbName(B, "u1")])
  })
})

describe("S58 (batch-5 F5): nothing of a login lands after it ended", () => {
  it("S58: a flush already under way when the cache is cleared stands down: it writes nothing and never touches the closed database (P5)", async () => {
    signInAs("u1")
    await cacheOne()
    await _resetDiskCache()
    const warn = vi.spyOn(log, "warn")
    diskCache.write("s1", "", [event(3)], [10], 2, 3)
    const flushing = flushDiskCache()
    // Let the flush open the database and start reading its size (two IDB callbacks).
    for (let i = 0; i < 2; i++) await new Promise((r) => setImmediate(r))
    const clearing = clearDiskCache()
    await Promise.all([flushing, clearing])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    expect(await diskCache.read("s1", "", 1, 3)).toBeNull()
    expect(await diskCache.readOne("s1", "", 3)).toBeNull()
  })

  it("S58: another tab's sign-out (the auth broadcast) stops this tab: its held transcripts go and nothing more is cached", async () => {
    signInAs("u1")
    const at = new Date(Date.UTC(2026, 9, 15, 12)).toISOString()
    const events = [1, 2, 3].map((seq) => ({
      seq,
      at,
      receivedAt: at,
      type: "assistant_text",
      payload: { text: `secret ${seq}` },
    }))
    setSessionStoreApi(
      () =>
        ({
          get: async (path: string) =>
            path.includes("/events")
              ? { events: path.includes("after=0") ? events : [], lastSeq: 3, through: 3 }
              : { id: "s1", status: "running", lastSeq: 3, folderName: "code", repo: null },
        }) as never,
    )
    await watchSession("s1")
    expect(sessionStore.events("s1").length).toBe(3)
    const other = new BroadcastChannel("liaison-auth")
    other.postMessage({ type: "logout" })
    other.close()
    await vi.waitFor(() => expect(sessionStore.isWatched("s1")).toBe(false))
    expect(sessionStore.events("s1")).toEqual([])
    expect(sessionStore.row("s1")).toBeUndefined()
    await flushDiskCache()
    signInAs("u1")
    expect(await diskCache.read("s1", "", 1, 3)).toBeNull()
  })
})

describe("S58 (batch-5 F12): records of another format are never read", () => {
  async function raw<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const factory = (globalThis as { indexedDB: IDBFactory }).indexedDB
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(sessionCacheDbName(A, "u1"), 1)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await fn(db)
    } finally {
      db.close()
    }
  }

  const settle = (tx: IDBTransaction) =>
    new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve()
    })

  it("S58: a cached event written in another format (an older client's) is ignored and its range deleted", async () => {
    signInAs("u1")
    await cacheOne()
    await _resetDiskCache()
    // An older client stored the held event as it was then: no format mark.
    await raw(async (db) => {
      const tx = db.transaction("events", "readwrite")
      tx.objectStore("events").put({ e: { ...event(2), shape: "old" }, b: 10 }, ["s1", "", 2])
      await settle(tx)
    })
    expect(await diskCache.read("s1", "", 1, 2)).toBeNull()
    expect(await diskCache.readOne("s1", "", 1)).toBeNull()
    await _resetDiskCache()
    const left = await raw(async (db) => {
      const tx = db.transaction(["events", "ranges"], "readonly")
      const count = (store: string) =>
        new Promise<number>((resolve) => {
          const req = tx.objectStore(store).count()
          req.onsuccess = () => resolve(req.result)
        })
      return [await count("events"), await count("ranges")]
    })
    expect(left).toEqual([0, 0])
  })
})
