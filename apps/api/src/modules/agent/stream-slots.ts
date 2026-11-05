// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The per-user concurrent agent-stream cap, counted across the cell (S5, A12).
 *
 * Keys (under the client's key prefix):
 * - `agent:streams:{userId}`          hash instanceId → slots held there
 * - `agent:streams:by-inst:{inst}`    set of user ids holding a slot on `inst`
 *
 * A take sums the fields of LIVE instances only (heartbeat record present; the
 * taking instance always counts itself), refuses at or above the cap, else
 * increments its own field. A SIGKILLed replica's slots stop counting as soon
 * as its record lapses; the leader's sweep then deletes them
 * (`cleanupDeadInstance`). An instance whose record comes back after a lapse
 * rewrites its own fields from its local table (`republishOwn`, P2-1).
 *
 * Failure direction (P2-3): the take is bounded (1 s) and fails OPEN with a
 * warning log. A take that lands after its timeout is counted locally once it
 * lands and released then if its stream already ended, so no phantom slot is
 * left behind.
 *
 * ioredis prefixes `KEYS[]` only; every script that builds a key in Lua
 * receives the prefix as `ARGV[1]`.
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

const log = rootLogger.child({ module: "agent-stream-slots" })

/** The ioredis subset this module uses, so a test can hand it a client that hangs. */
export interface SlotRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
}

export type StreamSlot = { ok: true; release: () => Promise<void> } | { ok: false }

const userKey = (userId: string) => `agent:streams:${userId}`
const byInstKey = (inst: string) => `agent:streams:by-inst:${inst}`

// KEYS: user hash, own by-inst set. ARGV: prefix, self, cap, userId. 1 = taken.
const TAKE_LUA = `${LIVE_INSTANCE_LUA}
local prefix = ARGV[1]
local self_inst = ARGV[2]
local fields = redis.call('HGETALL', KEYS[1])
local total = 0
for i = 1, #fields, 2 do
  local inst = fields[i]
  local n = tonumber(fields[i + 1]) or 0
  if n > 0 and (inst == self_inst or redis.call('EXISTS', live_inst_key(prefix, inst)) == 1) then
    total = total + n
  end
end
if total >= tonumber(ARGV[3]) then return 0 end
redis.call('HINCRBY', KEYS[1], self_inst, 1)
redis.call('SADD', KEYS[2], ARGV[4])
return 1
`

// KEYS: user hash, own by-inst set. ARGV: self, userId. Never leaves a field at or below 0.
const RELEASE_LUA = `
local n = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
if n <= 0 then
  redis.call('HDEL', KEYS[1], ARGV[1])
  redis.call('SREM', KEYS[2], ARGV[2])
end
return n
`

// KEYS: the dead instance's by-inst set. ARGV: prefix, dead id.
const CLEANUP_LUA = `
for _, u in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  redis.call('HDEL', ARGV[1] .. 'agent:streams:' .. u, ARGV[2])
end
redis.call('DEL', KEYS[1])
return 1
`

// KEYS: own by-inst set. ARGV: prefix, self, then userId, count pairs.
// Replaces this instance's fields with the local table.
const REPUBLISH_LUA = `
for _, u in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  redis.call('HDEL', ARGV[1] .. 'agent:streams:' .. u, ARGV[2])
end
redis.call('DEL', KEYS[1])
for i = 3, #ARGV, 2 do
  redis.call('HSET', ARGV[1] .. 'agent:streams:' .. ARGV[i], ARGV[2], ARGV[i + 1])
  redis.call('SADD', KEYS[1], ARGV[i])
end
return 1
`

export class StreamSlotTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`stream slots: Redis did not answer ${what} within ${ms} ms`)
    this.name = "StreamSlotTimeout"
  }
}

function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return boundedBy(p, ms, () => new StreamSlotTimeout(what, ms))
}

export class StreamSlots {
  /** Slots this instance holds per user: the source a recovery rewrites from. */
  private readonly local = new Map<string, number>()
  private readonly commandTimeoutMs: number

  constructor(
    private readonly client: SlotRedis,
    private readonly instanceId: string,
    private readonly prefix: string,
    opts: { commandTimeoutMs?: number } = {},
  ) {
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 1_000
  }

  async take(userId: string, cap: number): Promise<StreamSlot> {
    const pending = this.client.eval(
      TAKE_LUA,
      2,
      userKey(userId),
      byInstKey(this.instanceId),
      this.prefix,
      this.instanceId,
      String(cap),
      userId,
    )
    let res: unknown
    try {
      res = await bounded(pending, this.commandTimeoutMs, "takeStreamSlot")
    } catch (err) {
      log.warn({ err, userId }, "stream cap unavailable: allowing the stream (fails open)")
      return { ok: true, release: this.lateRelease(userId, pending) }
    }
    if (Number(res) !== 1) return { ok: false }
    this.bumpLocal(userId, 1)
    let released = false
    return {
      ok: true,
      release: async () => {
        if (released) return
        released = true
        await this.releaseOne(userId)
      },
    }
  }

  /** A release for a take that timed out: it counts the take if and when it lands. */
  private lateRelease(userId: string, pending: Promise<unknown>): () => Promise<void> {
    let released = false
    let landed = false
    pending.then(
      (res) => {
        if (Number(res) !== 1) return
        landed = true
        this.bumpLocal(userId, 1)
        if (released) void this.releaseOne(userId)
      },
      () => {},
    )
    return async () => {
      if (released) return
      released = true
      if (landed) await this.releaseOne(userId)
    }
  }

  private bumpLocal(userId: string, by: number): void {
    const n = (this.local.get(userId) ?? 0) + by
    if (n <= 0) this.local.delete(userId)
    else this.local.set(userId, n)
  }

  private async releaseOne(userId: string): Promise<void> {
    this.bumpLocal(userId, -1)
    try {
      await bounded(
        this.client.eval(
          RELEASE_LUA,
          2,
          userKey(userId),
          byInstKey(this.instanceId),
          this.instanceId,
          userId,
        ),
        this.commandTimeoutMs,
        "releaseStreamSlot",
      )
    } catch (err) {
      log.warn({ err, userId }, "stream slot release did not answer in time")
    }
  }

  /** The leader's sweep: drop every slot a dead instance held. */
  async cleanupDeadInstance(deadId: string): Promise<void> {
    await bounded(
      this.client.eval(CLEANUP_LUA, 1, byInstKey(deadId), this.prefix, deadId),
      this.commandTimeoutMs,
      "cleanupDeadInstance",
    )
  }

  /** After a lapse: replace this instance's fields with what it still holds. */
  async republishOwn(): Promise<void> {
    const pairs: string[] = []
    for (const [userId, n] of this.local) pairs.push(userId, String(n))
    await bounded(
      this.client.eval(
        REPUBLISH_LUA,
        1,
        byInstKey(this.instanceId),
        this.prefix,
        this.instanceId,
        ...pairs,
      ),
      this.commandTimeoutMs,
      "republishOwn",
    )
  }
}

/** Wire a slot table into a registry's dead-instance and recovery hooks. */
export function registerStreamSlotHooks(
  reg: Pick<InstanceRegistry, "onDeadInstance" | "onInstanceRecovered">,
  slots: StreamSlots,
): void {
  reg.onDeadInstance("agent-stream-slots", (deadId) => slots.cleanupDeadInstance(deadId))
  reg.onInstanceRecovered("agent-stream-slots", () => slots.republishOwn())
}

// ── the process's slot table ──────────────────────────────────────────────

const processSlots = new StreamSlots(redis, INSTANCE_ID, REDIS_PREFIX)
registerStreamSlotHooks({ onDeadInstance, onInstanceRecovered }, processSlots)

/** Take one of the user's concurrent-stream slots; release it on every exit path. */
export function takeStreamSlot(userId: string, cap: number): Promise<StreamSlot> {
  return processSlots.take(userId, cap)
}
