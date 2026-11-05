// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ENDED SESSIONS REFUSE THEIR ACCESS TOKENS AT ONCE.
//
// An access token is a self-contained JWT valid for up to 15 minutes
// (jwt.ts). It names the refresh session that minted it (`sid`). Ending a
// session (sign-out, password change or reset, deactivation, erasure, a
// revoked token family, eviction past the session cap) deletes its row, which
// stops further refreshes, but a copy of an access token it already issued
// would keep working until it expires. This module closes that window without
// a database round trip per request:
//
//  - Every process keeps the ended session ids in memory (`revoked`), each with
//    the time it may be forgotten: the longest access-token lifetime plus a
//    margin, after which no token of that session can still verify.
//  - Ending a session records it locally first (this process refuses at once),
//    then in a Redis sorted set (`session-revoked`, score = forget-at, ms) and
//    on a pub/sub channel, so peer processes record it within milliseconds.
//  - A process loads the whole set on boot, on every reconnect of its Redis
//    subscriber (messages published while it was disconnected are lost), and
//    every RESYNC_INTERVAL_MS as a backstop.
//
// The request path (`isSessionRevoked`) is one Map lookup: no I/O.
//
// REDIS DOWN. The check fails open, and says so in the logs: a token whose
// session ended is refused by the process that ended it, and by peers once
// Redis returns (reconnect resync), but a peer that cannot hear may accept it
// until the token expires (at most 15 minutes). Failing closed would sign out
// every user on a Redis blip, and the window is bounded: the session row is
// gone, so no new access token can be minted for it. User-wide endings
// (password change or reset, deactivation, erasure) have a second, Redis-free
// backstop: they bump the user's auth_version, which the auth middleware
// checks against its 15 s cache (auth-state.ts).

import { authLogger as log } from "~/lib/logger"
import { REDIS_PREFIX, redis, redisSub } from "~/lib/redis"

/** The longest lifetime of an access token carrying a `sid` (jwt.ts, 15 min). */
const ACCESS_TOKEN_MAX_LIFETIME_MS = 15 * 60_000
/** Clock skew and in-flight requests. */
const MARGIN_MS = 2 * 60_000
export const REVOCATION_TTL_MS = ACCESS_TOKEN_MAX_LIFETIME_MS + MARGIN_MS

const REVOKED_KEY = "session-revoked" // the main client prefixes it with REDIS_PREFIX
const CHANNEL = `${REDIS_PREFIX}session-revoked`
const RESYNC_INTERVAL_MS = 60_000
const SWEEP_INTERVAL_MS = 60_000
/** A Redis write that does not answer within this is reported (it stays queued). */
const PUBLISH_WARN_MS = 2_000

/** sid -> when it may be forgotten (epoch ms). */
const revoked = new Map<string, number>()
/** Open sockets per session, closed when the session ends (lib/server.ts). */
const watchers = new Map<string, Set<() => void>>()

function remember(sid: string, forgetAt: number): void {
  if (forgetAt <= Date.now()) return
  const known = revoked.get(sid)
  if (known === undefined || known < forgetAt) revoked.set(sid, forgetAt)
  const closers = watchers.get(sid)
  if (closers) {
    watchers.delete(sid)
    for (const close of closers) {
      try {
        close()
      } catch (err) {
        log.warn({ err, sid }, "closing a socket of an ended session failed")
      }
    }
  }
}

/**
 * True when `sid` names a session that has ended. The hot path of every
 * authenticated request and WebSocket upgrade: a memory lookup, no I/O.
 */
export function isSessionRevoked(sid: string): boolean {
  const forgetAt = revoked.get(sid)
  if (forgetAt === undefined) return false
  if (forgetAt > Date.now()) return true
  revoked.delete(sid)
  return false
}

/**
 * Records that these sessions ended, on this process at once and on every
 * other process through Redis. Call it after the transaction that deleted the
 * rows committed. Never throws and never waits on Redis: a Redis that is down
 * keeps the writes queued (ioredis offline queue) and is logged.
 */
export function revokeSessions(sids: readonly string[], reason: string): void {
  const ids = [...new Set(sids.filter((s) => typeof s === "string" && s.length > 0))]
  if (ids.length === 0) return
  const forgetAt = Date.now() + REVOCATION_TTL_MS
  for (const sid of ids) remember(sid, forgetAt)
  log.info({ event: "sessions_revoked", reason, count: ids.length }, "sessions ended")

  const write = (async () => {
    const zaddArgs: (string | number)[] = []
    for (const sid of ids) zaddArgs.push(forgetAt, sid)
    await redis
      .multi()
      .zadd(REVOKED_KEY, ...zaddArgs)
      .zremrangebyscore(REVOKED_KEY, "-inf", Date.now())
      .pexpire(REVOKED_KEY, REVOCATION_TTL_MS)
      .publish(CHANNEL, JSON.stringify({ sids: ids, forgetAt }))
      .exec()
  })()
  const slow = setTimeout(() => {
    log.error(
      { event: "session_revocation_publish_slow", reason, count: ids.length },
      "session revocation not yet written to Redis: other server processes may accept these sessions' access tokens until it is",
    )
  }, PUBLISH_WARN_MS)
  slow.unref?.()
  void write
    .catch((err) => {
      log.error(
        { err, event: "session_revocation_publish_failed", reason, count: ids.length },
        "session revocation failed to reach Redis: other server processes may accept these sessions' access tokens until they expire",
      )
    })
    .finally(() => clearTimeout(slow))
}

/**
 * Loads every live revocation from Redis into this process. Runs on boot, on
 * each subscriber reconnect and periodically. Never throws.
 */
export async function resyncRevokedSessions(): Promise<number> {
  try {
    const now = Date.now()
    const rows = await redis.zrangebyscore(REVOKED_KEY, now, "+inf", "WITHSCORES")
    let loaded = 0
    for (let i = 0; i + 1 < rows.length; i += 2) {
      const sid = rows[i] as string
      const forgetAt = Number(rows[i + 1])
      if (Number.isFinite(forgetAt)) {
        remember(sid, forgetAt)
        loaded++
      }
    }
    return loaded
  } catch (err) {
    log.error(
      { err, event: "session_revocation_resync_failed" },
      "could not load ended sessions from Redis: access tokens of sessions ended on other processes may be accepted until it succeeds",
    )
    return -1
  }
}

function onMessage(channel: string, message: string): void {
  if (channel !== CHANNEL) return
  try {
    const { sids, forgetAt } = JSON.parse(message) as { sids: unknown; forgetAt: unknown }
    if (!Array.isArray(sids) || typeof forgetAt !== "number") return
    for (const sid of sids) if (typeof sid === "string") remember(sid, forgetAt)
  } catch (err) {
    log.warn({ err, channel }, "failed to parse a session revocation message")
  }
}

function sweep(): void {
  const now = Date.now()
  for (const [sid, forgetAt] of revoked) if (forgetAt <= now) revoked.delete(sid)
}

let initialized = false
let timers: ReturnType<typeof setInterval>[] = []

/**
 * Subscribes this process to session revocations and loads the current set.
 * Idempotent; called once at startup (app.ts).
 */
export async function initSessionRevocation(): Promise<void> {
  if (initialized) return
  initialized = true
  redisSub.on("message", onMessage)
  // ioredis re-subscribes on reconnect; what was published meanwhile is lost,
  // so reload the set every time the subscriber is back.
  redisSub.on("ready", () => {
    void resyncRevokedSessions()
  })
  const resync = setInterval(() => void resyncRevokedSessions(), RESYNC_INTERVAL_MS)
  const sweeper = setInterval(sweep, SWEEP_INTERVAL_MS)
  resync.unref?.()
  sweeper.unref?.()
  timers = [resync, sweeper]
  await redisSub.subscribe(CHANNEL)
  await resyncRevokedSessions()
}

/**
 * Calls `close` when `sid` ends (on this process or another). Answers the
 * function that stops watching; call it when the socket closes. When the
 * session has already ended, `close` runs at once.
 */
export function watchSession(sid: string, close: () => void): () => void {
  if (isSessionRevoked(sid)) {
    close()
    return () => {}
  }
  let set = watchers.get(sid)
  if (!set) {
    set = new Set()
    watchers.set(sid, set)
  }
  set.add(close)
  return () => {
    const current = watchers.get(sid)
    if (!current) return
    current.delete(close)
    if (current.size === 0) watchers.delete(sid)
  }
}

/**
 * Test access to this module's private state. Production code never calls it.
 */
export const SessionRevocationTestAccess = {
  reset(): void {
    revoked.clear()
    watchers.clear()
  },
  /** Applies a pub/sub message as a peer process would receive it. */
  deliver(message: string): void {
    onMessage(CHANNEL, message)
  },
  remember,
  channel: CHANNEL,
  key: REVOKED_KEY,
  size(): number {
    return revoked.size
  },
  watcherCount(sid: string): number {
    return watchers.get(sid)?.size ?? 0
  },
  stopTimers(): void {
    for (const t of timers) clearInterval(t)
    timers = []
  },
}
