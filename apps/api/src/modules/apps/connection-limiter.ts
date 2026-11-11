// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shared per-connection limiter: how hard every run of an app, on every
// process and executor, may press one provider account at once.
//
// An app declares its connection's limits in its manifest
// (`connections.<name>.limits`): `concurrency` (calls in flight at once),
// `perSecond` + `burst` (a token bucket: calls started per second, with a
// burst allowance). A provider that says "slow down" pauses the connection
// for everyone: an HTTP 429 or 503 with `Retry-After` on a limited
// connection's call does it by itself, and `ctx.limiter.pause(connection, ms)`
// does it for a throttle a provider reports in its body (a GraphQL cost).
//
// The key is (org, app, connection, identifier): one provider account of one
// org. The state lives in Redis, so the limit holds across api and worker
// processes, the QuickJS pools and the Workers executor (whose egress goes
// through the host bridge too) and across runs. Process memory holds nothing.
//
// The host applies it around the egress it performs itself (sandbox/bridge/
// egress.ts, `ctx.fetch` with `auth.connection`): a permit is taken right
// before the call goes on the wire and given back when its answer is read. A
// sandboxed run never holds a permit across the sandbox boundary, so a run
// that is killed, times out or forgets cannot strand one; a host process that
// dies mid-call frees its concurrency permit when the lease expires
// (`leaseTtlMs`, above the longest egress call).
//
// Waits are bounded by the limit table (run-limits.ts
// `connectionLimiterLimits`): past `maxWaitMs` the call fails with a typed
// `provider_rate_limited` (429) error the caller can retry later; nothing
// queues without end.
//
// Failure rule: FAIL OPEN. When Redis errors or does not answer within
// `redisTimeoutMs`, the call goes out unlimited and the event is logged (at
// most once a minute per process). The limiter protects a provider's quota,
// which the provider also enforces itself (its own 429 is the backstop); a
// Redis outage must not stop every app's egress. Validation is the opposite:
// a malformed limit in a manifest is refused at install, never ignored.
import type Redis from "ioredis"
import { appsLogger as log } from "~/lib/logger"
import { redis as defaultRedis } from "~/lib/redis"
import type { ConnectionLimits } from "~/modules/apps/connection-limits"
import { connectionLimiterLimits } from "~/modules/apps/run-limits"

/** One provider account of one org, as the limiter keys it. */
export interface ConnectionLimiterKey {
  orgId: string
  app: string
  connection: string
  /** The account the call names (`auth.identifier`); "" for the connection's default. */
  identifier?: string
}

/** A call that waited its whole bound for a permit. Retryable later. */
export class ConnectionRateLimitedError extends Error {
  readonly status = 429
  readonly code = "provider_rate_limited"
  constructor(
    readonly connection: string,
    readonly waitedMs: number,
  ) {
    super(
      `The "${connection}" connection is at its rate limit: no call slot within ${waitedMs} ms. Try again later.`,
    )
    this.name = "ConnectionRateLimitedError"
  }
}

function keyBase(key: ConnectionLimiterKey): string {
  // One hash tag for the three keys, so a cluster keeps them on one slot.
  const parts = [key.orgId, key.app, key.connection, key.identifier ?? ""].map(encodeURIComponent)
  return `applimit:{${parts.join(":")}}`
}

const keysOf = (key: ConnectionLimiterKey) => {
  const base = keyBase(key)
  return { leases: `${base}:leases`, bucket: `${base}:bucket`, pause: `${base}:pause` }
}

// KEYS: leases (zset lease -> expiry ms), bucket (hash tokens/ts), pause (string, PX).
// ARGV: lease id, concurrency (0: none), perSecond (0: none), burst, lease ttl ms.
// Returns {1, 0} when granted (the token taken, the lease added), else
// {0, wait}: the ms to wait before asking again, -1 when the wait is for a
// concurrency slot (no time is known: the caller polls).
const ACQUIRE_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local paused = redis.call('PTTL', KEYS[3])
if paused > 0 then return {0, paused} end
local conc = tonumber(ARGV[2])
if conc > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
  if redis.call('ZCARD', KEYS[1]) >= conc then return {0, -1} end
end
local rate = tonumber(ARGV[3])
if rate > 0 then
  local burst = tonumber(ARGV[4])
  local b = redis.call('HMGET', KEYS[2], 'tokens', 'ts')
  local tokens = tonumber(b[1]) or burst
  local ts = tonumber(b[2]) or now
  if now > ts then tokens = math.min(burst, tokens + (now - ts) * rate / 1000) end
  if tokens < 1 then
    redis.call('HSET', KEYS[2], 'tokens', tostring(tokens), 'ts', tostring(now))
    return {0, math.ceil((1 - tokens) * 1000 / rate)}
  end
  redis.call('HSET', KEYS[2], 'tokens', tostring(tokens - 1), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[2], math.ceil(burst * 1000 / rate) + 1000)
end
if conc > 0 then
  local ttl = tonumber(ARGV[5])
  redis.call('ZADD', KEYS[1], now + ttl, ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ttl + 1000)
end
return {1, 0}
`

// KEYS: pause. ARGV: ms. Extends the pause, never shortens it. Returns the pause now set.
const PAUSE_LUA = `
local cur = redis.call('PTTL', KEYS[1])
local ms = tonumber(ARGV[1])
if cur < ms then
  redis.call('SET', KEYS[1], '1', 'PX', ms)
  return ms
end
return cur
`

let client: Pick<Redis, "eval" | "zrem"> = defaultRedis
let lastFailOpenLog = 0

/** Test seams. */
export const ConnectionLimiterTestAccess = {
  /** Use this client instead of the shared one (null restores). */
  setRedis(r: Pick<Redis, "eval" | "zrem"> | null): void {
    client = r ?? defaultRedis
    lastFailOpenLog = 0
  },
  keysOf,
}

class LimiterTimeout extends Error {}

/** A Redis round trip, bounded: the shared client queues commands while it reconnects. */
async function bounded<T>(op: () => Promise<T>): Promise<T> {
  const ms = connectionLimiterLimits().redisTimeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LimiterTimeout(`no answer within ${ms} ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function failOpen(err: unknown, key: ConnectionLimiterKey, what: string): void {
  const now = Date.now()
  if (now - lastFailOpenLog < 60_000) return
  lastFailOpenLog = now
  log.warn(
    { err, app: key.app, connection: key.connection, orgId: key.orgId },
    `connection limiter: Redis failed during ${what}; calls go out unlimited (fail open)`,
  )
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })

const NOOP_RELEASE = async (): Promise<void> => {}

/**
 * Wait for a permit to call the provider account `key` under `limits`
 * (pauses are honoured even when `limits` is empty). Resolves to the
 * permit's release (idempotent, never throws). Rejects with
 * ConnectionRateLimitedError after `maxWaitMs`, or with the signal's reason.
 */
export async function acquireConnectionPermit(
  key: ConnectionLimiterKey,
  limits: ConnectionLimits,
  opts: { maxWaitMs: number; signal?: AbortSignal },
): Promise<() => Promise<void>> {
  const { leases, bucket, pause } = keysOf(key)
  const conc = limits.concurrency ?? 0
  const rate = limits.perSecond ?? 0
  const burst = limits.burst ?? Math.max(1, Math.ceil(rate))
  const leaseTtl = connectionLimiterLimits().leaseTtlMs
  const lease = `${process.pid}:${crypto.randomUUID()}`
  const started = Date.now()
  let poll = 20
  for (;;) {
    let res: [number, number]
    try {
      res = (await bounded(() =>
        client.eval(
          ACQUIRE_LUA,
          3,
          leases,
          bucket,
          pause,
          lease,
          String(conc),
          String(rate),
          String(burst),
          String(leaseTtl),
        ),
      )) as [number, number]
    } catch (err) {
      failOpen(err, key, "acquire")
      return NOOP_RELEASE
    }
    if (Number(res[0]) === 1) {
      if (conc === 0) return NOOP_RELEASE
      let released = false
      return async () => {
        if (released) return
        released = true
        try {
          await bounded(() => client.zrem(leases, lease))
        } catch (err) {
          // The lease expires by itself (leaseTtlMs).
          failOpen(err, key, "release")
        }
      }
    }
    const waited = Date.now() - started
    const left = opts.maxWaitMs - waited
    if (left <= 0) throw new ConnectionRateLimitedError(key.connection, waited)
    const hint = Number(res[1])
    let wait: number
    if (hint < 0) {
      // A concurrency slot: poll, backing off, with jitter so waiters spread.
      wait = poll + Math.floor(Math.random() * poll)
      poll = Math.min(250, Math.ceil(poll * 1.5))
    } else {
      wait = Math.max(1, hint)
    }
    if (wait > left) {
      // The permit cannot come in time: fail now instead of sleeping for nothing.
      if (hint >= 0) throw new ConnectionRateLimitedError(key.connection, waited)
      wait = left
    }
    await sleep(wait, opts.signal)
  }
}

/**
 * Pause every call to the provider account `key` for `ms` (capped at the
 * table's `maxPauseMs`; an existing longer pause stays). Returns the pause
 * in force, or null when Redis failed (fail open: nothing is paused).
 */
export async function pauseConnection(
  key: ConnectionLimiterKey,
  ms: number,
): Promise<number | null> {
  const capped = Math.min(Math.max(1, Math.ceil(ms)), connectionLimiterLimits().maxPauseMs)
  try {
    const res = await bounded(() => client.eval(PAUSE_LUA, 1, keysOf(key).pause, String(capped)))
    return Number(res)
  } catch (err) {
    failOpen(err, key, "pause")
    return null
  }
}

/**
 * The pause a provider answer asks for: a 429 or 503 with `Retry-After`
 * (seconds or an HTTP date), in ms; null otherwise.
 */
export function retryAfterPauseMs(
  status: number,
  headers: { get(name: string): string | null },
  now = Date.now(),
): number | null {
  if (status !== 429 && status !== 503) return null
  const raw = headers.get("retry-after")?.trim()
  if (!raw) return null
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const ms = Math.ceil(Number(raw) * 1000)
    return ms > 0 ? ms : null
  }
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return null
  const ms = at - now
  return ms > 0 ? ms : null
}
