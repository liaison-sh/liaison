// SPDX-License-Identifier: FSL-1.1-ALv2
import { eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { publishRedis, REDIS_PREFIX, redisSub } from "~/lib/redis"
import { orgRefusesNonSessionCredentials } from "~/modules/cloud/suspension"
import { isDemoOrgExpiredNow } from "~/modules/demo/demo-expiry"

const log = rootLogger.child({ module: "auth/auth-state" })

// Cross-process auth-cache invalidation. Each process keeps a 15s in-memory
// cache of (auth_version, permission_version, status) per user; a credential
// revocation (password change, deactivate, TOTP disable, scope change, …) bumps
// the persisted version, but peer processes/replicas would keep serving the
// stale cached version until their TTL lapses. Broadcasting the invalidation
// over Redis pub/sub drops the entry everywhere immediately so a revoked token
// stops authenticating on every node. The channel carries REDIS_PREFIX so
// worker-isolated E2E runs don't cross-invalidate each other's caches.
const AUTH_CACHE_INVALIDATE_CHANNEL = `${REDIS_PREFIX}auth-cache:invalidate`

export interface UserAuthState {
  authVersion: number
  permissionVersion: number
  status: string
}

interface GetUserAuthStateOptions {
  expectedAuthVersion?: number
  expectedPermissionVersion?: number
  forceFresh?: boolean
}

const AUTH_CACHE_TTL_MS = 15_000
const AUTH_CACHE_MAX = 10_000
const authCache = new Map<string, UserAuthState & { expiresAt: number }>()

const authCacheSweep = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of authCache) {
    if (entry.expiresAt <= now) authCache.delete(key)
  }
  if (authCache.size > AUTH_CACHE_MAX) {
    const excess = authCache.size - AUTH_CACHE_MAX
    const keys = authCache.keys()
    for (let i = 0; i < excess; i++) {
      const { value } = keys.next()
      if (value) authCache.delete(value)
    }
  }
}, 60_000)
authCacheSweep.unref()

/** Drop the local cache entry (this process only) without re-broadcasting. */
function invalidateAuthCacheLocal(userId?: string): void {
  if (userId) {
    authCache.delete(userId)
  } else {
    authCache.clear()
  }
}

/**
 * Invalidate the cached auth state for a user (or all users when `userId` is
 * omitted) across every process. Drops the local entry immediately and
 * broadcasts over Redis pub/sub so peer processes/replicas drop theirs too —
 * without this, a revoked credential keeps authenticating on other nodes until
 * their 15s TTL lapses. The Redis publish is best-effort: the local drop is the
 * floor, and the bumped `permission_version`/`auth_version` is the durable
 * backstop (peers re-fetch from the DB once their TTL expires regardless).
 */
export function invalidateAuthCache(userId?: string): void {
  invalidateAuthCacheLocal(userId)
  void publishRedis(
    AUTH_CACHE_INVALIDATE_CHANNEL,
    JSON.stringify({ userId: userId ?? null }),
  ).catch((err) => {
    log.warn({ err, userId }, "auth-cache invalidation publish failed")
  })
}

let subscribed = false

/**
 * Subscribe the dedicated Redis subscriber connection to the auth-cache
 * invalidation channel. Idempotent; called once at startup. Peer processes that
 * receive a message drop the named entry locally (without re-publishing, so a
 * single revocation doesn't fan out endlessly).
 */
export async function initAuthCacheInvalidation(): Promise<void> {
  if (subscribed) return
  subscribed = true
  redisSub.on("message", (channel, message) => {
    if (channel !== AUTH_CACHE_INVALIDATE_CHANNEL) return
    try {
      const { userId } = JSON.parse(message) as { userId: string | null }
      invalidateAuthCacheLocal(userId ?? undefined)
    } catch (err) {
      log.warn({ err, channel }, "failed to parse auth-cache invalidation message")
    }
  })
  await redisSub.subscribe(AUTH_CACHE_INVALIDATE_CHANNEL)
}

async function fetchUserAuthState(userId: string, orgId: string): Promise<UserAuthState | null> {
  const [user] = await withPrivilegedDb(orgId, "auth-check", (tx) =>
    tx
      .select({
        authVersion: users.authVersion,
        permissionVersion: users.permissionVersion,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )

  if (!user) {
    authCache.delete(userId)
    return null
  }

  authCache.set(userId, { ...user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS })
  return user
}

export async function getUserAuthState(
  userId: string,
  orgId: string,
  opts: GetUserAuthStateOptions = {},
): Promise<UserAuthState | null> {
  const cached = opts.forceFresh ? null : authCache.get(userId)
  const now = Date.now()

  if (!cached || cached.expiresAt <= now) {
    return fetchUserAuthState(userId, orgId)
  }

  const expectedMismatch =
    (opts.expectedAuthVersion !== undefined && cached.authVersion !== opts.expectedAuthVersion) ||
    (opts.expectedPermissionVersion !== undefined &&
      cached.permissionVersion !== opts.expectedPermissionVersion)

  if (expectedMismatch) {
    return fetchUserAuthState(userId, orgId)
  }

  return cached
}

export async function isUserAuthCurrent(
  params: {
    userId: string
    orgId: string
    authVersion?: number
    permissionVersion?: number
  },
  opts: GetUserAuthStateOptions = {},
): Promise<boolean> {
  const authState = await getUserAuthState(params.userId, params.orgId, {
    expectedAuthVersion: params.authVersion,
    expectedPermissionVersion: params.permissionVersion,
    forceFresh: opts.forceFresh,
  })

  if (!authState || authState.status !== "active") return false
  if (params.authVersion !== undefined && authState.authVersion !== params.authVersion) return false
  if (
    params.permissionVersion !== undefined &&
    authState.permissionVersion !== params.permissionVersion
  ) {
    return false
  }

  // A live websocket (and a ticket minted before expiry) of an expired demo
  // workspace stops being current.
  if (await isDemoOrgExpiredNow(params.orgId)) return false
  // Nor does one of a managed org suspended or closed for billing: no websocket
  // credential is an admin's export or Billing session (cloud/suspension.ts).
  if (await orgRefusesNonSessionCredentials(params.orgId)) return false

  return true
}
