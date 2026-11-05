// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ── WAKE THE OUTBOX WORKER WHEN AN EVENT COMMITS ───────────────────────────
// The outbox worker polls `pending_events` once a second, so an event waited
// half a second on average (up to a full second) before any consumer saw it,
// and every event-driven chain paid that once per hop: a ticket written by a
// consumer of another event waited two polls before its routine could start
// (a live demo run measured 1.4 s between the click and the routine's job, all
// of it poll wait). Now a transaction that queued an event says so once it has
// COMMITTED (the transaction wrappers call `signalOutboxWake` after commit,
// never before, so the worker never wakes to rows it cannot see yet), and the
// leader drains at once. The poll stays as the fallback: a lost wake (Redis
// down, a process that is not subscribed) costs at most the old poll wait.
//
// Cross-process: the write may commit in an api process while the leader
// drains in the worker, so the wake is a Redis publish every process hears.
// Signals of one process are coalesced into one publish per WAKE_COALESCE_MS,
// so a burst of writes costs one message, not one per transaction.

//
// `~/lib/redis` is imported lazily: the transaction wrappers import this
// module, and a script that only touches the database must not open Redis
// connections (they would keep it from exiting).
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "outbox-wake" })

export const OUTBOX_WAKE_CHANNEL = `${process.env.REDIS_PREFIX ?? ""}outbox:wake`

/** Writes of one process within this window share one wake message. */
export const WAKE_COALESCE_MS = 5

let pending: ReturnType<typeof setTimeout> | null = null
const publishRedis = async (channel: string, payload: string): Promise<number> =>
  (await import("~/lib/redis")).publishRedis(channel, payload)
let publish: (channel: string, payload: string) => Promise<number> = publishRedis

/**
 * A transaction that queued at least one outbox event has committed: wake the
 * draining process. Never throws and never waits; a failed publish only means
 * the event goes out on the next poll.
 */
export function signalOutboxWake(): void {
  if (pending) return
  pending = setTimeout(() => {
    pending = null
    publish(OUTBOX_WAKE_CHANNEL, "1").catch((err: unknown) => {
      log.debug({ err }, "outbox wake publish failed; the poll delivers the event")
    })
  }, WAKE_COALESCE_MS)
}

let subscribed = false

/**
 * Run `onWake` whenever any process signals a committed outbox write. Called
 * once per process (the outbox worker's start); later calls are no-ops.
 */
export async function subscribeOutboxWake(onWake: () => void): Promise<void> {
  if (subscribed) return
  subscribed = true
  try {
    const { redisSub } = await import("~/lib/redis")
    redisSub.on("message", (channel) => {
      if (channel !== OUTBOX_WAKE_CHANNEL) return
      try {
        onWake()
      } catch (err) {
        log.warn({ err }, "outbox wake handler failed")
      }
    })
    // ioredis re-subscribes on its own after a reconnect.
    await redisSub.subscribe(OUTBOX_WAKE_CHANNEL)
  } catch (err) {
    log.warn({ err }, "outbox wake subscribe failed; the worker keeps its poll")
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const OutboxWakeTestAccess = {
  /** Replace the publisher (null restores Redis) and drop a pending coalesced wake. */
  setPublisher(fn: ((channel: string, payload: string) => Promise<number>) | null): void {
    publish = fn ?? publishRedis
    if (pending) clearTimeout(pending)
    pending = null
  },
}
