// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Persisted cache for the "To prepare" worklist, one localStorage entry per org and filter combo.
//
// Bundled apps get no injected storage API, so this reads and writes `window.localStorage`
// directly through a small `StorageLike` seam -- the seam exists so a test can inject a fake
// storage object without a DOM. Everything here is a plain function on plain data: no Solid, no
// host import, testable without mounting anything (same discipline as prep-row-logic.ts).
//
// The cache used to live only in a module-level variable (PrepGrid.tsx's old `prepListCache`),
// which is exactly why a full browser reload always re-ran the worklist read from cold: the
// variable dies with the page. This module is what makes the cache survive a reload, key it per
// org (so one browser logged into two orgs never cross-serves), and evict a row the instant it
// ships so a stale reload can never paint an order that already went out.

import type { PrepListResult } from "./prep-row-logic"

export const PREP_CACHE_VERSION = "v1"

/** Above this many serialized bytes, skip persisting and fall back to memory only: a worklist
 *  this large is not worth risking localStorage's per-origin quota (and a quota overflow throws,
 *  which savePrepCache already guards, but a check up front avoids doing the write at all). */
const MAX_CACHE_BYTES = 1024 * 1024

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** A no-op storage used whenever `window.localStorage` is unreachable (private browsing, SSR,
 *  a locked-down embed): every call is inert, so callers never need their own null-check. */
export const NULL_STORAGE: StorageLike = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}

/** `window.localStorage`, or NULL_STORAGE when it throws or does not exist. Reading
 *  `localStorage` itself can throw (Safari private mode), so the access has to be guarded too,
 *  not just the calls made on it. */
export function resolveLocalStorage(): StorageLike {
  try {
    if (typeof window === "undefined" || !window.localStorage) return NULL_STORAGE
    // Touch it once: some browsers only throw on first access, not on the property read.
    window.localStorage.getItem("__liaison_boxtal_probe__")
    return window.localStorage
  } catch {
    return NULL_STORAGE
  }
}

export function prepCacheKey(orgId: string, includeExcluded: boolean): string {
  return `liaison:boxtal:prep-list:${PREP_CACHE_VERSION}:${orgId}:${includeExcluded}`
}

/** Decodes the `orgId` claim out of a JWT's payload segment, WITHOUT verifying the signature.
 *  This is never an authorization decision -- it only scopes a local cache key -- so reading the
 *  unverified claim is enough, and a token that fails to parse simply gets no persisted cache
 *  (memory-only for that session) rather than throwing. */
export function decodeOrgIdFromToken(token: string | null | undefined): string | null {
  if (!token) return null
  const parts = token.split(".")
  if (parts.length < 2 || !parts[1]) return null
  try {
    const payload = parts[1]
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
    const json =
      typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("utf8")
    const parsed = JSON.parse(json) as { orgId?: unknown }
    return typeof parsed.orgId === "string" && parsed.orgId.length > 0 ? parsed.orgId : null
  } catch {
    return null
  }
}

export interface PrepCacheEntry {
  value: PrepListResult
  /** Epoch ms the entry was written, independent of the server's own `last_sync_at` field. */
  savedAt: number
}

/** A corrupt, foreign-shaped, or unparseable entry is discarded rather than thrown: a stale
 *  format from a previous cache version (or someone else's localStorage key colliding, or a
 *  half-written entry from a tab that crashed mid `setItem`) must never crash the grid. */
export function loadPrepCache(
  storage: StorageLike,
  orgId: string | null,
  includeExcluded: boolean,
): PrepCacheEntry | null {
  if (!orgId) return null
  try {
    const raw = storage.getItem(prepCacheKey(orgId, includeExcluded))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PrepCacheEntry> | null
    if (
      !parsed ||
      typeof parsed.savedAt !== "number" ||
      !parsed.value ||
      typeof parsed.value !== "object" ||
      !Array.isArray(parsed.value.rows)
    ) {
      return null
    }
    return { value: parsed.value as PrepListResult, savedAt: parsed.savedAt }
  } catch {
    return null
  }
}

/** Writes the whole-list cache entry. Guarded end to end: `localStorage.setItem` throws in
 *  private mode and when the quota is full, and a payload over MAX_CACHE_BYTES is skipped before
 *  the write is even attempted. Either way the caller's in-memory copy (kept separately in
 *  PrepGrid.tsx) is what actually served the page, so a failed persist never loses data the
 *  operator can see -- only the next reload's head start. */
export function savePrepCache(
  storage: StorageLike,
  orgId: string | null,
  includeExcluded: boolean,
  value: PrepListResult,
  now: number,
): void {
  if (!orgId) return
  try {
    const entry: PrepCacheEntry = { value, savedAt: now }
    const serialized = JSON.stringify(entry)
    if (serialized.length > MAX_CACHE_BYTES) return
    storage.setItem(prepCacheKey(orgId, includeExcluded), serialized)
  } catch {
    // Private mode, quota exceeded, or a storage backend that just refuses writes: memory-only
    // for the rest of this tab's life is an acceptable fallback, a thrown exception is not.
  }
}

/**
 * Drops one order from BOTH persisted variants (include_excluded true and false) the instant it
 * ships in this browser, so a reload straight after a ship can never repaint a row that already
 * went out. Belt and braces only: `create_shipment` already hard-refuses a duplicate shipment
 * server-side (shipment.ts, code "duplicate"), so this cannot itself cause a double ship -- it
 * only keeps the stale-paint window from ever showing the shipped row at all.
 */
export function evictShippedRowFromCache(
  storage: StorageLike,
  orgId: string | null,
  orderKey: string,
  now: number,
): void {
  if (!orgId) return
  for (const includeExcluded of [false, true]) {
    const entry = loadPrepCache(storage, orgId, includeExcluded)
    if (!entry) continue
    const rows = entry.value.rows.filter((row) => row.order_key !== orderKey)
    if (rows.length === entry.value.rows.length) continue
    savePrepCache(storage, orgId, includeExcluded, { ...entry.value, rows, total: rows.length }, now)
  }
}
