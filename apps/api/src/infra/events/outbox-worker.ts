// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomBytes } from "node:crypto"
import { sql } from "~/db/connection"
import { schemaRef } from "~/db/schema-ref"
import {
  type DurableEventContext,
  type DurableOutcome,
  runDurableConsumerLanes,
  runDurableConsumers,
} from "~/infra/events/durable-consumers"
import {
  _publishEventInternal,
  type AppEvent,
  assignWsReplayId,
  EventDeferredError,
} from "~/infra/events/event-bus"
import { subscribeOutboxWake } from "~/infra/events/outbox-wake"
import { isLeader, registerSingleton } from "~/infra/leadership"
import { rootLogger } from "~/lib/logger"
import { initializedOrgRuntimes, orgRuntimeLastTouch } from "~/modules/apps/app-registries"
import type { OrgSetupTrigger } from "~/modules/apps/init"
import { markOrgsChanged } from "~/modules/attention/org-changes"
import { movingOrgIds } from "~/modules/org/transfer-state/state"

const log = rootLogger.child({ module: "outbox-worker" })
/**
 * How often the worker polls the outbox. 1 s in production. Under test the
 * default is 25 ms so a spawned server delivers an event's effects within a
 * few ms instead of making the test wait out a full poll. OUTBOX_POLL_INTERVAL_MS
 * overrides either default (10 ms..60 s); anything outside that range is ignored.
 */
export function resolveOutboxPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OUTBOX_POLL_INTERVAL_MS)
  if (env.OUTBOX_POLL_INTERVAL_MS && Number.isFinite(raw) && raw >= 10 && raw <= 60_000) return raw
  return env.NODE_ENV === "test" ? 25 : 1_000
}
const POLL_INTERVAL_MS = resolveOutboxPollIntervalMs()
// Cleanup runs about once a minute, however often wakes and polls tick.
const CLEANUP_EVERY_MS = 60_000
const BATCH_SIZE = 100
const CLAIM_TIMEOUT_SECONDS = 30
const WORKER_ID = randomBytes(8).toString("hex")

const MAX_ATTEMPTS = 10

let timer: ReturnType<typeof setInterval> | null = null
let currentTick: Promise<void> | null = null

// Monitoring (Phase C2): the in-process worker's tick timestamp, exposed for the /diag route.
// heartbeatSource is "inproc" -- Liaison's outbox worker runs in the SAME process as the web
// server (unlike a hub service with a separate worker process), so process-local state is correct
// by definition: the worker dying means the whole process died, and /diag would be
// unreachable anyway. No Redis needed.
let lastTickAt: Date | null = null

export interface WorkerHeartbeat {
  lastTickAt: string | null
  heartbeatSource: "inproc"
}

export function getWorkerHeartbeat(): WorkerHeartbeat {
  return { lastTickAt: lastTickAt ? lastTickAt.toISOString() : null, heartbeatSource: "inproc" }
}

// Every outbox write runs as liaison_admin (BYPASSRLS). `pending_events` has FORCE row-level
// security with only an INSERT policy for liaison_rls and no SELECT/UPDATE policy -- so the base
// liaison_app connection (NOBYPASSRLS, the request-serving role) SELECTs/UPDATEs ZERO rows, and the
// worker would silently claim nothing on any RLS-forced (i.e. secure, production) deployment.
// liaison_app is a MEMBER of liaison_admin, so SET LOCAL ROLE inside a short transaction elevates
// the claim/complete/cleanup queries -- the same mechanism withPrivilegedDb/withSystemDb use --
// without requiring a privileged LOGIN role on the connection string.
async function adminExec(query: string, params: (string | number | string[])[] = []) {
  return await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE liaison_admin")
    return await tx.unsafe(query, params)
  })
}

/** Orgs whose runtime init failed: retry no sooner than `nextAttemptAt`. */
const orgInitBackoff = new Map<string, { failures: number; nextAttemptAt: number }>()
const ORG_INIT_BACKOFF_BASE_MS = 1_000
const ORG_INIT_BACKOFF_MAX_MS = 5 * 60_000

/** Exponential retry delay after `failures` consecutive failed inits, capped. */
export function orgInitBackoffMs(failures: number): number {
  return Math.min(
    ORG_INIT_BACKOFF_MAX_MS,
    ORG_INIT_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
  )
}

/**
 * Make sure every org in a batch has its app runtime in THIS process before the
 * durable consumers see its events. The search indexer, the attention
 * translator and the app event handlers all read per-org registries that
 * `awaitOrgApps` (the ensure entry) fills; an org created after this server
 * booted by another process (the provisioning CLI's `config apply` on a fresh
 * instance) has none
 * here yet, and its first events (every knowledge document it loaded) were
 * planned against empty registries and dropped: the documents existed and no
 * search ever found them. A no-op for an org already initialized; an org id
 * with no row (a deleted org, a test fixture) is skipped.
 *
 * Returns the orgs that are NOT ready: their setup failed now, or failed
 * before and its retry delay has not passed. Their events are not processed
 * this tick (the consumers would plan them against empty registries and the
 * events would be stamped processed: lost); the caller hands them back
 * unclaimed, and the claim skips them until the org's retry is due. The retry
 * delay grows exponentially, capped, so a persistently failing org costs one
 * attempt per delay, and other orgs' events flow meanwhile.
 */
async function ensureOrgRuntimes(
  batchOrgIds: Iterable<string | null | undefined>,
  init: (orgId: string, trigger?: OrgSetupTrigger) => Promise<void>,
  now: number = Date.now(),
  /** The org's first event in the batch: the queued work its setup is for. */
  triggers: ReadonlyMap<string, OrgSetupTrigger> = new Map(),
): Promise<Set<string>> {
  const notReady = new Set<string>()
  const failed = (orgId: string, err: unknown) => {
    notReady.add(orgId)
    const failures = (orgInitBackoff.get(orgId)?.failures ?? 0) + 1
    const delayMs = orgInitBackoffMs(failures)
    orgInitBackoff.set(orgId, { failures, nextAttemptAt: now + delayMs })
    log.error(
      { err, orgId, failures, retryInMs: delayMs },
      "Could not initialize the org's apps before its events: they wait for the retry",
    )
  }
  const missing: string[] = []
  for (const orgId of new Set(batchOrgIds)) {
    if (typeof orgId !== "string" || orgId === "") continue
    if (initializedOrgRuntimes.has(orgId)) {
      // An event is a touch: an org with events flowing is never idle-released.
      orgRuntimeLastTouch.set(orgId, now)
      continue
    }
    if ((orgInitBackoff.get(orgId)?.nextAttemptAt ?? 0) > now) notReady.add(orgId)
    else missing.push(orgId)
  }
  if (missing.length === 0) return notReady
  let rows: Awaited<ReturnType<typeof adminExec>>
  try {
    rows = await adminExec(
      `SELECT id::text AS id FROM ${schemaRef("kernel")}.organizations WHERE id::text = ANY($1)`,
      [missing],
    )
  } catch (err) {
    // Which orgs exist is unknown: none of them is ready.
    for (const orgId of missing) failed(orgId, err)
    return notReady
  }
  for (const row of rows) {
    const orgId = String(row.id)
    try {
      await init(orgId, triggers.get(orgId))
      orgInitBackoff.delete(orgId)
    } catch (err) {
      failed(orgId, err)
    }
  }
  return notReady
}

/**
 * Orgs whose setup failed and whose retry is not due yet: the claim leaves
 * their events where they are. An org another path set up meanwhile is
 * forgotten here and its events flow again.
 */
function orgsWaitingForRetry(now: number = Date.now()): string[] {
  const waiting: string[] = []
  for (const [orgId, backoff] of orgInitBackoff) {
    if (initializedOrgRuntimes.has(orgId)) orgInitBackoff.delete(orgId)
    else if (backoff.nextAttemptAt > now) waiting.push(orgId)
  }
  return waiting
}

/** The ensure entry every first touch of an org goes through (S3). */
async function initOrgRuntime(orgId: string, trigger?: OrgSetupTrigger): Promise<void> {
  const { awaitOrgApps } = await import("~/modules/apps/init")
  await awaitOrgApps(orgId, trigger)
}

/** The init the tick uses; swapped only by OutboxWorkerTestAccess. */
const outboxOrgInit = { current: initOrgRuntime }

/**
 * Two-phase claim model for crash-safe event processing:
 *
 * 1. CLAIM: atomically mark unclaimed events with claimed_at + claimed_by
 * 2. PROCESS: publish each event via the event bus
 * 3. COMPLETE: mark as processed_at after successful publish
 *
 * If the process crashes between claim and complete, the event remains
 * claimed but not processed. A recovery sweep re-claims stale events
 * (claimed_at > CLAIM_TIMEOUT_SECONDS ago) so they can be retried.
 *
 * DELIVERY CONTRACT — AT-LEAST-ONCE (B23a):
 * Publish (phase 2b) happens BEFORE `processed_at` is written (phase 3). If the
 * process crashes in that window the row is still unprocessed, so the recovery
 * sweep re-claims and RE-PUBLISHES it — consumers can therefore see the same
 * logical event more than once. This is deliberate: we guarantee at-least-once,
 * never exactly-once (which would require a distributed two-phase commit between
 * Postgres and every consumer). Consumers MUST be idempotent.
 *
 * The dedup key is the stable outbox row id, carried on the published event as
 * `_eventId` (see `row.id` below). Idempotent consumers:
 *   - Durable consumers (`runDurableConsumers`) receive `eventId` directly and
 *     upsert/no-op on replay.
 *   - The WS fan-out broadcasts the per-event replay id (`_wsEventId`) inside the
 *     broadcast frame as `eventId`, so a reconnecting client can drop a frame it
 *     already applied (the client advances its replay cursor by `eventId`).
 *   - The MCP catalog notifier keys off the resource/event identity, so a
 *     duplicate `resource:updated` collapses to the same refresh.
 */
export async function processOutboxBatch(): Promise<number> {
  const table = `${schemaRef("kernel")}.pending_events`

  // The events of an org moving to another instance (modules/org/
  // transfer-state/) stay unclaimed until the move is over: processed here
  // after an abort, or on the target, which receives them unprocessed. When
  // the moving orgs cannot be read, nothing is claimed this tick (fail closed).
  let movingOrgs: string[]
  try {
    movingOrgs = await movingOrgIds()
  } catch (err) {
    log.warn({ err }, "Moving orgs unreadable: the outbox claims nothing this tick")
    return 0
  }

  // Phase 1: Claim a batch — mark as ours without setting processed_at.
  //
  // ORDERING (load-bearing): `UPDATE ... RETURNING` does NOT preserve the
  // inner subquery's ORDER BY — rows come back in physical update order, which
  // scrambles under concurrent writes/HOT updates. The per-event loop below IS
  // the fan-out order (durable ws-fanout broadcasts inside it), so an unsorted
  // batch broadcast same-entity events out of order (observed live: 5 rapid
  // updates delivered 0,4,2,1,3 to a real socket). Re-sort by seq here.
  const claimedUnordered = await adminExec(
    `UPDATE ${table}
    SET claimed_at = now(), claimed_by = $1
    WHERE id IN (
      SELECT id FROM ${table}
      WHERE processed_at IS NULL
        AND failed_at IS NULL
        AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $2))
        AND NOT (org_id::text = ANY($4::text[]))
      ORDER BY seq
      LIMIT $3
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, payload, attempts, seq, created_at`,
    [WORKER_ID, CLAIM_TIMEOUT_SECONDS, BATCH_SIZE, [...orgsWaitingForRetry(), ...movingOrgs]],
  )
  const claimed = [...claimedUnordered].sort((a, b) => {
    const sa = BigInt(a.seq as string | number)
    const sb = BigInt(b.seq as string | number)
    return sa < sb ? -1 : sa > sb ? 1 : 0
  })

  // Phase 2a runs the durable consumers over the WHOLE batch as a pipeline,
  // one stage per consumer (durable-consumers.ts): each consumer still sees
  // the events one at a time in `seq` order, and each event still meets its
  // consumers in registration order, but the stages overlap, so a batch no
  // longer costs the sum of every consumer for every event. The WS replay ids
  // are assigned first, in `seq` order, because the durable `ws-fanout`
  // consumer writes the replay buffer with them and `_publishEventInternal`
  // (phase 2b) reuses them so remote replicas broadcast the exact id the
  // originator buffered.
  const prepared: Array<{
    row: (typeof claimed)[number]
    ctx?: DurableEventContext
    err?: unknown
  }> = []
  // Every org in the batch is set up in this process before any consumer sees
  // its events. A not-ready org's events go back unclaimed, attempts untouched
  // (its setup failing is not the event failing), before they take a replay id.
  const orgOf = (row: (typeof claimed)[number]) => (row.payload as AppEvent).orgId ?? ""
  const triggers = new Map<string, OrgSetupTrigger>()
  for (const row of claimed) {
    const orgId = orgOf(row)
    if (orgId === "" || triggers.has(orgId)) continue
    triggers.set(orgId, {
      kind: "outbox-event",
      id: String(row.id),
      queuedAt: new Date(row.created_at as string | Date).getTime(),
    })
  }
  const notReady = await ensureOrgRuntimes(
    claimed.map(orgOf),
    outboxOrgInit.current,
    Date.now(),
    triggers,
  )
  const deferred = claimed.filter((row) => notReady.has(orgOf(row)))
  if (deferred.length > 0) {
    try {
      await adminExec(
        `UPDATE ${table} SET claimed_at = NULL, claimed_by = NULL WHERE id = ANY($1::uuid[])`,
        [deferred.map((row) => row.id as string)],
      )
    } catch (err) {
      log.error(
        { err },
        "Failed to release a not-ready org's events: they return after the claim timeout",
      )
    }
  }
  for (const row of claimed) {
    if (notReady.has(orgOf(row))) continue
    try {
      const event = { ...(row.payload as AppEvent), _eventId: row.id }
      await assignWsReplayId(event)
      prepared.push({ row, ctx: { eventId: row.id as string, event } })
    } catch (err) {
      prepared.push({ row, err })
    }
  }
  const runnable = prepared.filter((p) => p.ctx).map((p) => p.ctx!)
  // The state materializer runs the next minute for an org whose state just
  // changed, and only once in a while for one where nothing did (org-changes.ts).
  // Not awaited: a slow Redis never holds the outbox up (a lost mark costs one heartbeat).
  void markOrgsChanged(runnable.map((ctx) => ctx.event.orgId))
  const outcomes = runDurableConsumerLanes(runnable)
  const outcomeOf = new Map<string, Promise<DurableOutcome>>(
    runnable.map((ctx, i) => [ctx.eventId, outcomes[i]!]),
  )

  // Phase 3 completion is BATCHED: we accumulate the ids of every event that
  // published cleanly and stamp them all with ONE `UPDATE ... WHERE id = ANY($1)`
  // per tick (instead of one round-trip per event). Events are still published
  // sequentially in `seq` order (the ordering contract F1 depends on), each as
  // soon as every consumer lane has passed it. On a mid-batch error we FLUSH
  // the ids accumulated so far BEFORE handling the failure, so a crash right
  // after the failure branch never loses the completions of earlier,
  // already-published events (they'd otherwise re-publish on the next tick —
  // at-least-once, but wasteful and observable as duplicate broadcasts).
  const completedIds: string[] = []
  const flushCompleted = async () => {
    if (completedIds.length === 0) return
    await adminExec(`UPDATE ${table} SET processed_at = now() WHERE id = ANY($1::uuid[])`, [
      [...completedIds],
    ])
    completedIds.length = 0
  }

  let processed = 0
  for (const { row, ctx, err: prepareErr } of prepared) {
    try {
      if (!ctx) throw prepareErr
      // Durable consumers must all succeed before we publish or mark
      // processed — a failure leaves the row unprocessed so the next
      // poll/restart replays it.
      const outcome = await outcomeOf.get(ctx.eventId)!
      if (!outcome.ok) throw outcome.err

      // Phase 2b: Publish via event bus for live in-process handlers.
      await _publishEventInternal(ctx.event)

      // Phase 3 (deferred): queue this id for the batched completion UPDATE.
      completedIds.push(row.id as string)
      processed++
    } catch (err) {
      // Flush completions for every event that succeeded before this one so a
      // failure (and any subsequent crash) cannot strand them unprocessed.
      try {
        await flushCompleted()
      } catch (flushErr) {
        log.error(
          { err: flushErr, eventId: row.id },
          "Failed to flush batched outbox completions before handling event failure",
        )
      }
      if (err instanceof EventDeferredError) {
        // The org started moving after the claim (or its move state cannot be
        // read): retry later, not a failure. Released unprocessed, attempts
        // untouched; the claim skips the org while it moves.
        log.info({ eventId: row.id, orgId: err.orgId, reason: err.reason }, "Outbox event deferred")
        try {
          await adminExec(
            `UPDATE ${table} SET claimed_at = NULL, claimed_by = NULL WHERE id = $1`,
            [row.id],
          )
        } catch (resetErr) {
          log.error(
            { err: resetErr, eventId: row.id },
            "Failed to release a deferred outbox event — will auto-recover after timeout",
          )
        }
        continue
      }
      const newAttempts = (row.attempts ?? 0) + 1
      if (newAttempts >= MAX_ATTEMPTS) {
        // Dead-letter: mark as permanently failed
        log.error(
          { err, eventId: row.id, attempts: newAttempts },
          "Outbox event exhausted retries — dead-lettering",
        )
        try {
          await adminExec(
            `UPDATE ${table} SET failed_at = now(), claimed_at = NULL, claimed_by = NULL, attempts = $2 WHERE id = $1`,
            [row.id, newAttempts],
          )
        } catch (dlErr) {
          log.error({ err: dlErr, eventId: row.id }, "Failed to dead-letter outbox event")
        }
      } else {
        // Release claim with incremented attempt counter for retry on next tick
        log.error(
          { err, eventId: row.id, attempts: newAttempts },
          "Outbox event publish failed — releasing for retry",
        )
        try {
          await adminExec(
            `UPDATE ${table} SET claimed_at = NULL, claimed_by = NULL, attempts = $2 WHERE id = $1`,
            [row.id, newAttempts],
          )
        } catch (resetErr) {
          log.error(
            { err: resetErr, eventId: row.id },
            "Failed to release outbox claim — will auto-recover after timeout",
          )
        }
      }
    }
  }

  // Stamp every cleanly-published event in one round-trip.
  await flushCompleted()

  return processed
}

async function cleanup(): Promise<void> {
  const table = `${schemaRef("kernel")}.pending_events`
  const result = await adminExec(`
    DELETE FROM ${table}
    WHERE (processed_at IS NOT NULL AND processed_at < now() - interval '1 hour')
       OR (failed_at IS NOT NULL AND failed_at < now() - interval '7 days')
  `)
  if (result.count > 0) {
    log.debug({ count: result.count }, "Cleaned up outbox events")
  }
  // The durable consumers' "already handled" marks (consumer-marks.ts) are
  // about the rows above, so they are pruned beside them. The window is the
  // dead-letter window, far longer than the hour a processed row survives, so
  // no mark is ever dropped while its event can still be replayed.
  const marks = await adminExec(`
    DELETE FROM ${schemaRef("kernel")}.durable_consumer_marks
    WHERE created_at < now() - interval '7 days'
  `)
  if (marks.count > 0) {
    log.debug({ count: marks.count }, "Cleaned up durable consumer marks")
  }
}

export function isTickInFlight(): boolean {
  return currentTick !== null
}

/** Set when a wake (or a full batch) arrives while a tick is in flight: run again right after it. */
let tickAgain = false
let lastCleanupAt = 0

/**
 * One drain of the outbox, unless one is in flight (then it runs again once
 * that one settles). Called by the poll interval and by a wake.
 */
function runTick(): void {
  if (!timer) return
  if (currentTick) {
    tickAgain = true
    return
  }
  // Singleton gate: only the process holding the leader lease (on the
  // Patroni-leader node when that gate is on) drains the outbox, so a second
  // process or a warm standby never re-delivers customer emails/webhooks.
  // The interval keeps ticking (heartbeat stays fresh) so a hand-over takes
  // effect within one tick of this process becoming leader.
  if (!isLeader()) {
    lastTickAt = new Date()
    return
  }
  const tick = (async () => {
    try {
      const processed = await processOutboxBatch()
      // A full batch means more is waiting: drain on without waiting a poll.
      if (processed >= BATCH_SIZE) tickAgain = true
      // Run cleanup about once per minute.
      if (Date.now() - lastCleanupAt >= CLEANUP_EVERY_MS) {
        lastCleanupAt = Date.now()
        await cleanup()
      }
    } catch (err) {
      log.error({ err }, "Outbox worker tick failed")
    } finally {
      // The tick itself is the heartbeat -- set on empty batches and after errors too,
      // not just on successful processing.
      lastTickAt = new Date()
    }
  })()
  currentTick = tick
  tick.finally(() => {
    currentTick = null
    if (tickAgain) {
      tickAgain = false
      runTick()
    }
  })
}

export function startOutboxWorker(): void {
  if (timer) return
  log.info({ workerId: WORKER_ID }, "Starting outbox worker")
  // The first cleanup runs a minute in, as before.
  lastCleanupAt = Date.now()
  tickAgain = false
  timer = setInterval(runTick, POLL_INTERVAL_MS)
  // A committed event wakes the drain at once (outbox-wake.ts); the interval
  // is the fallback for a lost wake.
  void subscribeOutboxWake(runTick)
}

/** Resolve once no batch is in flight (the one running now, if any, has settled). */
export async function awaitOutboxIdle(): Promise<void> {
  while (currentTick) await currentTick
}

/**
 * Start the outbox interval and make it the cell's `outbox` singleton: it
 * drains only while this process holds the leader lease (`isLeader()`), and a
 * lost lease completes only once the in-flight batch has settled, so the next
 * leader never claims a batch this process is still delivering. The interval
 * keeps ticking off-lease so the heartbeat stays fresh.
 */
export function registerOutboxSingleton(): void {
  startOutboxWorker()
  registerSingleton({ name: "outbox", onAcquired: () => {}, onLost: awaitOutboxIdle })
}

/** Stop the outbox worker and await any in-flight batch. */
export async function stopOutboxWorker(): Promise<void> {
  if (timer) {
    clearInterval(timer)
    timer = null
    log.info("Stopped outbox worker")
  }
  if (currentTick) {
    await currentTick
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const OutboxWorkerTestAccess = {
  /** Replace the per-org runtime init (null restores the real one) and clear backoff. */
  setOrgInit(init: ((orgId: string) => Promise<void>) | null): void {
    outboxOrgInit.current = init ?? initOrgRuntime
    orgInitBackoff.clear()
  },
  orgInitBackoff(orgId: string): { failures: number; nextAttemptAt: number } | undefined {
    return orgInitBackoff.get(orgId)
  },
  /** Make the org's setup retry due now (its delay passed). */
  expireOrgInitBackoff(orgId: string): void {
    const backoff = orgInitBackoff.get(orgId)
    if (backoff) backoff.nextAttemptAt = 0
  },
  /**
   * Forget the recorded tick, mirroring `DurableConsumersTestAccess.reset`. The
   * heartbeat is module state and `bun test` runs every file in one process, so
   * any earlier file that ticked the worker leaves this set: without the seam a
   * test asserting the pre-start value reads its neighbour's leftover and the
   * verdict depends on file order.
   */
  resetHeartbeat(): void {
    lastTickAt = null
  },
  /**
   * Test-only: deliver a single pending event by id, exercising the durable
   * consumer + publish + processed_at path. Returns true if the event ended up
   * marked processed.
   */
  async deliverPendingEvent(eventId: string): Promise<boolean> {
    const table = `${schemaRef("kernel")}.pending_events`
    const [row] = await adminExec(
      `SELECT id, payload FROM ${table} WHERE id = $1 AND processed_at IS NULL`,
      [eventId],
    )
    if (!row) return false
    try {
      const event = { ...(row.payload as AppEvent), _eventId: row.id }
      await assignWsReplayId(event)
      await runDurableConsumers({ eventId: row.id, event })
      await _publishEventInternal(event)
      await adminExec(`UPDATE ${table} SET processed_at = now() WHERE id = $1`, [row.id])
      return true
    } catch (err) {
      log.error({ err, eventId }, "OutboxWorkerTestAccess.deliverPendingEvent failed")
      return false
    }
  },
}
