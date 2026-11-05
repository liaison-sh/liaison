// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION EVENTS DISK CACHE (S58, owner D34). The events a session view
// held, kept in IndexedDB so a view that let its events go (a background tab,
// S58) or a stub row (a large output off screen) reads them back without the
// network and without holding them in memory:
//
//   events  key [sessionId, scope, seq] -> { v: format, e: the held event, b: its bytes }
//   ranges  key [sessionId, scope]      -> { lo, hi, bytes, usedAt }
//
// `scope` is "" for the main thread and a subagent's Agent call id for its
// drawer. A range says the cache holds EVERY held event of that scope with
// lo <= seq <= hi (the store writes what one complete read or frame covered:
// `write(..., from, to)` covers (from, to]); a write that touches the range
// widens it, a later disjoint one replaces it (the old events go), an older
// disjoint one is not kept. Reads return the part of a range they cover.
//
// Bounded (DISK_CACHE_MAX_BYTES): past it, whole ranges go, least recently
// used first. Writes are batched (one transaction per flush). Every call is
// wrapped: no IndexedDB (a private window, a test), a failed open, a quota
// error or an aborted transaction leaves the app working without the cache
// (reads answer null, writes are dropped).
//
// Batch-5 F3: one database per server and user (session-cache-db.ts), opened
// for whoever is signed in now (`setDiskCacheOwner`); nobody signed in, no
// cache. Sign-out, a refused refresh and an account switch delete it.

import type { NodeSessionEvent } from "@liaison/shared"
import { log } from "~/lib/logger"
import { deleteSessionCacheDb, sessionCacheDbName } from "./session-cache-db"

/** S58: the cache's size cap; past it, the least recently used ranges go. */
const DISK_CACHE_MAX_BYTES = 200 * 2 ** 20
/** Writes are batched and flushed this long after the first one. */
const DISK_FLUSH_MS = 300

const DB_VERSION = 1
/**
 * F12: the shape of a stored event (`HeldSessionEvent` as this client holds
 * it). A client that changes what it holds raises it; a record of another
 * format is never read, and its whole range is deleted.
 */
const RECORD_FORMAT = 1
const EVENTS = "events"
const RANGES = "ranges"

export interface DiskRead<E> {
  /** The held events of the scope with seq in [lo, hi], in seq order. */
  events: E[]
  /** F10: each event's size as it was stored (the store does not measure it again). */
  bytes: number[]
  lo: number
  hi: number
}

interface RangeRecord {
  lo: number
  hi: number
  bytes: number
  usedAt: number
}

interface EventRecord {
  v: number
  e: NodeSessionEvent
  b: number
}

interface PendingWrite {
  /** F3: the database it was queued for (whoever was signed in then). */
  db: string
  /** F5: the cache's generation when it was queued (a clear since drops it). */
  gen: number
  sessionId: string
  scope: string
  events: NodeSessionEvent[]
  bytes: number[]
  from: number
  to: number
}

type Db = IDBDatabase

let dbPromise: Promise<Db | null> | null = null
/** The database `dbPromise` opened (or is opening), and for whom. */
let dbName: string | null = null
let dbOwner: DiskCacheOwner | null = null
/** The connection `dbPromise` resolved to. */
let openDb: Db | null = null
let disabled = false
let pending: PendingWrite[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushing: Promise<void> = Promise.resolve()
let totalBytes: number | null = null
/**
 * F5: bumped by every clear (a sign-out, another tab's, a refused refresh). A
 * write queued or a flush begun before it never lands; a read across it
 * answers nothing.
 */
let generation = 0
const clock = { now: () => Date.now() }

/** Whose cache it is: the server the page talks to and the signed-in user. */
export interface DiskCacheOwner {
  server: string
  userId: string
}

let ownerOf: () => DiskCacheOwner | null = () => null

/** F3: who is signed in now (null: nobody, no cache). Set once by the app's wiring. */
export function setDiskCacheOwner(getter: () => DiskCacheOwner | null): void {
  ownerOf = getter
}

function currentOwner(): DiskCacheOwner | null {
  try {
    const owner = ownerOf()
    return owner?.server && owner.userId ? owner : null
  } catch {
    return null
  }
}

function idb(): IDBFactory | null {
  try {
    const f = (globalThis as { indexedDB?: IDBFactory }).indexedDB
    return f && typeof f.open === "function" ? f : null
  } catch {
    return null
  }
}

function keyRange(): typeof IDBKeyRange | null {
  return (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange ?? null
}

/** Let go of the open database (it is closed once its open settles). */
function closeDb(): void {
  const was = dbPromise
  dbPromise = null
  openDb = null
  dbName = null
  dbOwner = null
  totalBytes = null
  void was?.then((db) => db?.close())
}

function open(): Promise<Db | null> {
  if (disabled) return Promise.resolve(null)
  const owner = currentOwner()
  if (!owner) return Promise.resolve(null)
  const name = sessionCacheDbName(owner.server, owner.userId)
  if (dbPromise && dbName === name) return dbPromise
  const factory = idb()
  if (!factory || !keyRange()) {
    disabled = true
    return Promise.resolve(null)
  }
  const previous = dbOwner
  const previousName = dbName
  closeDb()
  // Another user on the same server (an account switch): the previous user's cache goes.
  if (previous && previousName && previous.server === owner.server) {
    void deleteSessionCacheDb(previousName, factory)
  }
  dbName = name
  dbOwner = owner
  dbPromise = new Promise<Db | null>((resolve) => {
    try {
      const req = factory.open(name, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(EVENTS)) db.createObjectStore(EVENTS)
        if (!db.objectStoreNames.contains(RANGES)) db.createObjectStore(RANGES)
      }
      req.onsuccess = () => {
        const db = req.result
        // Another tab deletes it (a sign-out there): let it go here too.
        db.onversionchange = () => {
          db.close()
          if (openDb === db) {
            openDb = null
            dbPromise = null
            dbName = null
            dbOwner = null
            totalBytes = null
          }
        }
        openDb = db
        resolve(db)
      }
      req.onerror = () => {
        disabled = true
        resolve(null)
      }
      req.onblocked = () => {
        disabled = true
        resolve(null)
      }
    } catch {
      disabled = true
      resolve(null)
    }
  })
  return dbPromise
}

function done(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => resolve(false)
    tx.onabort = () => resolve(false)
  })
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function scopeBounds(sessionId: string, scope: string, lo: number, hi: number): IDBKeyRange {
  return (keyRange() as typeof IDBKeyRange).bound([sessionId, scope, lo], [sessionId, scope, hi])
}

async function readTotal(db: Db): Promise<number> {
  if (totalBytes !== null) return totalBytes
  const tx = db.transaction(RANGES, "readonly")
  const all = (await request(tx.objectStore(RANGES).getAll())) as RangeRecord[]
  totalBytes = all.reduce((s, r) => s + (r.bytes || 0), 0)
  return totalBytes
}

/** Apply a batch of writes in one transaction (none when the cache was cleared since `gen`). */
async function applyWrites(db: Db, writes: PendingWrite[], gen: number): Promise<void> {
  await readTotal(db)
  if (gen !== generation) return
  const tx = db.transaction([EVENTS, RANGES], "readwrite")
  const events = tx.objectStore(EVENTS)
  const ranges = tx.objectStore(RANGES)
  const ok = done(tx)
  let added = 0
  // Writes of one scope in order: each reads the range the previous one left.
  const ranged = new Map<string, RangeRecord | null>()
  for (const w of writes) {
    const key = `${w.sessionId}\u0000${w.scope}`
    let r = ranged.get(key)
    if (r === undefined) {
      r = ((await request(ranges.get([w.sessionId, w.scope]))) as RangeRecord | undefined) ?? null
      if (gen !== generation) {
        tx.abort()
        await ok
        return
      }
    }
    const lo = w.from + 1
    const hi = w.to
    if (hi < lo) {
      ranged.set(key, r)
      continue
    }
    let keepFrom = Number.POSITIVE_INFINITY
    let keepTo = Number.NEGATIVE_INFINITY
    if (!r) {
      r = { lo, hi, bytes: 0, usedAt: clock.now() }
    } else if (w.from <= r.hi && w.to >= r.lo - 1) {
      // Touches the range: what it already holds stays, the rest is added.
      keepFrom = r.lo
      keepTo = r.hi
      r = { ...r, lo: Math.min(r.lo, lo), hi: Math.max(r.hi, hi) }
    } else if (lo > r.hi) {
      // Later and disjoint: the old range goes.
      events.delete(scopeBounds(w.sessionId, w.scope, r.lo, r.hi))
      added -= r.bytes
      r = { lo, hi, bytes: 0, usedAt: clock.now() }
    } else {
      // Older and disjoint: not kept.
      ranged.set(key, r)
      continue
    }
    for (let i = 0; i < w.events.length; i++) {
      const e = w.events[i]
      if (e.seq < lo || e.seq > hi) continue
      if (e.seq >= keepFrom && e.seq <= keepTo) continue
      const rec: EventRecord = { v: RECORD_FORMAT, e, b: w.bytes[i] }
      events.put(rec, [w.sessionId, w.scope, e.seq])
      r.bytes += w.bytes[i]
      added += w.bytes[i]
    }
    r.usedAt = clock.now()
    ranges.put(r, [w.sessionId, w.scope])
    ranged.set(key, r)
  }
  if (await ok) totalBytes = (totalBytes ?? 0) + added
  else totalBytes = null
}

/** F12: a range holding a record of another format goes whole (its events and itself). */
function dropRange(tx: IDBTransaction, sessionId: string, scope: string, r: RangeRecord): void {
  tx.objectStore(EVENTS).delete(scopeBounds(sessionId, scope, r.lo, r.hi))
  tx.objectStore(RANGES).delete([sessionId, scope])
  totalBytes = null
}

/** Past the cap: the least recently used ranges go, whole, down to 90% of it. */
async function evict(db: Db): Promise<void> {
  const total = await readTotal(db)
  if (total <= DISK_CACHE_MAX_BYTES) return
  const tx = db.transaction([EVENTS, RANGES], "readwrite")
  const ranges = tx.objectStore(RANGES)
  const events = tx.objectStore(EVENTS)
  const ok = done(tx)
  const keys = (await request(ranges.getAllKeys())) as [string, string][]
  const recs = (await request(ranges.getAll())) as RangeRecord[]
  const order = recs.map((r, i) => ({ r, k: keys[i] })).sort((a, b) => a.r.usedAt - b.r.usedAt)
  let left = total
  for (const { r, k } of order) {
    if (left <= DISK_CACHE_MAX_BYTES * 0.9) break
    events.delete(scopeBounds(k[0], k[1], r.lo, r.hi))
    ranges.delete(k)
    left -= r.bytes
  }
  totalBytes = (await ok) ? left : null
}

async function flushNow(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const queued = pending
  pending = []
  if (queued.length === 0) return
  const gen = generation
  const db = await open()
  if (!db) return
  // F3: only what was queued for this database (a write queued for a user who
  // has since left never lands in the next one's); F5: and not cleared since.
  const writes = queued.filter((w) => w.db === dbName && w.gen === generation)
  if (writes.length === 0) return
  try {
    await applyWrites(db, writes, gen)
    await evict(db)
  } catch (err) {
    // A quota error or a closed database: the cache is a cache, the app goes on.
    totalBytes = null
    log.warn({ err }, "writing the session events cache failed")
    if ((err as { name?: string } | null)?.name === "QuotaExceededError") {
      await clearDiskCache()
    }
  }
}

/** Write what is queued now (tests; a read awaits it so it sees every write). */
export function flushDiskCache(): Promise<void> {
  flushing = flushing.then(flushNow, flushNow)
  return flushing
}

export const diskCache = {
  /**
   * The held events of one complete read or frame batch, covering (from, to]
   * of its scope (an empty list still moves the range on). Queued, batched.
   */
  write(
    sessionId: string,
    scope: string,
    events: readonly NodeSessionEvent[],
    bytes: readonly number[],
    from: number,
    to: number,
  ): void {
    if (disabled || to <= from) return
    if (!idb()) {
      disabled = true
      return
    }
    const owner = currentOwner()
    if (!owner) return
    const db = sessionCacheDbName(owner.server, owner.userId)
    pending.push({
      db,
      gen: generation,
      sessionId,
      scope,
      events: [...events],
      bytes: [...bytes],
      from,
      to,
    })
    if (!flushTimer) flushTimer = setTimeout(() => void flushDiskCache(), DISK_FLUSH_MS)
  },

  /**
   * The cached events of a scope with seq in [from, to], clipped to the range
   * the cache covers (`lo`, `hi`); null when it covers none of it, or there is
   * no cache. F10: `limit` reads at most that many (a chunk): `hi` is then the
   * last seq read, so [lo, hi] is still complete.
   */
  async read<E extends NodeSessionEvent = NodeSessionEvent>(
    sessionId: string,
    scope: string,
    from: number,
    to: number,
    limit?: number,
  ): Promise<DiskRead<E> | null> {
    if (disabled) return null
    await flushDiskCache()
    const gen = generation
    const db = await open()
    if (!db) return null
    try {
      const tx = db.transaction([EVENTS, RANGES], "readwrite")
      const ranges = tx.objectStore(RANGES)
      const r = (await request(ranges.get([sessionId, scope]))) as RangeRecord | undefined
      if (!r) return null
      const lo = Math.max(from, r.lo)
      const hi = Math.min(to, r.hi)
      if (hi < lo) return null
      const recs = (await request(
        tx.objectStore(EVENTS).getAll(scopeBounds(sessionId, scope, lo, hi), limit),
      )) as EventRecord[]
      if (recs.some((x) => x?.v !== RECORD_FORMAT)) {
        dropRange(tx, sessionId, scope, r)
        await done(tx)
        return null
      }
      ranges.put({ ...r, usedAt: clock.now() }, [sessionId, scope])
      await done(tx)
      // F5: a read across a clear answers nothing.
      if (gen !== generation) return null
      const short = limit !== undefined && recs.length >= limit
      return {
        events: recs.map((x) => x.e as E),
        bytes: recs.map((x) => x.b),
        lo,
        hi: short ? (recs.at(-1)?.e.seq ?? hi) : hi,
      }
    } catch (err) {
      log.warn({ err, sessionId }, "reading the session events cache failed")
      return null
    }
  },

  /** One cached event by its seq (a stub's payload), or null. */
  async readOne(sessionId: string, scope: string, seq: number): Promise<NodeSessionEvent | null> {
    const owner = currentOwner()
    if (!owner) return null
    const name = sessionCacheDbName(owner.server, owner.userId)
    for (let i = pending.length - 1; i >= 0; i--) {
      const w = pending[i]
      if (w.db !== name || w.sessionId !== sessionId || w.scope !== scope) continue
      const hit = w.events.find((e) => e.seq === seq)
      if (hit) return hit
    }
    if (disabled) return null
    const db = await open()
    if (!db) return null
    try {
      const tx = db.transaction([EVENTS, RANGES], "readwrite")
      const rec = (await request(tx.objectStore(EVENTS).get([sessionId, scope, seq]))) as
        | EventRecord
        | undefined
      if (rec && rec.v !== RECORD_FORMAT) {
        const r = (await request(tx.objectStore(RANGES).get([sessionId, scope]))) as
          | RangeRecord
          | undefined
        if (r) dropRange(tx, sessionId, scope, r)
        else tx.objectStore(EVENTS).delete([sessionId, scope, seq])
        await done(tx)
        return null
      }
      return rec?.e ?? null
    } catch {
      return null
    }
  },
}

/**
 * Sign-out, a refused refresh (F3), or a quota error: the database of the
 * user it was opened for (else of whoever is signed in) is deleted.
 */
export async function clearDiskCache(): Promise<void> {
  generation++
  pending = []
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (disabled) return
  const owner = currentOwner()
  const name = dbName ?? (owner ? sessionCacheDbName(owner.server, owner.userId) : null)
  closeDb()
  if (name) await deleteSessionCacheDb(name, idb())
}

/** Tests: forget the open database and whether IndexedDB was found (the global may change). */
export async function _resetDiskCache(): Promise<void> {
  pending = []
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  const db = dbPromise ? await dbPromise : null
  db?.close()
  dbPromise = null
  openDb = null
  dbName = null
  dbOwner = null
  disabled = false
  totalBytes = null
  flushing = Promise.resolve()
}

/** Tests: whether the cache is in use (IndexedDB found and opened). */
export async function diskCacheAvailable(): Promise<boolean> {
  return (await open()) !== null
}
