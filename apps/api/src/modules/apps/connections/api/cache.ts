// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Redis caches of one API connection (the oauth2 token, customer lookups).
 * Every key carries the adapter's content hash and the credential version
 * (an HMAC of the credential account's row id and update time under the
 * server secret: never derived from the credential values), so a changed
 * adapter or credential can never be served a stale entry, and every key is
 * indexed per connection so an adapter PUT/DELETE or a credential post
 * deletes them all.
 */
import { redis } from "~/lib/redis"
import type { ApiConn } from "./declarations"

export type ApiConnectorCacheKind = "token" | "customer"

const PREFIX = "api-connection"

export function cacheKeyFor(
  kind: ApiConnectorCacheKind,
  conn: ApiConn,
  identifier: string,
  adapterHash: string,
  credentialVersion: string,
  ...rest: string[]
): string {
  return [
    PREFIX,
    kind,
    ...connParts(conn),
    identifier,
    adapterHash,
    credentialVersion,
    ...rest,
  ].join(":")
}

function connParts(conn: ApiConn): string[] {
  return [conn.orgId, conn.app, conn.connection]
}

function indexKey(conn: ApiConn, identifier: string): string {
  return [PREFIX, "keys", ...connParts(conn), identifier].join(":")
}

/** Index `key` under its connection so invalidation finds it. */
export async function rememberCacheKey(
  conn: ApiConn,
  identifier: string,
  key: string,
  ttlSeconds: number,
): Promise<void> {
  const idx = indexKey(conn, identifier)
  await redis.sadd(idx, key)
  const current = await redis.ttl(idx)
  if (current < ttlSeconds) await redis.expire(idx, ttlSeconds)
}

/** Delete every cached entry of one connection. Best-effort: Redis down is not an error. */
export async function invalidateConnectionCaches(conn: ApiConn, identifier: string): Promise<void> {
  const idx = indexKey(conn, identifier)
  try {
    const keys = await redis.smembers(idx)
    if (keys.length > 0) await redis.del(...keys)
    await redis.del(idx)
  } catch {
    // A cache that cannot be reached cannot serve stale entries either.
  }
}

/**
 * Delete one connection's cached customer lookups, keeping its token. A write
 * through it (a contact created on approval) can change who a lookup finds,
 * and a miss cached just before would hide the new record for its TTL.
 */
export async function forgetCustomerLookups(conn: ApiConn, identifier: string): Promise<void> {
  const idx = indexKey(conn, identifier)
  const customer = `${PREFIX}:customer:`
  try {
    const keys = (await redis.smembers(idx)).filter((k) => k.startsWith(customer))
    if (keys.length === 0) return
    await redis.del(...keys)
    await redis.srem(idx, ...keys)
  } catch {
    // A cache that cannot be reached cannot serve stale entries either.
  }
}
