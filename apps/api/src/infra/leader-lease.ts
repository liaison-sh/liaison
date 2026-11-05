// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The leader lease: one Redis key that elects the one process running the
 * cell's singletons (outbox drain and the other process-wide loops).
 *
 * - Acquire: `SET key holder PX ttl NX`, tried every `pollMs` while not held.
 *   When the SET does not answer OK (refused, or timed out but landed after
 *   all), a compare-and-PEXPIRE adopts the key if it already holds this
 *   holder's id, so a late-landing SET never orphans the key until its TTL.
 * - Renew: compare-and-PEXPIRE every `renewMs` while held. A renew that answers
 *   anything but 1, rejects, or does not answer within `renewMs` means the
 *   lease is lost (Redis commands hang during an outage rather than reject).
 * - Local deadline: while held, once `ttlMs - renewMs` has passed since the last
 *   confirmed renew, the lease is declared lost without waiting for Redis, so
 *   the holder stops before the key can expire and be taken by another.
 * - `canContend()`: the process only contends for and keeps the lease while it
 *   returns true (the caller wires "this node may run singletons"). Turning
 *   false while held is a loss.
 * - `onChange(true)` runs beside the tick loop, never inside it: a slow
 *   acquire hook never delays a renew. `start()` resolves once it settled.
 * - Loss order, on every loss and on `stop()`: `held()` turns false, a still
 *   running `onChange(true)` is awaited, then `onChange(false)` (singletons
 *   finish in-flight work), then the key is released with a compare-and-delete,
 *   so a key another holder took meanwhile is never deleted.
 * - A `stop()` that races a successful SET releases that key (compare-and-delete).
 * Ticks never overlap: the next one is scheduled when the previous settles.
 */
import { INSTANCE_ID } from "~/infra/instance-id"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { RELEASE_LUA, RENEW_LUA } from "~/modules/provisioning/config-lease"

const log = rootLogger.child({ module: "leader-lease" })

export const LEADER_LEASE_KEY = "leader:singletons"

/** The two Redis commands the lease uses (the shared client satisfies it). */
export interface LeaseRedis {
  set(key: string, value: string, px: "PX", ttlMs: number, nx: "NX"): Promise<"OK" | null>
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
}

export interface LeaderLeaseOptions {
  key?: string
  /** Default `LEADER_LEASE_TTL_MS`. */
  ttlMs?: number
  /** Holder's renew period. Default `LEADER_LEASE_RENEW_MS`. */
  renewMs?: number
  /** Contender's acquire period. Default `LEADER_LEASE_POLL_MS`. */
  pollMs?: number
  /** Value stored in the key. Default this process's `INSTANCE_ID`. */
  holderId?: string
  client?: LeaseRedis
  now?: () => number
  /** Contend for and keep the lease only while true. Default always true. */
  canContend?: () => boolean
}

class LeaseCommandTimeout extends Error {
  constructor(ms: number) {
    super(`leader lease: Redis did not answer within ${ms} ms`)
    this.name = "LeaseCommandTimeout"
  }
}

export class RedisLeaderLease {
  private readonly key: string
  private readonly ttlMs: number
  private readonly renewMs: number
  private readonly pollMs: number
  private readonly holderId: string
  private readonly client: LeaseRedis
  private readonly now: () => number
  private readonly canContend: () => boolean
  private isHeld = false
  private lastConfirmed = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  /** The running `onChange(true)`, awaited by a loss before `onChange(false)`. */
  private acquireNotify: Promise<void> | null = null
  private running = false

  constructor(
    opts: LeaderLeaseOptions,
    private readonly onChange: (held: boolean) => void | Promise<void>,
  ) {
    this.key = opts.key ?? LEADER_LEASE_KEY
    this.ttlMs = opts.ttlMs ?? env.LEADER_LEASE_TTL_MS
    this.renewMs = opts.renewMs ?? env.LEADER_LEASE_RENEW_MS
    this.pollMs = opts.pollMs ?? env.LEADER_LEASE_POLL_MS
    this.holderId = opts.holderId ?? INSTANCE_ID
    this.client = opts.client ?? redis
    this.now = opts.now ?? Date.now
    this.canContend = opts.canContend ?? (() => true)
  }

  held(): boolean {
    return this.isHeld
  }

  /**
   * First attempt awaited (with its `onChange(true)` when it acquired), then a
   * tick every `renewMs` (held) or `pollMs`.
   */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.runTick()
    if (this.acquireNotify) await this.acquireNotify
  }

  /** Stop ticking; if held: flip held, await `onChange(false)`, then release. */
  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.inFlight) await this.inFlight
    if (this.isHeld) await this.lose("stopped")
  }

  private async runTick(): Promise<void> {
    this.timer = null
    const tick = this.tick().catch((err) =>
      log.error({ err, key: this.key }, "leader lease tick failed"),
    )
    this.inFlight = tick
    await tick
    this.inFlight = null
    if (!this.running) return
    this.timer = setTimeout(() => void this.runTick(), this.isHeld ? this.renewMs : this.pollMs)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    if (this.isHeld) {
      if (!this.canContend()) return this.lose("no longer eligible")
      if (this.now() - this.lastConfirmed >= this.ttlMs - this.renewMs) {
        return this.lose("renew deadline passed")
      }
      const sentAt = this.now()
      let renewed = false
      try {
        renewed = await this.renewOwn()
      } catch (err) {
        log.warn({ err, key: this.key }, "leader lease renew failed")
      }
      if (!this.isHeld) return
      if (renewed) {
        this.lastConfirmed = sentAt
        return
      }
      return this.lose("renew refused")
    }
    if (!this.running || !this.canContend()) return
    let sentAt = this.now()
    let got = false
    try {
      got =
        (await this.bounded(this.client.set(this.key, this.holderId, "PX", this.ttlMs, "NX"))) ===
        "OK"
    } catch (err) {
      log.warn({ err, key: this.key }, "leader lease acquire failed")
    }
    if (got && !this.running) {
      // stop() raced the SET: give the key back rather than orphan it.
      await this.release()
      return
    }
    if (!got) {
      if (!this.running || !this.canContend()) return
      // An earlier SET that timed out may have landed: adopt our own key.
      sentAt = this.now()
      try {
        got = await this.renewOwn()
      } catch (err) {
        log.warn({ err, key: this.key }, "leader lease adopt check failed")
      }
      if (got && !this.running) {
        await this.release()
        return
      }
      if (!got) return
    }
    this.isHeld = true
    this.lastConfirmed = sentAt
    log.info({ key: this.key, holderId: this.holderId }, "leader lease acquired")
    // Never awaited here: the renew loop keeps ticking while the hooks run.
    const n = this.notify(true).finally(() => {
      if (this.acquireNotify === n) this.acquireNotify = null
    })
    this.acquireNotify = n
  }

  private async lose(reason: string): Promise<void> {
    this.isHeld = false
    log.warn({ key: this.key, holderId: this.holderId, reason }, "leader lease lost")
    if (this.acquireNotify) await this.acquireNotify
    await this.notify(false)
    await this.release()
  }

  /** Compare-and-PEXPIRE: true when the key holds this holder's id (its TTL is reset). */
  private async renewOwn(): Promise<boolean> {
    const res = await this.bounded(
      this.client.eval(RENEW_LUA, 1, this.key, this.holderId, String(this.ttlMs)),
    )
    return Number(res) === 1
  }

  /** Compare-and-delete: removes the key only while it holds this holder's id. */
  private async release(): Promise<void> {
    try {
      await this.bounded(this.client.eval(RELEASE_LUA, 1, this.key, this.holderId))
    } catch (err) {
      log.warn({ err, key: this.key }, "leader lease release failed (the key expires on its own)")
    }
  }

  private async notify(held: boolean): Promise<void> {
    try {
      await this.onChange(held)
    } catch (err) {
      log.error({ err, key: this.key, held }, "leader lease onChange threw")
    }
  }

  /** A Redis command that has not answered within `renewMs` counts as failed. */
  private bounded<T>(p: Promise<T>): Promise<T> {
    let t: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new LeaseCommandTimeout(this.renewMs)), this.renewMs)
    })
    return Promise.race([p, timeout]).finally(() => clearTimeout(t))
  }
}
