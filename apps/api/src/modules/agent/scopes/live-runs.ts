// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Which runs are live on a thread (an agent turn), across the cell. The untrusted-content mark is
 * reset when a new turn starts (scopes/taint.ts), and that reset must not wipe the mark of another
 * run still going on the same thread: a second tab, a routine mid-tick, a background turn, on this
 * process or another one.
 *
 * Keys (under the client's key prefix):
 * - `live-runs:{key}`          ZSET, member `runId|instanceId`, score `startedAt + LIVE_RUN_TTL_MS`
 * - `live-runs:by-inst:{inst}` set of the `{key}`s where `inst` holds a run. Every write that adds
 *   to it sets its TTL to LIVE_RUN_TTL_MS, so it lives at least as long as the newest entry it
 *   indexes (an entry is ignored past that TTL anyway) and an instance that died without a sweep
 *   leaves nothing behind for good.
 *
 * This process's runs are also kept in a local table, the source of truth for its own runs: a
 * check reads it first, and an instance whose heartbeat record comes back after a lapse rewrites
 * its entries from it (`republishOwn`, P2-1). Another instance's entry counts only while that
 * instance's heartbeat record exists; a read drops expired entries and dead-instance entries, and
 * the leader's sweep deletes a dead instance's entries (`cleanupDeadInstance`). An entry past the
 * TTL is ignored, so a run whose end was never recorded holds the reset back for a bounded time.
 *
 * Failure direction (P2-3): the read is bounded (1 s) and fails CLOSED: on a Redis error or
 * timeout another run is assumed live, so the mark is kept.
 *
 * ioredis prefixes `KEYS[]` only; every script that builds a key in Lua receives the prefix as
 * `ARGV[1]`.
 */
import { INSTANCE_ID } from "~/infra/instance-id"
import {
  type InstanceRegistry,
  LIVE_INSTANCE_LUA,
  onDeadInstance,
  onInstanceRecovered,
} from "~/infra/instance-registry"
import { boundedBy } from "~/lib/bounded"
import { rootLogger } from "~/lib/logger"
import { REDIS_PREFIX, redis } from "~/lib/redis"

const log = rootLogger.child({ module: "live-runs" })

export const LIVE_RUN_TTL_MS = 30 * 60_000

/** The ioredis subset this module uses, so a test can hand it a client that hangs. */
export interface LiveRunRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
}

const runsKey = (key: string) => `live-runs:${key}`
const byInstKey = (inst: string) => `live-runs:by-inst:${inst}`
const member = (runId: string, inst: string) => `${runId}|${inst}`

// KEYS: zset, own by-inst set. ARGV: member, score, key, ttl ms.
const BEGIN_LUA = `
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
return 1
`

// KEYS: zset, own by-inst set. ARGV: member, key, last local run on key (1/0).
const END_LUA = `
redis.call('ZREM', KEYS[1], ARGV[1])
if ARGV[3] == '1' then redis.call('SREM', KEYS[2], ARGV[2]) end
return 1
`

// KEYS: zset. ARGV: prefix, now ms, own run id, self instance id. 1 = another run is live.
// This instance's own entries are skipped: its local table answers for them.
const HAS_OTHER_LUA = `${LIVE_INSTANCE_LUA}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
local found = 0
for _, m in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
  local sep = string.find(m, '|', 1, true)
  if sep then
    local run = string.sub(m, 1, sep - 1)
    local inst = string.sub(m, sep + 1)
    if inst ~= ARGV[4] and run ~= ARGV[3] then
      if redis.call('EXISTS', live_inst_key(ARGV[1], inst)) == 1 then
        found = 1
      else
        redis.call('ZREM', KEYS[1], m)
      end
    end
  end
end
return found
`

// KEYS: the instance's by-inst set. ARGV: prefix, instance id.
// Removes every entry the instance holds, then the set.
const DROP_INSTANCE_BODY = `
local suffix = '|' .. ARGV[2]
for _, k in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  local zkey = ARGV[1] .. 'live-runs:' .. k
  for _, m in ipairs(redis.call('ZRANGE', zkey, 0, -1)) do
    if string.sub(m, -#suffix) == suffix then redis.call('ZREM', zkey, m) end
  end
end
redis.call('DEL', KEYS[1])
`

const CLEANUP_LUA = `${DROP_INSTANCE_BODY}
return 1
`

// KEYS: own by-inst set. ARGV: prefix, self, ttl ms, then key, member, score triples.
// Replaces this instance's entries with the local table.
const REPUBLISH_LUA = `${DROP_INSTANCE_BODY}
for i = 4, #ARGV, 3 do
  local zkey = ARGV[1] .. 'live-runs:' .. ARGV[i]
  redis.call('ZADD', zkey, ARGV[i + 2], ARGV[i + 1])
  redis.call('PEXPIRE', zkey, ARGV[3])
  redis.call('SADD', KEYS[1], ARGV[i])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
end
return 1
`

export class LiveRunTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`live runs: Redis did not answer ${what} within ${ms} ms`)
    this.name = "LiveRunTimeout"
  }
}

function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return boundedBy(p, ms, () => new LiveRunTimeout(what, ms))
}

export class LiveRuns {
  /** key → runId → startedAt, for this instance's runs. */
  private readonly local = new Map<string, Map<string, number>>()
  private readonly commandTimeoutMs: number
  private readonly ttlMs: number

  constructor(
    private readonly client: LiveRunRedis,
    private readonly instanceId: string,
    private readonly prefix: string,
    opts: { commandTimeoutMs?: number; ttlMs?: number } = {},
  ) {
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 1_000
    this.ttlMs = opts.ttlMs ?? LIVE_RUN_TTL_MS
  }

  /**
   * Record a live run under `key`. The local entry is set at once; the Redis write is awaited,
   * bounded, so another instance's `hasOther` sees the run once this resolves. It never rejects:
   * a write that fails or times out is logged, and the local entry still answers for this
   * instance. The returned function ends the run (idempotent) and resolves once the removal
   * answered or timed out.
   */
  async begin(key: string, runId: string = crypto.randomUUID()): Promise<() => Promise<void>> {
    const startedAt = Date.now()
    let runs = this.local.get(key)
    if (!runs) {
      runs = new Map()
      this.local.set(key, runs)
    }
    runs.set(runId, startedAt)
    const m = member(runId, this.instanceId)
    try {
      await bounded(
        this.client.eval(
          BEGIN_LUA,
          2,
          runsKey(key),
          byInstKey(this.instanceId),
          m,
          String(startedAt + this.ttlMs),
          key,
          String(this.ttlMs),
        ),
        this.commandTimeoutMs,
        "beginLiveRun",
      )
    } catch (err) {
      log.warn({ err, key }, "live run not recorded in Redis in time")
    }
    let ended = false
    return async () => {
      if (ended) return
      ended = true
      const current = this.local.get(key)
      current?.delete(runId)
      const last = !current || current.size === 0
      if (last) this.local.delete(key)
      try {
        await bounded(
          this.client.eval(
            END_LUA,
            2,
            runsKey(key),
            byInstKey(this.instanceId),
            m,
            key,
            last ? "1" : "0",
          ),
          this.commandTimeoutMs,
          "endLiveRun",
        )
      } catch (err) {
        log.warn({ err, key }, "live run end did not reach Redis in time")
      }
    }
  }

  /** Is a run other than `ownRunId` live under `key`, on any instance? Fails closed (true). */
  async hasOther(key: string, ownRunId?: string): Promise<boolean> {
    const now = Date.now()
    const runs = this.local.get(key)
    if (runs) {
      for (const [runId, startedAt] of runs) {
        if (runId === ownRunId) continue
        if (now - startedAt < this.ttlMs) return true
      }
    }
    try {
      const res = await bounded(
        this.client.eval(
          HAS_OTHER_LUA,
          1,
          runsKey(key),
          this.prefix,
          String(now),
          ownRunId ?? "",
          this.instanceId,
        ),
        this.commandTimeoutMs,
        "hasOtherLiveRun",
      )
      return Number(res) === 1
    } catch (err) {
      log.warn({ err, key }, "live runs unreadable: keeping the mark (fails closed)")
      return true
    }
  }

  /** The leader's sweep: drop every run a dead instance held. */
  async cleanupDeadInstance(deadId: string): Promise<void> {
    await bounded(
      this.client.eval(CLEANUP_LUA, 1, byInstKey(deadId), this.prefix, deadId),
      this.commandTimeoutMs,
      "cleanupDeadInstance",
    )
  }

  /** After a lapse: replace this instance's entries with the runs it still holds. */
  async republishOwn(): Promise<void> {
    const triples: string[] = []
    for (const [key, runs] of this.local) {
      for (const [runId, startedAt] of runs) {
        triples.push(key, member(runId, this.instanceId), String(startedAt + this.ttlMs))
      }
    }
    await bounded(
      this.client.eval(
        REPUBLISH_LUA,
        1,
        byInstKey(this.instanceId),
        this.prefix,
        this.instanceId,
        String(this.ttlMs),
        ...triples,
      ),
      this.commandTimeoutMs,
      "republishOwn",
    )
  }
}

/** Wire a live-run table into a registry's dead-instance and recovery hooks. */
export function registerLiveRunHooks(
  reg: Pick<InstanceRegistry, "onDeadInstance" | "onInstanceRecovered">,
  runs: LiveRuns,
): void {
  reg.onDeadInstance("agent-live-runs", (deadId) => runs.cleanupDeadInstance(deadId))
  reg.onInstanceRecovered("agent-live-runs", () => runs.republishOwn())
}

// ── the process's live-run table ──────────────────────────────────────────

const processRuns = new LiveRuns(redis, INSTANCE_ID, REDIS_PREFIX)
registerLiveRunHooks({ onDeadInstance, onInstanceRecovered }, processRuns)

export function threadRunKey(threadId: string): string {
  return `thread:${threadId}`
}

/**
 * Record a live run under `key`, visible cell-wide once it resolves (bounded, never rejects); the
 * returned function ends it (idempotent, never rejects).
 */
export function beginLiveRun(key: string, runId?: string): Promise<() => Promise<void>> {
  return processRuns.begin(key, runId)
}

/** Is a run other than `ownRunId` live under `key`, on any instance? Fails closed (true). */
export function hasOtherLiveRun(key: string, ownRunId?: string): Promise<boolean> {
  return processRuns.hasOther(key, ownRunId)
}
