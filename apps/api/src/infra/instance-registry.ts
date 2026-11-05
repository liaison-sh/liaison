// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Instance liveness (A12): the one liveness model every instance-scoped Redis
 * entry relies on (WebSocket connections, stream-cap slots, live turns,
 * mailbox request owners).
 *
 * - Heartbeat: every process (every role) writes `live:inst:{id}`, a JSON
 *   `InstanceRecord`, with TTL `LIVE_INSTANCE_TTL_MS`, renewed every
 *   `LIVE_INSTANCE_HEARTBEAT_MS`, and is a member of the set `live:instances`.
 *   A renew that does not answer within the interval counts as failed (Redis
 *   commands queue during an outage rather than reject). Once no renew landed
 *   for `ttl - interval`, the record is declared lost locally
 *   (`isOwnRecordLive()` false), as P1's leader lease does.
 * - Readers ignore entries whose instance has no record (`liveInstanceSet`).
 * - Sweep: the leader (`registerSingleton("live-state-sweep")`) takes the set
 *   minus the live ids every `LIVE_SWEEP_INTERVAL_MS`. For each dead id it
 *   re-checks the record right before firing, runs every `onDeadInstance` hook
 *   (errors logged, never thrown), then forgets the id and leaves a short
 *   "swept" marker for it.
 * - Recovery (P2-1): an instance whose record comes back after a lapse (the
 *   renew found the record gone, found a swept marker, or follows a local
 *   loss) runs its `onInstanceRecovered` hooks, which rewrite its own entries
 *   from its local tables. The swept marker closes the race where the
 *   instance republished while the sweep's hooks were still deleting: the
 *   next renew sees the marker and republishes once more.
 * - Every Redis await here is bounded (P2-3); a read that times out rejects,
 *   and the caller picks the failure direction.
 *
 * Lua scripts that filter entries by instance liveness build the heartbeat key
 * inside the script, which ioredis never prefixes: embed `LIVE_INSTANCE_LUA`
 * and pass `REDIS_PREFIX` in ARGV.
 */
import { INSTANCE_ID } from "~/infra/instance-id"
import { registerSingleton } from "~/infra/leadership"
import { boundedBy } from "~/lib/bounded"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import type { LiaisonRole } from "~/lib/process-role"
import { REDIS_PREFIX, redis } from "~/lib/redis"

const log = rootLogger.child({ module: "instance-registry" })

export interface InstanceRecord {
  role: LiaisonRole
  pid: number
  startedAt: number
  internalUrl?: string
  /**
   * Worker slots this process runs per job queue, while its job workers run
   * (empty once it stops fetching). Summed over live records, it is the
   * cell's concurrency on a queue (infra/jobs/fairness.ts).
   */
  jobSlots?: Record<string, number>
}

export const LIVE_INSTANCE_KEY = (id: string) => `live:inst:${id}`
export const LIVE_INSTANCES_SET = "live:instances"
const SWEPT_KEY = (id: string) => `live:swept:${id}`

/**
 * Lua helper for scripts that read an instance's liveness: defines
 * `live_inst_key(prefix, id)`. The script receives the prefix in ARGV.
 */
export const LIVE_INSTANCE_LUA = `local function live_inst_key(prefix, id) return prefix .. 'live:inst:' .. id end`

// KEYS: record, set, swept marker. ARGV: json, ttl ms, id.
// Returns { record existed before, swept marker was present }.
const HEARTBEAT_LUA = `
local existed = redis.call('EXISTS', KEYS[1])
local swept = redis.call('DEL', KEYS[3])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
return { existed, swept }
`

// No KEYS. ARGV: prefix, id... Returns one 0/1 per id.
const LIVE_SET_LUA = `
${LIVE_INSTANCE_LUA}
local out = {}
for i = 2, #ARGV do
  out[i - 1] = redis.call('EXISTS', live_inst_key(ARGV[1], ARGV[i]))
end
return out
`

// KEYS: record, set, swept marker. ARGV: id, marker ttl ms.
// Forget the id unless its record came back meanwhile; mark it swept either way.
const FINISH_SWEEP_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then redis.call('SREM', KEYS[2], ARGV[1]) end
redis.call('SET', KEYS[3], '1', 'PX', ARGV[2])
return 1
`

// KEYS: record, set. ARGV: id.
const RELEASE_LUA = `
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
return 1
`

/** The Redis commands the registry uses (the shared client satisfies it). */
export interface RegistryRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
  smembers(key: string): Promise<string[]>
  get(key: string): Promise<string | null>
  exists(key: string): Promise<number>
}

export class RegistryCommandTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`instance registry: Redis did not answer ${what} within ${ms} ms`)
    this.name = "RegistryCommandTimeout"
  }
}

function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return boundedBy(p, ms, () => new RegistryCommandTimeout(what, ms))
}

export interface InstanceRegistryOptions {
  instanceId?: string
  client?: RegistryRedis
  /** The client's key prefix, passed to scripts that build keys. Default `REDIS_PREFIX`. */
  prefix?: string
  /** Default `LIVE_INSTANCES_SET`. */
  setKey?: string
  ttlMs?: number
  heartbeatMs?: number
  sweepIntervalMs?: number
  /** Bound on each read (default 1000 ms). */
  commandTimeoutMs?: number
  /** Bound on each hook call (default 30 s). */
  hookTimeoutMs?: number
}

type DeadHook = (deadId: string) => Promise<void>
type RecoveredHook = () => Promise<void>

export class InstanceRegistry {
  readonly instanceId: string
  private readonly client: RegistryRedis
  private readonly prefix: string
  private readonly setKey: string
  private readonly ttlMs: number
  private readonly heartbeatMs: number
  private readonly sweepIntervalMs: number
  private readonly commandTimeoutMs: number
  private readonly hookTimeoutMs: number

  private readonly deadHooks = new Map<string, DeadHook>()
  private readonly recoveredHooks = new Map<string, RecoveredHook>()

  private record: InstanceRecord | null = null
  /** Slots published with the record; set before `start` too (see `setJobSlots`). */
  private jobSlots: Record<string, number> = {}
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private confirmedOnce = false
  private lastConfirmed = 0
  private lost = false
  private recoveryChain: Promise<void> = Promise.resolve()

  private sweeping = false
  private sweepTimer: ReturnType<typeof setTimeout> | null = null
  private sweepInFlight: Promise<void> | null = null

  constructor(opts: InstanceRegistryOptions = {}) {
    this.instanceId = opts.instanceId ?? INSTANCE_ID
    this.client = opts.client ?? redis
    this.prefix = opts.prefix ?? REDIS_PREFIX
    this.setKey = opts.setKey ?? LIVE_INSTANCES_SET
    this.ttlMs = opts.ttlMs ?? env.LIVE_INSTANCE_TTL_MS
    this.heartbeatMs = opts.heartbeatMs ?? env.LIVE_INSTANCE_HEARTBEAT_MS
    this.sweepIntervalMs = opts.sweepIntervalMs ?? env.LIVE_SWEEP_INTERVAL_MS
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 1_000
    this.hookTimeoutMs = opts.hookTimeoutMs ?? 30_000
  }

  // ── hooks ──────────────────────────────────────────────────────────────

  /** Cleanup of a dead instance's entries; run by the leader's sweep and on own release. */
  onDeadInstance(name: string, fn: DeadHook): void {
    this.deadHooks.set(name, fn)
  }

  /** Rewrite THIS instance's entries from its local tables after its record lapsed. */
  onInstanceRecovered(name: string, fn: RecoveredHook): void {
    this.recoveredHooks.set(name, fn)
  }

  clearHooks(): void {
    this.deadHooks.clear()
    this.recoveredHooks.clear()
  }

  // ── heartbeat ──────────────────────────────────────────────────────────

  /** Write the record (first write awaited, bounded), then renew on an unref'd timer. */
  async start(rec: Omit<InstanceRecord, "startedAt">): Promise<void> {
    if (this.running) return
    this.record = { ...rec, startedAt: Date.now(), jobSlots: this.jobSlots }
    this.running = true
    await this.runTick()
  }

  /** False once no renew landed within `ttl - interval` (or before the first). */
  isOwnRecordLive(): boolean {
    return this.running && this.confirmedOnce && !this.lost
  }

  /**
   * Stop renewing. With `releaseOwned`, delete the record and run this
   * instance's own dead-instance hooks (graceful shutdown).
   */
  async stop(opts: { releaseOwned?: boolean } = {}): Promise<void> {
    const wasRunning = this.running
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.inFlight) await this.inFlight
    await this.stopSweep()
    await this.recoveryChain
    if (!wasRunning || !opts.releaseOwned) return
    try {
      await bounded(
        this.client.eval(
          RELEASE_LUA,
          2,
          LIVE_INSTANCE_KEY(this.instanceId),
          this.setKey,
          this.instanceId,
        ),
        this.commandTimeoutMs,
        "release",
      )
    } catch (err) {
      log.warn({ err, instanceId: this.instanceId }, "instance record release failed")
    }
    await this.runDeadHooks(this.instanceId)
  }

  /**
   * The job worker slots this process publishes, per queue; sent with the next
   * heartbeat. An empty map publishes none (a draining or paused host).
   */
  setJobSlots(slots: Record<string, number>): void {
    this.jobSlots = { ...slots }
    if (this.record) this.record = { ...this.record, jobSlots: this.jobSlots }
  }

  private async runTick(): Promise<void> {
    this.timer = null
    const tick = this.tick().catch((err) =>
      log.error({ err, instanceId: this.instanceId }, "instance heartbeat tick failed"),
    )
    this.inFlight = tick
    await tick
    this.inFlight = null
    if (!this.running) return
    this.timer = setTimeout(() => void this.runTick(), this.heartbeatMs)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    if (!this.record) return
    if (
      this.confirmedOnce &&
      !this.lost &&
      Date.now() - this.lastConfirmed >= this.ttlMs - this.heartbeatMs
    ) {
      this.lost = true
      log.warn(
        { instanceId: this.instanceId, sinceMs: Date.now() - this.lastConfirmed },
        "instance heartbeat lost: no renew landed in time",
      )
    }
    const sentAt = Date.now()
    let res: unknown
    try {
      res = await bounded(
        this.client.eval(
          HEARTBEAT_LUA,
          3,
          LIVE_INSTANCE_KEY(this.instanceId),
          this.setKey,
          SWEPT_KEY(this.instanceId),
          JSON.stringify(this.record),
          String(this.ttlMs),
          this.instanceId,
        ),
        this.heartbeatMs,
        "heartbeat",
      )
    } catch (err) {
      log.warn({ err, instanceId: this.instanceId }, "instance heartbeat renew failed")
      return
    }
    if (!Array.isArray(res)) return
    const existed = Number(res[0]) === 1
    const swept = Number(res[1]) === 1
    const recovered = this.confirmedOnce && (this.lost || !existed || swept)
    this.confirmedOnce = true
    this.lastConfirmed = sentAt
    this.lost = false
    if (recovered) {
      log.warn(
        { instanceId: this.instanceId, existed, swept },
        "instance record back after a lapse: republishing own entries",
      )
      this.recoveryChain = this.recoveryChain.then(() => this.runRecoveredHooks())
    }
  }

  private async runRecoveredHooks(): Promise<void> {
    for (const [name, fn] of this.recoveredHooks) {
      try {
        await bounded(fn(), this.hookTimeoutMs, `recovered hook ${name}`)
      } catch (err) {
        log.error({ err, hook: name, instanceId: this.instanceId }, "instance recovery hook failed")
      }
    }
  }

  // ── readers (bounded; a timeout rejects) ───────────────────────────────

  async isInstanceLive(id: string): Promise<boolean> {
    return (await this.liveInstanceSet([id])).has(id)
  }

  /** The subset of `ids` whose record exists, in one script call. */
  async liveInstanceSet(ids: string[]): Promise<Set<string>> {
    const out = new Set<string>()
    if (ids.length === 0) return out
    const res = await bounded(
      this.client.eval(LIVE_SET_LUA, 0, this.prefix, ...ids),
      this.commandTimeoutMs,
      "liveInstanceSet",
    )
    if (!Array.isArray(res)) return out
    ids.forEach((id, i) => {
      if (Number(res[i]) === 1) out.add(id)
    })
    return out
  }

  async readInstance(id: string): Promise<InstanceRecord | null> {
    const raw = await bounded(
      this.client.get(LIVE_INSTANCE_KEY(id)),
      this.commandTimeoutMs,
      "readInstance",
    )
    if (!raw) return null
    try {
      return JSON.parse(raw) as InstanceRecord
    } catch {
      return null
    }
  }

  // ── sweep (leader only) ────────────────────────────────────────────────

  /** Run the dead-instance sweep while this process leads the cell. */
  registerSweep(name = "live-state-sweep"): void {
    registerSingleton({
      name,
      onAcquired: () => {
        this.sweeping = true
        void this.runSweep()
      },
      onLost: () => this.stopSweep(),
    })
  }

  private async stopSweep(): Promise<void> {
    this.sweeping = false
    if (this.sweepTimer) clearTimeout(this.sweepTimer)
    this.sweepTimer = null
    if (this.sweepInFlight) await this.sweepInFlight
  }

  private async runSweep(): Promise<void> {
    this.sweepTimer = null
    const p = this.sweepOnce().catch((err) => log.error({ err }, "live-state sweep failed"))
    this.sweepInFlight = p
    await p
    this.sweepInFlight = null
    if (!this.sweeping) return
    this.sweepTimer = setTimeout(() => void this.runSweep(), this.sweepIntervalMs)
    this.sweepTimer.unref?.()
  }

  private async sweepOnce(): Promise<void> {
    const members = await bounded(
      this.client.smembers(this.setKey),
      this.commandTimeoutMs,
      "sweep members",
    )
    const others = members.filter((id) => id !== this.instanceId)
    if (others.length === 0) return
    const live = await this.liveInstanceSet(others)
    for (const id of others) {
      if (!this.sweeping) return
      if (live.has(id)) continue
      // Re-check right before firing: the instance may have come back.
      const exists = await bounded(
        this.client.exists(LIVE_INSTANCE_KEY(id)),
        this.commandTimeoutMs,
        "sweep recheck",
      )
      if (exists === 1) continue
      const hooks = await this.runDeadHooks(id)
      await bounded(
        this.client.eval(
          FINISH_SWEEP_LUA,
          3,
          LIVE_INSTANCE_KEY(id),
          this.setKey,
          SWEPT_KEY(id),
          id,
          String(this.ttlMs),
        ),
        this.commandTimeoutMs,
        "sweep finish",
      )
      log.info({ deadInstanceId: id, hooks }, "dead instance swept")
    }
  }

  private async runDeadHooks(id: string): Promise<string[]> {
    const names: string[] = []
    for (const [name, fn] of this.deadHooks) {
      names.push(name)
      try {
        await bounded(fn(id), this.hookTimeoutMs, `dead-instance hook ${name}`)
      } catch (err) {
        log.error({ err, hook: name, deadInstanceId: id }, "dead-instance hook failed")
      }
    }
    return names
  }
}

// ── the process's registry ────────────────────────────────────────────────

let defaultRegistry: InstanceRegistry | null = null
function registry(): InstanceRegistry {
  defaultRegistry ??= new InstanceRegistry()
  return defaultRegistry
}

export function startInstanceHeartbeat(rec: Omit<InstanceRecord, "startedAt">): Promise<void> {
  return registry().start(rec)
}

export function stopInstanceHeartbeat(opts?: { releaseOwned?: boolean }): Promise<void> {
  return registry().stop(opts)
}

/** False once this process's own record is lost (see `InstanceRegistry.isOwnRecordLive`). */
export function isOwnInstanceLive(): boolean {
  return registry().isOwnRecordLive()
}

export function isInstanceLive(id: string): Promise<boolean> {
  return registry().isInstanceLive(id)
}

export function liveInstanceSet(ids: string[]): Promise<Set<string>> {
  return registry().liveInstanceSet(ids)
}

export function readInstance(id: string): Promise<InstanceRecord | null> {
  return registry().readInstance(id)
}

/** Publish this process's job worker slots with its record (fairness.ts reads them). */
export function setInstanceJobSlots(slots: Record<string, number>): void {
  registry().setJobSlots(slots)
}

export function onDeadInstance(name: string, fn: (deadId: string) => Promise<void>): void {
  registry().onDeadInstance(name, fn)
}

export function onInstanceRecovered(name: string, fn: () => Promise<void>): void {
  registry().onInstanceRecovered(name, fn)
}

export function registerLiveStateSweep(): void {
  registry().registerSweep("live-state-sweep")
}

export const InstanceRegistryTestAccess = {
  async reset(): Promise<void> {
    if (defaultRegistry) {
      await defaultRegistry.stop({ releaseOwned: false })
      defaultRegistry.clearHooks()
    }
    defaultRegistry = null
  },
  /** Make `registry` the process's registry (call `reset` first). */
  install(registry: InstanceRegistry): void {
    defaultRegistry = registry
  },
}
