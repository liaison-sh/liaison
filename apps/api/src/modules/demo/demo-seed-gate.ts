// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The SEEDING GATE: how many demo workspaces this box seeds at once.
//
// The warm pool (demo-pool.ts) absorbs a burst only while it has ready orgs.
// Once it is empty every further signup falls back to seeding its own org, and
// without a bound a burst of a hundred signups is a hundred full seeds at once,
// the very load the pool exists to prevent. So every seed on a demo box, the
// pool's refill and an empty-pool signup alike, goes through this gate:
//
//   SLOTS     LIAISON_DEMO_SEED_CONCURRENCY leases in Redis (`demo:seed:slot:<i>`,
//             SET NX with a short TTL its holder renews while it seeds), so the
//             limit holds across every API process and a dead process frees its
//             slot within one lease TTL, not a seed's whole deadline: a deploy
//             kills every seeding process at once, and slots they held for the
//             deadline would starve the new build's seeds for minutes. Renewal
//             stops at the seed's deadline, so a holder that never releases
//             still lets its slot go.
//   FIFO      a visitor beyond the limit waits in a Redis list, first come first
//             served. Their workspace already exists and reads "provisioning"
//             while they wait (the waiter keeps the readiness record fresh, so a
//             long wait is never reported as a failed seed). Each waiter keeps a
//             short heartbeat key alive; a ticket whose heartbeat has lapsed (its
//             process died) is dropped so it cannot block the queue.
//   PRIORITY  while LIVE visitors wait, the refill holds at most its SHARE of
//             the slots (a third, rounded down: 2 of 6, none of 1 or 2), and
//             the waiting visitors get every other slot. With no share, a
//             burst that outruns seeding kept every slot on the queue: the
//             pool stayed empty for the whole burst, so every new arrival
//             joined the queue behind the others and waited minutes, and the
//             pool only began to refill once the burst was over. A pooled
//             workspace serves the next arrival in about a second while a
//             fresh one costs its visitor a whole seed, and both take the same
//             slot time, so keeping a third of the slots on the pool serves
//             more visitors inside the time-to-workspace bar at the same
//             seeding capacity, and leaves the pool refilled when the burst
//             ends. Small boxes (one or two slots) keep the old order: a
//             person always goes before the pool. "Waiting" is read through
//             the heartbeats, never the list's raw length: after a deploy
//             kills every waiting process the list holds only dead tickets,
//             and no live waiter is left to prune them, so a raw length would
//             keep the refill out (and the pool empty) forever.
import crypto from "node:crypto"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { STALE_PROVISIONING_MS } from "~/modules/demo/demo-provisioning"

const log = rootLogger.child({ module: "demo-seed-gate" })

const SLOT_PREFIX = "demo:seed:slot:"
const QUEUE_KEY = "demo:seed:queue"
const WAITER_PREFIX = "demo:seed:waiter:"
/** A refill's lease token starts with this, so the slots it holds can be counted. */
const REFILL_TOKEN_PREFIX = "refill:"

/** The longest a holder renews its slot: a seed's deadline plus the stale grace. */
const SLOT_MAX_HOLD_MS = STALE_PROVISIONING_MS
/** A slot's lease TTL; its live holder renews it every third of that. */
let slotLeaseMs = 30_000
/** Renewal timers of the slots this process holds, by lease token. */
const renewals = new Map<string, ReturnType<typeof setInterval>>()
/** How long a waiter's heartbeat lives; refreshed on every poll. */
const WAITER_TTL_MS = 15_000

let pollMs = 250

/** A held seeding slot. Release it with `releaseSeedSlot`. */
export interface SeedLease {
  key: string
  token: string
}

/** Take a free slot, or null when all LIAISON_DEMO_SEED_CONCURRENCY are held. */
async function tryAcquireSlot(holder: "visitor" | "refill"): Promise<SeedLease | null> {
  const token = `${holder === "refill" ? REFILL_TOKEN_PREFIX : ""}${crypto.randomUUID()}`
  for (let i = 0; i < env.LIAISON_DEMO_SEED_CONCURRENCY; i++) {
    const key = `${SLOT_PREFIX}${i}`
    if ((await redis.set(key, token, "PX", slotLeaseMs, "NX")) === "OK") {
      const lease = { key, token }
      startRenewal(lease)
      return lease
    }
  }
  return null
}

/** Keep a held slot's lease alive while this process holds it (compare and pexpire). */
function startRenewal(lease: SeedLease): void {
  const leaseMs = slotLeaseMs
  const until = Date.now() + SLOT_MAX_HOLD_MS
  const timer = setInterval(
    () => {
      if (Date.now() >= until) {
        stopRenewal(lease)
        log.warn({ key: lease.key }, "demo seed slot held past a seed's deadline; letting it lapse")
        return
      }
      redis
        .eval(
          `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`,
          1,
          lease.key,
          lease.token,
          String(leaseMs),
        )
        .then((held) => {
          if (held === 0) stopRenewal(lease)
        })
        .catch((err) => log.warn({ err, key: lease.key }, "demo seed slot renewal failed"))
    },
    Math.max(1, Math.floor(leaseMs / 3)),
  )
  timer.unref?.()
  renewals.set(lease.token, timer)
}

function stopRenewal(lease: SeedLease): void {
  const timer = renewals.get(lease.token)
  if (timer) clearInterval(timer)
  renewals.delete(lease.token)
}

/** Give a slot back, only if this lease still holds it (compare and delete). */
export async function releaseSeedSlot(lease: SeedLease): Promise<void> {
  stopRenewal(lease)
  try {
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      lease.key,
      lease.token,
    )
  } catch (err) {
    log.warn({ err, key: lease.key }, "demo seed slot release failed; it lapses on its own")
  }
}

/**
 * LIVE visitors waiting for a slot right now. Drops every ticket whose waiter
 * heartbeat has lapsed (its process is gone) on the way, so the count, and
 * the queue behind it, never carries a dead waiter.
 */
export async function demoSeedQueueDepth(): Promise<number> {
  const tickets = await redis.lrange(QUEUE_KEY, 0, -1)
  if (tickets.length === 0) return 0
  const pipe = redis.pipeline()
  for (const t of tickets) pipe.exists(`${WAITER_PREFIX}${t}`)
  const alive = (await pipe.exec()) ?? []
  const dead = tickets.filter((_, i) => {
    const [err, n] = alive[i] ?? [null, 1]
    // A failed EXISTS counts the ticket as live: never drop a waiter on doubt.
    return !err && n === 0
  })
  if (dead.length > 0) {
    const drop = redis.pipeline()
    for (const t of dead) drop.lrem(QUEUE_KEY, 1, t)
    await drop.exec()
    log.warn(
      { dropped: dead.length, live: tickets.length - dead.length },
      `demo seed queue: dropped ${dead.length} waiters whose process is gone`,
    )
  }
  return tickets.length - dead.length
}

/**
 * The slots the refill may hold while visitors wait: a third of the gate,
 * rounded down (see PRIORITY in the header).
 */
export function demoRefillSlotShare(): number {
  return Math.floor(env.LIAISON_DEMO_SEED_CONCURRENCY / 3)
}

/** How many slots refill leases hold right now. */
async function refillSlotsHeld(): Promise<number> {
  const keys = Array.from(
    { length: env.LIAISON_DEMO_SEED_CONCURRENCY },
    (_, i) => `${SLOT_PREFIX}${i}`,
  )
  const tokens = await redis.mget(...keys)
  return tokens.filter((t) => t?.startsWith(REFILL_TOKEN_PREFIX)).length
}

/**
 * A slot for the warm pool's refill, or null. Null when every slot is held,
 * and, while any visitor is waiting, once the refill holds its share.
 */
export async function tryAcquireRefillSeedSlot(): Promise<SeedLease | null> {
  if ((await demoSeedQueueDepth()) > 0) {
    const share = demoRefillSlotShare()
    if (share === 0 || (await refillSlotsHeld()) >= share) return null
  }
  return tryAcquireSlot("refill")
}

/**
 * Run a VISITOR's seed under a slot, waiting in the FIFO for one if none is
 * free. `onWait` runs about every poll while the visitor waits (the caller
 * keeps their readiness record fresh with it). Never gives up on its own: the
 * visitor's workspace stays "provisioning" until their turn comes.
 */
export async function withVisitorSeedSlot<T>(
  orgId: string,
  run: () => Promise<T>,
  onWait: () => Promise<void> = async () => {},
): Promise<T> {
  // A free slot and nobody ahead: straight in, no queue.
  const immediate = (await demoSeedQueueDepth()) === 0 ? await tryAcquireSlot("visitor") : null
  const lease = immediate ?? (await waitInQueue(orgId, onWait))
  try {
    return await run()
  } finally {
    await releaseSeedSlot(lease)
  }
}

/** Wait in the FIFO until this visitor is at its head and a slot is free. */
async function waitInQueue(orgId: string, onWait: () => Promise<void>): Promise<SeedLease> {
  const ticket = `${orgId}:${crypto.randomUUID()}`
  const heartbeat = () => redis.set(`${WAITER_PREFIX}${ticket}`, "1", "PX", WAITER_TTL_MS)
  await heartbeat()
  const depth = await redis.rpush(QUEUE_KEY, ticket)
  // WARN: demand is past the limit. Shows on a LOG_LEVEL=warn box, which is
  // how an operator sees a burst outrunning the pool and the gate.
  log.warn(
    {
      orgId,
      queueDepth: depth,
      concurrency: env.LIAISON_DEMO_SEED_CONCURRENCY,
      alert: "demo_seed_queue",
    },
    `demo seed queue: ${depth} visitors waiting for ${env.LIAISON_DEMO_SEED_CONCURRENCY} seeding slots`,
  )
  let lastWait = 0
  try {
    for (;;) {
      await heartbeat()
      const head = await redis.lindex(QUEUE_KEY, 0)
      if (head === ticket) {
        const lease = await tryAcquireSlot("visitor")
        if (lease) return lease
      } else if (head && !(await redis.exists(`${WAITER_PREFIX}${head}`))) {
        // The head's process died while it waited: it will never take a slot.
        await redis.lrem(QUEUE_KEY, 1, head)
        log.warn({ ticket: head }, "demo seed queue: dropped a waiter whose process is gone")
        continue
      }
      if (Date.now() - lastWait >= 30_000) {
        lastWait = Date.now()
        await onWait()
        // A stall past the heartbeat's TTL (a slow onWait, a paused process)
        // lets another reader drop this ticket as dead. Queue again rather
        // than wait forever for a turn that can no longer come.
        if (head !== ticket && (await redis.lpos(QUEUE_KEY, ticket)) === null) {
          await heartbeat()
          await redis.rpush(QUEUE_KEY, ticket)
          log.warn({ ticket }, "demo seed queue: this waiter's ticket was dropped; queued again")
        }
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  } finally {
    await redis.lrem(QUEUE_KEY, 1, ticket).catch(() => 0)
    await redis.del(`${WAITER_PREFIX}${ticket}`).catch(() => 0)
  }
}

/** Test seams. */
export const DemoSeedGateTestAccess = {
  setPollMs(ms: number): void {
    pollMs = ms
  },
  setSlotLeaseMs(ms: number): void {
    slotLeaseMs = ms
  },
  /** What a killed holder leaves behind: its slot, no longer renewed. */
  abandon(lease: SeedLease): void {
    stopRenewal(lease)
  },
  keys: { SLOT_PREFIX, QUEUE_KEY, WAITER_PREFIX },
}
