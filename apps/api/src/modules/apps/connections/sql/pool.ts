// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The connection pools the platform holds for SQL connections, one per
// (org, app, connection, account identifier) in each server process. App code
// never holds a database connection: a run asks the host (`ctx.sql.*`), the
// host runs the statement on the pool of that connection and answers rows.
//
// A pool is created on first use, reused while the credentials it was built
// from are unchanged (a saved change replaces it and closes the old one), and
// closed when:
//   - its account is disconnected (`closeSqlPools`, called by the connection
//     service) or no longer resolves (the next call finds no account);
//   - it has been unused for `poolIdleMs` (a sweep every minute);
//   - more than `poolsMax` pools are open: the least recently used one goes.
// A pool that is running a call is never closed by the sweep or the bound;
// a replaced or disconnected one finishes its running statements first
// (postgres.js `end` waits up to 5 s).

import { createHash } from "node:crypto"
import { rootLogger } from "~/lib/logger"
import { sqlCallLimits } from "~/modules/apps/run-limits"
import { buildTransport, type DatabaseCredentials } from "./credentials"
import type { DbTransport } from "./transport"

const log = rootLogger.child({ module: "sql-connection-pools" })

export interface SqlPoolKey {
  orgId: string
  appName: string
  connectionName: string
  identifier: string
}

interface PoolEntry {
  transport: DbTransport
  credsHash: string
  key: SqlPoolKey | null
  lastUsedAt: number
  busy: number
}

/** The pool scope of a shared (demo warehouse) transport: one pool for every org. */
const SHARED_POOL_SCOPE = "__shared__"

const pools = new Map<string, PoolEntry>()
let sweepTimer: ReturnType<typeof setInterval> | null = null

function keyString(key: SqlPoolKey): string {
  return [key.orgId, key.appName, key.connectionName, key.identifier].join("::")
}

function credsHashOf(creds: DatabaseCredentials): string {
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(creds).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex")
}

function closeEntry(entry: PoolEntry, reason: string): void {
  log.debug({ reason, key: entry.key }, "closing SQL connection pool")
  void entry.transport.close().catch((err) => {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "SQL pool close failed")
  })
}

function ensureSweep(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => sweepIdleSqlPools(), 60_000)
  sweepTimer.unref?.()
}

/** Closes every idle pool unused for `poolIdleMs`. Returns how many were closed. */
export function sweepIdleSqlPools(now = Date.now()): number {
  const { poolIdleMs } = sqlCallLimits()
  let closed = 0
  for (const [k, entry] of pools) {
    if (entry.busy > 0 || now - entry.lastUsedAt < poolIdleMs) continue
    pools.delete(k)
    closeEntry(entry, "idle")
    closed += 1
  }
  if (pools.size === 0 && sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  return closed
}

function enforceBound(keep: string): void {
  const { poolsMax } = sqlCallLimits()
  if (pools.size <= poolsMax) return
  // Map order is insertion order and every use re-inserts: the first idle
  // entries are the least recently used.
  for (const [k, entry] of pools) {
    if (pools.size <= poolsMax) break
    if (k === keep || entry.busy > 0) continue
    pools.delete(k)
    closeEntry(entry, "bound")
  }
}

/**
 * The transport of one connection, from the pool. `creds.sharedPool` (set by
 * the host only, never read from a stored connection) shares one pool across
 * every org: the demo warehouse, the same login for all demo orgs.
 */
function acquire(
  key: SqlPoolKey,
  creds: DatabaseCredentials,
  factory: (creds: DatabaseCredentials) => DbTransport,
): { k: string; entry: PoolEntry } {
  const k = creds.sharedPool
    ? keyString({
        orgId: SHARED_POOL_SCOPE,
        appName: key.appName,
        connectionName: key.connectionName,
        identifier: creds.sharedPool,
      })
    : keyString(key)
  const credsHash = credsHashOf(creds)
  const existing = pools.get(k)
  let entry: PoolEntry
  if (existing?.credsHash === credsHash) {
    entry = existing
    pools.delete(k)
  } else {
    entry = {
      transport: factory(creds),
      credsHash,
      key: creds.sharedPool ? null : key,
      lastUsedAt: Date.now(),
      busy: 0,
    }
    if (existing) {
      pools.delete(k)
      closeEntry(existing, "credentials changed")
    }
  }
  entry.lastUsedAt = Date.now()
  pools.set(k, entry)
  enforceBound(k)
  ensureSweep()
  return { k, entry }
}

/**
 * Runs `fn` on the pooled transport of a connection. The pool counts the call
 * as running, so neither the idle sweep nor the bound closes it meanwhile.
 */
export async function withSqlTransport<T>(
  key: SqlPoolKey,
  creds: DatabaseCredentials,
  fn: (transport: DbTransport) => Promise<T>,
  factory: (creds: DatabaseCredentials) => DbTransport = buildTransport,
): Promise<T> {
  const { entry } = acquire(key, creds, factory)
  entry.busy += 1
  try {
    return await fn(entry.transport)
  } finally {
    entry.busy -= 1
    entry.lastUsedAt = Date.now()
  }
}

/**
 * Closes the pools of an org's connection: every one of the app when
 * `connectionName` is absent, every account of the connection when
 * `identifier` is absent. Returns how many were closed.
 */
export function closeSqlPools(match: {
  orgId: string
  appName: string
  connectionName?: string
  identifier?: string
}): number {
  let closed = 0
  for (const [k, entry] of pools) {
    const key = entry.key
    if (!key || key.orgId !== match.orgId || key.appName !== match.appName) continue
    if (match.connectionName !== undefined && key.connectionName !== match.connectionName) continue
    if (match.identifier !== undefined && key.identifier !== match.identifier) continue
    pools.delete(k)
    closeEntry(entry, "connection removed")
    closed += 1
  }
  return closed
}

/** Test access to the pool registry; production code never calls it. */
export const SqlPoolTestAccess = {
  reset(): void {
    for (const entry of pools.values()) closeEntry(entry, "reset")
    pools.clear()
    if (sweepTimer) clearInterval(sweepTimer)
    sweepTimer = null
  },
  size(): number {
    return pools.size
  },
  keys(): string[] {
    return [...pools.keys()]
  },
  /** Marks every pool as last used `ms` ago. */
  age(ms: number): void {
    for (const entry of pools.values()) entry.lastUsedAt -= ms
  },
}
