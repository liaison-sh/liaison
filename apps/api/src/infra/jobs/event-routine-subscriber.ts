// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, sql as drizzleSql, eq, inArray } from "drizzle-orm"
import Redis from "ioredis"
import { withSystemDb } from "~/db/privileged"
import { routines } from "~/db/schema/kernel"
import {
  type AppEvent,
  type EventSubscriptionDisposer,
  noteOnceDelivery,
  subscribeToEvent,
} from "~/infra/events/event-bus"
import { INSTANCE_ID } from "~/infra/instance-id"
import {
  isMailSenderFilterActive,
  isMailSenderFilterEvent,
  isOwnerScopedEvent,
  isTableRowEvent,
  isTableRowFilter,
  loadRoutineOwnerContext,
  ownerCanSeeEventEntity,
  ownerMailSenderFilterMatches,
  ownerTableRowFilterMatches,
  type RoutineEventFilter,
  triggerEventOrigin,
} from "~/infra/jobs/event-routine-gate"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { registerSingleton } from "~/infra/leadership"
import { env } from "~/lib/env"
import { jobsLogger as log } from "~/lib/logger"
import { REDIS_PREFIX, RESP_PROTOCOL, redis } from "~/lib/redis"
import { isSeededEvent } from "~/modules/notifications/seeded"

/**
 * Coalesce window for event-triggered routines. A burst of matching events
 * FOR THE SAME ENTITY within one window collapses to a single `routine-tick`.
 * Distinct entities each get their own tick (an event routine reacts to its
 * triggerEvent, so absorbing a different entity's event would drop it forever).
 * Default 30s; env-tunable (the social Settings surface can lower it later).
 *
 * The subscriber uses a LEADING-edge debounce (§9 #8): the FIRST event of a
 * window enqueues the tick immediately (enqueue latency ≪ 5s — the one hard
 * end-to-end timing target), then further events within the window are absorbed
 * (no extra enqueue) until the window elapses. Coalescing still holds because
 * the routine tick re-queries ALL `new` findings, so the burst's later events
 * are processed by that single leading tick. This satisfies BOTH §3.3
 * (coalesce a burst into one tick) and §9 #8 (<5s enqueue) — the prior
 * trailing-edge debounce waited the full ~30s before the first enqueue, 6× the
 * §9 #8 budget.
 */
export const EVENT_ROUTINE_COALESCE_MS = Number(process.env.EVENT_ROUTINE_COALESCE_MS ?? 30_000)
// The window in force. Starts at the env value above; only tests change it, via
// EventRoutineSubscriberTestAccess, because the env is read once when this module
// first loads and a test file cannot control which file imports it first.
let coalesceMs = EVENT_ROUTINE_COALESCE_MS

// Active subscriptions keyed by routineId so re-register/uninstall can dispose.
// A disposer removes the routine's route; the bus handler of its event type goes
// with the last route on it.
const disposers = new Map<string, () => Promise<void>>()

/**
 * One bus handler per event type, shared by every event routine on it in this
 * process, routing each event to the routines of the event's org. A cell with
 * thousands of workspaces, each with its own routine on the same event, holds
 * one handler per event type instead of one per routine, and an event costs a
 * map lookup instead of a pass over every routine of the cell.
 */
interface EventChannel {
  event: string
  /** orgId -> routineId -> the routine's subscription. */
  routes: Map<string, Map<string, EventRoutineSub>>
  size: number
  subscribed: Promise<EventSubscriptionDisposer>
}
const channels = new Map<string, EventChannel>()
// What each active subscription was registered with (org, event, sender filter),
// so the cell sync re-registers only a routine whose trigger actually changed and
// never opens a dispose-and-resubscribe gap for an unchanged one.
const signatures = new Map<string, { event: string; signature: string }>()
// Registrations per routine since the last reset (test access only).
const registrationCounts = new Map<string, number>()
// Per (routineId, orgId) suppression timers — once a leading tick is enqueued,
// the key is "suppressed" (further events in the window are no-ops) until this
// timer clears it at the end of the window.
const suppressed = new Map<string, ReturnType<typeof setTimeout>>()

// One registration or disposal per routine at a time: each subscribes before it
// records its disposer, so two running at once (a direct registration from a
// create/enable or an app resume, and the cell sync) would leave one handler on
// the bus that no later dispose reaches. Every public entry point and every
// sync step takes the routine's turn here.
const routineTurns = new Map<string, Promise<void>>()

function inRoutineTurn<T>(routineId: string, fn: () => Promise<T>): Promise<T> {
  const prev = routineTurns.get(routineId) ?? Promise.resolve()
  const result = prev.then(fn, fn)
  const tail = result.then(
    () => {},
    () => {},
  )
  routineTurns.set(routineId, tail)
  void tail.then(() => {
    if (routineTurns.get(routineId) === tail) routineTurns.delete(routineId)
  })
  return result
}

export interface EventRoutineSub {
  routineId: string
  orgId: string
  event: string
  /**
   * Optional sender filter of a `mail:message:create` routine (S26), from the
   * routine's `event_filter` column. Evaluated here, before any tick is
   * enqueued. Every registration path passes it (boot, create/update/enable,
   * app resume), and an update re-registers, so a changed filter applies at once.
   */
  filter?: RoutineEventFilter
}

/**
 * Subscribe an event-routine to its `<app>:<entity>:<action>` event. Idempotent:
 * a re-register disposes the prior handler first (boot-load and a runtime
 * template-enable can both register the same routine after a restart). On a
 * matching event for the routine's org, schedules exactly one `routine-tick`
 * per coalesce window — a burst within the window collapses to one tick.
 * Serialized per routine with every other registration and disposal.
 */
export function registerEventRoutineSubscription(sub: EventRoutineSub): Promise<void> {
  markLocalChange()
  return inRoutineTurn(sub.routineId, () => registerInTurn(sub))
}

async function registerInTurn(sub: EventRoutineSub): Promise<void> {
  await disposeInTurn(sub.routineId) // idempotent re-register
  const [app, entity, action] = sub.event.split(":")
  if (!app || !entity || !action) {
    log.warn(
      { event: sub.event, routineId: sub.routineId },
      "Malformed event-routine event string; skipping",
    )
    return
  }
  const dispose = await addRoute(sub, app, entity, action)
  disposers.set(sub.routineId, dispose)
  signatures.set(sub.routineId, { event: sub.event, signature: subscriptionSignature(sub) })
  registrationCounts.set(sub.routineId, (registrationCounts.get(sub.routineId) ?? 0) + 1)
  log.info({ routineId: sub.routineId, instanceId: INSTANCE_ID }, "event-routine subscribed")
}

/**
 * Route the routine's event to it: through its event type's shared handler,
 * subscribed on the first route. Resolves once the handler is on the bus; a
 * failed subscribe throws and leaves no route behind. Returns the route's removal.
 */
async function addRoute(
  sub: EventRoutineSub,
  app: string,
  entity: string,
  action: string,
): Promise<() => Promise<void>> {
  let channel = channels.get(sub.event)
  if (!channel) {
    const created: EventChannel = {
      event: sub.event,
      routes: new Map(),
      size: 0,
      subscribed: subscribeToEvent(app, entity, action, (evt) => routeEvent(created, evt), {
        // Once (A5): the tick is enqueued by the process that published the
        // event, never again by each peer that receives its copy.
        delivery: "once",
        name: `event-routines:${sub.event}`,
      }),
    }
    channels.set(sub.event, created)
    channel = created
  }
  const ch = channel
  let byOrg = ch.routes.get(sub.orgId)
  if (!byOrg) {
    byOrg = new Map()
    ch.routes.set(sub.orgId, byOrg)
  }
  byOrg.set(sub.routineId, sub)
  ch.size++
  let removed = false
  const remove = async (): Promise<void> => {
    if (removed) return
    removed = true
    const org = ch.routes.get(sub.orgId)
    if (org?.delete(sub.routineId)) {
      ch.size--
      if (org.size === 0) ch.routes.delete(sub.orgId)
    }
    if (ch.size > 0) return
    if (channels.get(ch.event) === ch) channels.delete(ch.event)
    const d = await ch.subscribed.catch(() => null)
    if (d) await d()
  }
  try {
    await ch.subscribed
  } catch (err) {
    await remove()
    throw err
  }
  return remove
}

/** The shared handler of one event type: run each routine of the event's org. */
async function routeEvent(channel: EventChannel, evt: AppEvent): Promise<void> {
  const byOrg = typeof evt.orgId === "string" ? channel.routes.get(evt.orgId) : undefined
  if (!byOrg) return
  for (const sub of [...byOrg.values()]) {
    await noteOnceDelivery(`event-routine:${sub.routineId}`, evt)
    try {
      await handleRoutineEvent(sub, evt)
    } catch (err) {
      log.error({ err, routineId: sub.routineId }, "event-routine handler failed")
    }
  }
}

/**
 * One routine's reaction to an event of its org: the guards, the per-entity
 * coalesce window, then one `routine-tick`.
 */
async function handleRoutineEvent(sub: EventRoutineSub, evt: AppEvent): Promise<void> {
  const [app = "", entity = "", action = ""] = sub.event.split(":")
  // SELF-CASCADE GUARD: a kind:'event' routine that MUTATES the entity it watches (a WIP-limit
  // routine on projects:task:moved that itself calls projects:move) would otherwise re-trigger
  // itself on its OWN moves and over-trim the column past the limit (7→5→3). queue-event stamps the
  // firing routine's id into events emitted during its tick (metadata.firedByRoutineId); drop any
  // event THIS routine itself fired so its mutations never feed back into it. Events from a DIFFERENT
  // routine, or from a human/other actor, still fire normally.
  const firedBy = (evt.metadata as { firedByRoutineId?: string } | null | undefined)
    ?.firedByRoutineId
  if (firedBy === sub.routineId) return
  // A SEED'S OWN WORLD (notifications/seeded.ts). The seed writes its tickets, mail and tasks
  // through the ordinary services, and the outbox delivers their events after the seed has
  // switched its routines on: without this, a demo workspace (a warm-pool one before any visitor
  // owns it, or a visitor's own fresh one) ran its routines on its own seeded backlog.
  if (isSeededEvent(evt)) {
    log.debug(
      { routineId: sub.routineId, event: sub.event, entityId: evt.entityId },
      "event-routine: the event is a seed's own write; dropped",
    )
    return
  }
  // Coalesce PER ENTITY, not per routine: an event routine reacts to the specific
  // triggerEvent it is fired with (e.g. one tick per created ticket), so a routine-wide
  // window would silently absorb a second DISTINCT entity created inside the window —
  // that ticket then never gets a tick. Repeated events for the SAME entity still
  // collapse to one tick per window.
  const key = `${sub.routineId}:${sub.orgId}:${typeof evt.entityId === "string" ? evt.entityId : "none"}`
  if (suppressed.has(key)) return // a leading tick already fired this window
  // OWNER GATE + SENDER FILTER (A32, A52, S26). The routine runs as its owner, so an
  // event about an entity the owner cannot read (another member's personal mailbox,
  // calendar, private contact, personal connection or document) is dropped, and a
  // mail routine with a sender filter only fires for matching inbound mail. Both are
  // read as the owner under RLS, and both run BEFORE the suppression window opens,
  // so a dropped event never absorbs a later one.
  const filterApplies = isMailSenderFilterActive(sub.filter) && isMailSenderFilterEvent(evt)
  // A table row routine's filter (0296): its table, column and the value it moves to, read from
  // the change as the owner, before the window opens (a non-matching edit absorbs nothing).
  const tableFilter = isTableRowEvent(evt) && isTableRowFilter(sub.filter) ? sub.filter : null
  if (isOwnerScopedEvent(evt) || filterApplies || tableFilter) {
    try {
      const owner = await loadRoutineOwnerContext(sub.orgId, sub.routineId)
      if (!owner) return
      if (!(await ownerCanSeeEventEntity(owner, evt))) {
        log.debug(
          { routineId: sub.routineId, event: sub.event, entityId: evt.entityId },
          "event-routine: owner cannot see the event's entity; dropped",
        )
        return
      }
      if (filterApplies && !(await ownerMailSenderFilterMatches(owner, sub.filter, evt))) return
      if (tableFilter && !(await ownerTableRowFilterMatches(owner, tableFilter, evt))) return
    } catch (err) {
      // Fail closed: an event the gate could not judge never reaches the routine.
      log.error({ err, routineId: sub.routineId }, "event-routine owner gate failed; dropped")
      return
    }
    // The gate awaited: an event for the same entity may have opened the window meanwhile.
    if (suppressed.has(key)) return
  }
  // Leading edge: open the suppression window FIRST (so a synchronous burst
  // of events delivered before the await below still sees the window open and
  // is absorbed), then enqueue the tick immediately.
  suppressed.set(
    key,
    setTimeout(() => {
      suppressed.delete(key)
    }, coalesceMs),
  )
  try {
    // Payload extends `RoutineTickOpts` ({ routineId, orgId, scheduledAt }) with the
    // TRIGGERING EVENT so an event routine can REACT to the event that fired it (real-time
    // event semantics) instead of blindly re-scanning. Without this, an `inventory:low`
    // event routine had no way to know WHICH sku crossed its re-order point — it could only
    // re-read live inventory (fragile, store-state-coupled) and could not honor the event-
    // carried available/threshold. We pass a COMPACT, SERIALIZABLE projection of the event
    // (app/entity/action/entityId + its `data` payload) — the worker prepends it to the
    // routine prompt as DATA (prompt-injection-safe), so the tick keys off the real event.
    // The event provenance is also evident from the `jobId` prefix `routine-event:`.
    // `origin` decides whether the tick starts marked as having read outside text: only an
    // event carrying text from outside the org does (scopes/taint.ts).
    const triggerEvent = {
      app,
      entity,
      action,
      entityId: typeof evt.entityId === "string" ? evt.entityId : null,
      data: evt.data ?? null,
      origin: await triggerEventOrigin(evt),
      // The outbox id the audit log keeps for this event: the run row records it, and
      // the reconciler matches runs to events by it (routine-event-reconciler.ts).
      eventId: (evt as { _eventId?: string })._eventId ?? null,
    }
    // In flight from this enqueue until its run row lands: the reconciler
    // must not fire a retry for an event whose first tick is still queued.
    if (triggerEvent.eventId) {
      const { markEventTickInFlight } = await import(
        "~/modules/agent/routines/routine-event-reconciler"
      )
      await markEventTickInFlight(sub.routineId, triggerEvent.eventId)
    }
    await enqueueAppJob(
      "kernel",
      "routine-tick",
      {
        routineId: sub.routineId,
        orgId: sub.orgId,
        scheduledAt: new Date().toISOString(),
        triggerEvent,
      },
      // Include the entityId in the jobId: BullMQ dedups by jobId, and two
      // DISTINCT entities (e.g. two tickets) whose events land in the SAME
      // millisecond would otherwise collide on `routine-event:<routine>:<ms>`
      // and one tick would be silently dropped — the same distinct-entity
      // drop the per-entity coalesce key fixed, reappearing at the jobId
      // layer (prod: a ticket that never got an auto draft). Keying the jobId
      // per entity keeps distinct entities on distinct jobs.
      {
        jobId: `routine-event:${sub.routineId}:${triggerEvent.entityId ?? "none"}:${Date.now()}`,
      },
    )
  } catch (err) {
    log.error({ err, routineId: sub.routineId }, "event-routine enqueue failed")
  }
}

/** Drop the routine's handler, if any. Serialized per routine like registration. */
export function disposeEventRoutineSubscription(routineId: string): Promise<void> {
  markLocalChange()
  return disposeSubscription(routineId)
}

function disposeSubscription(routineId: string): Promise<void> {
  return inRoutineTurn(routineId, () => disposeInTurn(routineId))
}

async function disposeInTurn(routineId: string): Promise<void> {
  const d = disposers.get(routineId)
  if (d) {
    await d()
    disposers.delete(routineId)
    signatures.delete(routineId)
    log.info({ routineId, instanceId: INSTANCE_ID }, "event-routine disposed")
  }
}

/** Order-independent: a filter read back from jsonb has its keys and ids reordered. */
function subscriptionSignature(sub: EventRoutineSub): string {
  const contacts = [...(sub.filter?.fromContactIds ?? [])].sort()
  const groups = [...(sub.filter?.fromGroupIds ?? [])].sort()
  const table = isTableRowFilter(sub.filter)
    ? [
        sub.filter.tableId,
        sub.filter.column ?? null,
        sub.filter.to === undefined ? "<any>" : sub.filter.to,
      ]
    : null
  return JSON.stringify([sub.orgId, sub.event, contacts, groups, table])
}

/** Register unless the same subscription is already in place here (decided in the routine's turn). */
function ensureEventRoutineSubscription(sub: EventRoutineSub): Promise<void> {
  return inRoutineTurn(sub.routineId, async () => {
    if (
      disposers.has(sub.routineId) &&
      signatures.get(sub.routineId)?.signature === subscriptionSignature(sub)
    ) {
      return
    }
    await registerInTurn(sub)
  })
}

// ── Cell-wide sync (P2) ─────────────────────────────────────────────────────
//
// An event routine's handler is `once` (A5): only the process that publishes the
// event runs it, and the outbox leader publishes most of them. A routine created,
// changed or removed on one process must therefore reach every process's bus.
// After its transaction commits, the changing process ANNOUNCES the routine id on
// a cell channel; every process (itself included) re-reads the row and registers
// or disposes. An announce is fire-and-forget pub/sub and can be lost, so a full
// resync from the table also runs on subscriber reconnect, on taking the leader
// lease, and on a timer. The timer pass reads one fingerprint of the table and
// resyncs in full only when it moved (or the subscriptions here moved) since the
// last full resync.

/** The cell channel routine changes are announced on (no keyPrefix on pub/sub). */
export const EVENT_ROUTINE_SYNC_CHANNEL = `${REDIS_PREFIX}routines:event-sub`
export const EVENT_ROUTINE_RESYNC_INTERVAL_MS = 60_000

// The routines a process keeps subscribed: the boot-load rule (kernel-jobs.ts
// subscribeEventRoutinesAtBoot). A routine paused for credits stays subscribed so
// its next tick can resume it.
const SUBSCRIBED_STATUSES = ["active", "paused_no_credits"]

/**
 * Tell every process of the cell that this routine's event subscription may have
 * changed. Call it only AFTER the transaction that changed the row committed: a
 * peer re-reads the row on receipt. Never throws; a lost announce is recovered by
 * the resync.
 */
export async function announceEventRoutineChange(routineId: string, orgId: string): Promise<void> {
  try {
    await redis.publish(EVENT_ROUTINE_SYNC_CHANNEL, JSON.stringify({ routineId, orgId }))
  } catch (err) {
    log.warn(
      { err, routineId, orgId },
      "event-routine change announce failed; the resync recovers it",
    )
  }
}

/** Re-read one routine and make this process's subscription match it. */
async function syncEventRoutine(routineId: string): Promise<void> {
  markLocalChange()
  const [row] = await withSystemDb("event-routine-sync", (db) =>
    db
      .select({
        id: routines.id,
        orgId: routines.orgId,
        kind: routines.kind,
        enabled: routines.enabled,
        status: routines.status,
        event: routines.event,
        eventFilter: routines.eventFilter,
      })
      .from(routines)
      .where(eq(routines.id, routineId)),
  )
  if (
    row &&
    row.kind === "event" &&
    row.enabled &&
    SUBSCRIBED_STATUSES.includes(row.status) &&
    row.event
  ) {
    await ensureEventRoutineSubscription({
      routineId: row.id,
      orgId: row.orgId,
      event: row.event,
      filter: row.eventFilter ?? null,
    })
  } else {
    await disposeSubscription(routineId)
  }
}

const subscribedRoutinesWhere = () =>
  and(
    eq(routines.kind, "event"),
    eq(routines.enabled, true),
    inArray(routines.status, SUBSCRIBED_STATUSES),
  )

/**
 * The fingerprint of the subscribed routines as the table holds them: one row
 * back from the database, whatever the number of routines. The timer resync
 * compares it with the one its last full resync saw.
 */
async function subscribedRoutinesFingerprint(): Promise<string> {
  const [row] = await withSystemDb("event-routine-fingerprint", (db) =>
    db
      .select({
        n: drizzleSql<number>`count(*)::int`,
        h: drizzleSql<string>`md5(coalesce(string_agg(${routines.id}::text || ':' || ${routines.orgId}::text || ':' || coalesce(${routines.event}, '') || ':' || coalesce(${routines.eventFilter}::text, ''), ',' ORDER BY ${routines.id}), ''))`,
      })
      .from(routines)
      .where(subscribedRoutinesWhere()),
  )
  return `${row?.n ?? 0}:${row?.h ?? ""}`
}

// The fingerprint the last full resync left this process in line with, or null
// when anything changed the subscriptions here since (an announce, a direct
// registration or disposal, a failed sync): the next timer resync is then full.
let syncedFingerprint: string | null = null
let localGeneration = 0
let fullResyncCount = 0

/** The subscriptions here moved outside a full resync: the next timer pass is full. */
function markLocalChange(): void {
  localGeneration++
  syncedFingerprint = null
}

/**
 * The periodic safety net: a full resync only when the table changed since the
 * last full one or this process's subscriptions moved meanwhile. Otherwise the
 * subscriptions still match the table and the pass is one aggregate query.
 */
async function resyncIfChanged(): Promise<void> {
  const fingerprint = await subscribedRoutinesFingerprint()
  if (syncedFingerprint !== null && fingerprint === syncedFingerprint) return
  await resyncEventRoutineSubscriptions()
}

/** Make this process's subscriptions match the table: add the missing, drop the stale. */
export async function resyncEventRoutineSubscriptions(): Promise<void> {
  syncedFingerprint = null
  fullResyncCount++
  const generation = localGeneration
  const before = await subscribedRoutinesFingerprint()
  const rows = await withSystemDb("event-routine-resync", (db) =>
    db
      .select({
        id: routines.id,
        orgId: routines.orgId,
        event: routines.event,
        eventFilter: routines.eventFilter,
      })
      .from(routines)
      .where(subscribedRoutinesWhere()),
  )
  const wanted = new Set<string>()
  for (const r of rows) {
    if (!r.event) continue
    wanted.add(r.id)
    await ensureEventRoutineSubscription({
      routineId: r.id,
      orgId: r.orgId,
      event: r.event,
      filter: r.eventFilter ?? null,
    })
  }
  for (const id of [...disposers.keys()]) {
    if (!wanted.has(id)) await disposeSubscription(id)
  }
  // In line with the table as it read before the rows: a change committed in
  // between moves the fingerprint, so the next timer pass resyncs again. A
  // registration or disposal made here meanwhile leaves it unset.
  if (localGeneration === generation) syncedFingerprint = before
}

let syncSubscriber: Redis | null = null
let resyncTimer: ReturnType<typeof setInterval> | null = null
let syncRunning = false
// Announces and resyncs apply one at a time, in arrival order: a resync that read
// the table before a commit never overrides the announce that follows the commit.
let syncChain: Promise<void> = Promise.resolve()

function enqueueSync(label: string, fn: () => Promise<void>): Promise<void> {
  const run = async () => {
    if (!syncRunning) return
    try {
      await fn()
    } catch (err) {
      markLocalChange()
      log.error({ err, instanceId: INSTANCE_ID, sync: label }, "event-routine sync failed")
    }
  }
  syncChain = syncChain.then(run, run)
  return syncChain
}

/**
 * Keep this process's event-routine subscriptions in line with the cell: apply
 * announces, and resync on subscriber reconnect, on leader takeover and every
 * `resyncIntervalMs` (0 turns the timer off). Every role starts it.
 */
export async function startEventRoutineSync(
  opts: { resyncIntervalMs?: number } = {},
): Promise<void> {
  if (syncRunning) return
  syncRunning = true
  // A dedicated subscriber: a connection in subscribe mode serves nothing else.
  const sub = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    protocol: RESP_PROTOCOL,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  })
  syncSubscriber = sub
  let connectedOnce = false
  sub.on("ready", () => {
    // ioredis re-subscribes on reconnect, but what was announced while the
    // connection was down is gone: resync from the table.
    if (connectedOnce) void enqueueSync("reconnect", resyncEventRoutineSubscriptions)
    connectedOnce = true
  })
  sub.on("error", (err) => log.warn({ err }, "event-routine sync subscriber error"))
  sub.on("message", (channel: string, message: string) => {
    if (channel !== EVENT_ROUTINE_SYNC_CHANNEL) return
    let routineId: unknown
    try {
      routineId = (JSON.parse(message) as { routineId?: unknown }).routineId
    } catch {
      log.warn({ message }, "event-routine sync: unparsable announce")
      return
    }
    if (typeof routineId !== "string") return
    void enqueueSync("announce", () => syncEventRoutine(routineId))
  })
  await sub.subscribe(EVENT_ROUTINE_SYNC_CHANNEL)
  // The new leader runs the once handlers: make sure it has every subscription.
  registerSingleton({
    name: "event-routine-resync",
    onAcquired: () => {
      void enqueueSync("leader", resyncEventRoutineSubscriptions)
    },
    onLost: () => {},
  })
  const interval = opts.resyncIntervalMs ?? EVENT_ROUTINE_RESYNC_INTERVAL_MS
  if (interval > 0) {
    resyncTimer = setInterval(() => {
      void enqueueSync("timer", resyncIfChanged)
    }, interval)
    resyncTimer.unref?.()
  }
}

/** Stop the cell sync (shutdown and tests). Subscriptions stay as they are. */
export async function stopEventRoutineSync(): Promise<void> {
  syncRunning = false
  if (resyncTimer) clearInterval(resyncTimer)
  resyncTimer = null
  const sub = syncSubscriber
  syncSubscriber = null
  if (sub) sub.disconnect()
  await syncChain
}

/** Boot-load: subscribe every active kind:'event' routine. */
export async function subscribeActiveEventRoutines(
  routines: Array<{
    id: string
    orgId: string
    event: string | null
    filter?: RoutineEventFilter
  }>,
): Promise<void> {
  for (const r of routines) {
    if (!r.event) continue
    await registerEventRoutineSubscription({
      routineId: r.id,
      orgId: r.orgId,
      event: r.event,
      filter: r.filter,
    })
  }
}

/**
 * TEST-ONLY: clear all subscriber state — suppression-window timers AND the
 * disposer registry. `resetEventBus()` clears the bus's handlers but NOT these
 * module-level Maps, so tests must call this in `beforeEach` to stop a stale
 * timer/disposer from a prior test leaking into the next.
 */
export function __resetEventRoutineSubscriber(): void {
  for (const t of suppressed.values()) clearTimeout(t)
  suppressed.clear()
  // Take the shared handlers off the bus too (on the next microtask), so a test
  // that keeps the bus does not inherit a previous test's routes.
  for (const ch of channels.values()) {
    ch.routes.clear()
    ch.size = 0
    void ch.subscribed.then((d) => d()).catch(() => {})
  }
  channels.clear()
  disposers.clear()
  signatures.clear()
  syncedFingerprint = null
  registrationCounts.clear()
  routineTurns.clear()
}

/**
 * Test access: pin the coalesce window for a test file, whatever the import order
 * of the bun process (another file may have loaded this module first, with the
 * 30s default). `setCoalesceMs()` with no argument restores the env value.
 */
export const EventRoutineSubscriberTestAccess = {
  setCoalesceMs(ms?: number): void {
    coalesceMs = ms ?? EVENT_ROUTINE_COALESCE_MS
  },
  coalesceMs(): number {
    return coalesceMs
  },
  /** The event a routine is subscribed to in this process, or null. */
  registeredEvent(routineId: string): string | null {
    if (!disposers.has(routineId)) return null
    return signatures.get(routineId)?.event ?? null
  },
  /** How many times the routine was (re-)registered since the last reset. */
  registrationCount(routineId: string): number {
    return registrationCounts.get(routineId) ?? 0
  },
  /** Full resyncs (table read, every routine re-checked) since the process started. */
  fullResyncCount(): number {
    return fullResyncCount
  },
  /** How many routes reach the routine in this process (1 when subscribed, never more). */
  routeCount(routineId: string): number {
    let n = 0
    for (const ch of channels.values())
      for (const byOrg of ch.routes.values()) if (byOrg.has(routineId)) n++
    return n
  },
  /** Bus handlers this process holds for event routines: one per event type. */
  eventTypeHandlerCount(): number {
    return channels.size
  },
  /** The cell-sync subscriber connection, while the sync runs. */
  subscriber(): Redis | null {
    return syncSubscriber
  },
}
