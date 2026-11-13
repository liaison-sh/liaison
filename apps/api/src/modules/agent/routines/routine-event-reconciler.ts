// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The delivery guarantee of event routines: every event an event routine should
// have handled gets a run that did its job, or an incident saying it never did.
//
// An event can be lost on its way to a run (the process restarted between the
// event and its tick, the tick was dropped, the agent could not work), and a
// run that could not do its job is recorded failed (routine-tick-outcome.ts).
// The reconciler, a scheduled kernel job, reads the events back from the audit
// log (every non ephemeral event lands there with its outbox id and its data)
// and, for each one with no successful run of the routine, fires the routine
// again for that exact event.
//
//   Matched        an event in kernel.audit_log for the routine's org whose
//                  app, entity and action are the routine's event, inside the
//                  lookback window and at least `minAgeMs` old (its first run
//                  had time to finish), not fired by the routine itself and
//                  not a seed's own write (notifications/seeded.ts), and never
//                  older than the routine itself: a routine created after an
//                  event was never meant to handle it.
//   Served         a run of the routine for that event (by event id, or by the
//                  event's entity id: the subscriber coalesces events of one
//                  entity) ended succeeded, output_thread_recreated or
//                  dispatched. Nothing more happens to it.
//   Still worth it the event family says the event still needs the routine
//                  (FAMILIES below). For a ticket message: the message is
//                  inbound, the ticket is not closed or merged, nobody replied
//                  after it and no reply was drafted after it.
//   Retried        trigger 'retry', attempt n. One in flight per event (a Redis
//                  marker), then exponential backoff between attempts, at most
//                  `maxRetries` failed retries. An event past that is
//                  `exhausted` and stays in the routine's critical incident.
//
// Families are opt in: an event family is reconciled only when it is listed in
// FAMILIES, because the audit log cannot tell an event that was served before
// run rows named their event (0159) from one that was lost, and only a family
// predicate can (a ticket message someone already answered). Only
// tickets:message:create is listed today.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  eventDataForOwner,
  eventHopOf,
  isMailSenderFilterActive,
  isMailSenderFilterEvent,
  isOwnerScopedEvent,
  isProjectTaskFilter,
  isProjectTaskFilterEvent,
  loadRoutineOwnerContext,
  ownerCanSeeEventEntity,
  ownerMailSenderFilterMatches,
  ownerProjectTaskFilterMatches,
  ROUTINE_EVENT_MAX_HOP,
  type RoutineEventFilter,
  triggerEventOrigin,
} from "~/infra/jobs/event-routine-gate"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { reportUndeliveredEvents } from "~/modules/agent/routines/routine-incident"
import type { RoutineTriggerEvent } from "~/modules/agent/routines/routine-worker"
import { sweepSkippingMoving, writeUnlessMoving } from "~/modules/org/transfer-state/skip-moving"

const log = rootLogger.child({ module: "routine-event-reconciler" })

const DAY_MS = 24 * 60 * 60 * 1000

export const RECONCILE_DEFAULTS = {
  lookbackMs: Number(process.env.ROUTINE_EVENT_RECONCILE_LOOKBACK_DAYS ?? 14) * DAY_MS,
  /** An event younger than this is left to its own first run (a support tick runs up to 15 min). */
  minAgeMs: 20 * 60 * 1000,
  maxRetries: Number(process.env.ROUTINE_EVENT_RECONCILE_MAX_RETRIES ?? 3),
  /** Wait after the nth failed retry: base * 2^(n-1). */
  backoffBaseMs: 30 * 60 * 1000,
  /** Retries one routine starts per pass: its ticks run one at a time behind its lock. */
  maxPerRoutine: 5,
  /**
   * How long an enqueued tick (the event's first one or a retry) blocks a retry
   * of the same event when its run row never lands. Its run row clears it
   * sooner. Well above the worst wait of a queued tick: a slow agent queue,
   * then up to an hour of lock deferrals, then a 15 minute tick.
   */
  inFlightTtlSec: 6 * 60 * 60,
} as const

/**
 * A run row that serves its event. `waiting_approval`: the run paused on an
 * approval and resumes with its result (routine-run-resume.ts); it is the
 * event's run, still going, and turns `failed` if it ends without doing its job.
 */
const SERVED = new Set([
  "succeeded",
  "output_thread_recreated",
  "dispatched",
  "waiting_approval",
  // A flow run (0303): going, parked on a wait, flagged for its owner, or ended by its condition.
  "running",
  "waiting",
  "flagged",
  "skipped_condition",
])

interface AuditEvent {
  eventId: string
  timestamp: Date
  entityId: string | null
  actorType: string | null
  data: unknown
  metadata: unknown
}

type FamilyCheck = (
  orgId: string,
  ev: AuditEvent,
) => Promise<{ actionable: true } | { actionable: false; reason: string }>

/** A ticket message still needs triage: inbound, ticket open, nobody answered or drafted since. */
const ticketMessageStillNeedsTriage: FamilyCheck = async (orgId, ev) => {
  const ticketId = (ev.data as { ticketId?: unknown } | null)?.ticketId
  if (!ev.entityId || typeof ticketId !== "string")
    return { actionable: false, reason: "no_ticket" }
  const [row] = await withPrivilegedDb(orgId, "routine-reconcile-ticket", async (tx) =>
    extractRows<{
      kind: string | null
      status: string | null
      merged: boolean | null
      answered: boolean
      drafted: boolean
      superseded: boolean
    }>(
      await tx.execute(drizzleSql`
        SELECT m.kind, t.status, (t.merged_into_ticket_id IS NOT NULL) AS merged,
          EXISTS (
            SELECT 1 FROM ${ticketsRel("messages")} o
            WHERE o.ticket_id = t.id AND o.kind = 'outbound'
              AND NOT COALESCE(o.is_acknowledgement, false) AND o.created_at > m.created_at
          ) AS answered,
          EXISTS (
            SELECT 1 FROM ${kernelRel("approval_requests")} a
            WHERE a.org_id = ${orgId}::uuid AND a.tool_name = 'tickets:reply'
              AND a.current_payload->>'ticketId' = t.id::text AND a.created_at > m.created_at
          ) AS drafted,
          EXISTS (
            SELECT 1 FROM ${ticketsRel("messages")} n
            WHERE n.ticket_id = t.id AND n.kind = 'inbound' AND n.id <> m.id
              AND (n.created_at, n.id) > (m.created_at, m.id)
          ) AS superseded
        FROM ${ticketsRel("messages")} m
        JOIN ${ticketsRel("tickets")} t ON t.id = m.ticket_id
        WHERE m.id::text = ${ev.entityId} AND t.id::text = ${ticketId} AND t.org_id = ${orgId}::uuid
        LIMIT 1`),
    ),
  )
  if (!row) return { actionable: false, reason: "message_gone" }
  if (row.kind !== "inbound") return { actionable: false, reason: "not_inbound" }
  if (row.status === "closed" || row.merged) return { actionable: false, reason: "ticket_closed" }
  if (row.answered) return { actionable: false, reason: "answered" }
  if (row.drafted) return { actionable: false, reason: "drafted" }
  // A triage reads the whole conversation: only the newest unanswered inbound
  // message of a ticket is fired again, or one ticket gets a draft per message.
  if (row.superseded) return { actionable: false, reason: "superseded" }
  return { actionable: true }
}

/**
 * A task status change still needs its run while the task exists and still sits in the status it
 * moved to: a task that moved on since has a newer transition, with its own event (0303).
 */
const taskStatusChangeStillCurrent: FamilyCheck = async (orgId, ev) => {
  const toStatusId = (ev.data as { toStatusId?: unknown } | null)?.toStatusId
  if (!ev.entityId || typeof toStatusId !== "string")
    return { actionable: false, reason: "no_task" }
  const [row] = await withPrivilegedDb(orgId, "routine-reconcile-task", async (tx) =>
    extractRows<{ status_id: string }>(
      await tx.execute(drizzleSql`
        SELECT status_id FROM ${projectsRel("tasks")}
        WHERE id = ${ev.entityId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`),
    ),
  )
  if (!row) return { actionable: false, reason: "task_gone" }
  if (row.status_id !== toStatusId) return { actionable: false, reason: "status_moved_on" }
  return { actionable: true }
}

/** Event families the reconciler handles, keyed `app:entity:action`. */
export const RECONCILE_FAMILIES: Record<string, FamilyCheck> = {
  "tickets:message:create": ticketMessageStillNeedsTriage,
  "projects:task:status_changed": taskStatusChangeStillCurrent,
}

/**
 * Families where a served run for an entity serves its every event (a ticket's newest message is
 * triaged with the whole conversation). A task's status changes are each their own run.
 */
const EACH_EVENT_ITS_OWN_RUN = new Set(["projects:task:status_changed"])

export interface ReconcileOptions {
  now?: Date
  lookbackMs?: number
  /** Overrides lookbackMs: reconcile events since this instant (the one shot backfill). */
  since?: Date
  minAgeMs?: number
  maxRetries?: number
  backoffBaseMs?: number
  maxPerRoutine?: number
  orgId?: string
  routineId?: string
  /** Report what would be retried, enqueue nothing, raise nothing. */
  dryRun?: boolean
  /** Test seam: what starts the retry tick. Defaults to the routine-tick job. */
  enqueue?: (payload: {
    routineId: string
    orgId: string
    scheduledAt: string
    triggerEvent: RoutineTriggerEvent
  }) => Promise<void>
}

export interface ReconcileEventReport {
  routineId: string
  eventId: string
  entityId: string | null
  at: string
  outcome:
    | "served"
    | "retried"
    | "would_retry"
    | "in_flight"
    | "backoff"
    | "exhausted"
    | "deferred"
    | `skipped:${string}`
  attempt?: number
}

export interface ReconcileReport {
  routines: number
  events: ReconcileEventReport[]
  counts: Record<string, number>
}

interface RoutineRow {
  id: string
  orgId: string
  name: string
  event: string
  eventFilter: RoutineEventFilter
  createdAt: Date
}

interface RunRow {
  eventId: string | null
  eventEntityId: string | null
  status: string
  trigger: string | null
  ranAt: Date
  error: string | null
}

async function defaultEnqueue(payload: Parameters<NonNullable<ReconcileOptions["enqueue"]>>[0]) {
  const { enqueueAppJob, enqueueAppJobForServer, isJobWorkerRegistered } = await import(
    "~/infra/jobs/jobs"
  )
  // The server hosts the routine-tick worker; the CLI backfill hands it the job.
  const enqueueFn = isJobWorkerRegistered("kernel", "routine-tick")
    ? enqueueAppJob
    : enqueueAppJobForServer
  await enqueueFn("kernel", "routine-tick", payload, {
    jobId: `routine-retry:${payload.routineId}:${payload.triggerEvent.eventId}:${payload.triggerEvent.retryAttempt}`,
  })
}

export const inFlightKey = (routineId: string, eventId: string) =>
  `routine-retry-inflight:${routineId}:${eventId}`

/**
 * The subscriber's half of "in flight from enqueue": the event's first tick is
 * queued, so no retry starts until its run row lands (the worker clears this)
 * or the stale timeout passes. Best effort: a lost marker costs a possible
 * early retry, never a lost event.
 */
export async function markEventTickInFlight(routineId: string, eventId: string): Promise<void> {
  try {
    await redis.set(inFlightKey(routineId, eventId), "0", "EX", RECONCILE_DEFAULTS.inFlightTtlSec)
  } catch (err) {
    log.warn({ err, routineId, eventId }, "Event tick in-flight marker not set")
  }
}

/** One pass over every active event routine of a reconciled family. */
export async function reconcileEventRoutines(
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const now = opts.now ?? new Date()
  const since =
    opts.since ?? new Date(now.getTime() - (opts.lookbackMs ?? RECONCILE_DEFAULTS.lookbackMs))
  const until = new Date(now.getTime() - (opts.minAgeMs ?? RECONCILE_DEFAULTS.minAgeMs))
  const maxRetries = opts.maxRetries ?? RECONCILE_DEFAULTS.maxRetries
  const backoffBaseMs = opts.backoffBaseMs ?? RECONCILE_DEFAULTS.backoffBaseMs
  const maxPerRoutine = opts.maxPerRoutine ?? RECONCILE_DEFAULTS.maxPerRoutine
  const enqueue = opts.enqueue ?? defaultEnqueue
  const families = Object.keys(RECONCILE_FAMILIES)
  // An org being moved keeps its routines and runs as they are until the move ends.

  const routines = await sweepSkippingMoving((notMoving) =>
    withSystemDb("routine-reconcile-routines", async (db) =>
      extractRows<{
        id: string
        org_id: string
        name: string
        event: string
        event_filter: unknown
        created_at: Date
      }>(
        await db.execute(drizzleSql`
        SELECT id, org_id, name, event, event_filter, created_at FROM ${kernelRel("routines")}
        WHERE kind = 'event' AND enabled AND status = 'active'
          AND ${notMoving(drizzleSql.raw("org_id"))}
          AND event IN (${drizzleSql.join(
            families.map((f) => drizzleSql`${f}`),
            drizzleSql`, `,
          )})
          ${opts.orgId ? drizzleSql`AND org_id = ${opts.orgId}::uuid` : drizzleSql``}
          ${opts.routineId ? drizzleSql`AND id = ${opts.routineId}::uuid` : drizzleSql``}`),
      ).map(
        (r): RoutineRow => ({
          id: r.id,
          orgId: r.org_id,
          name: r.name,
          event: r.event,
          eventFilter: (r.event_filter as RoutineEventFilter) ?? null,
          createdAt: new Date(r.created_at),
        }),
      ),
    ),
  )

  const report: ReconcileReport = { routines: routines.length, events: [], counts: {} }
  for (const routine of routines) {
    try {
      await writeUnlessMoving(routine.orgId, () =>
        reconcileRoutine(routine, {
          since,
          until,
          now,
          maxRetries,
          backoffBaseMs,
          maxPerRoutine,
          enqueue,
          dryRun: !!opts.dryRun,
          report,
        }),
      )
    } catch (err) {
      log.error({ err, routineId: routine.id }, "Routine event reconcile failed for this routine")
    }
  }
  for (const e of report.events) report.counts[e.outcome] = (report.counts[e.outcome] ?? 0) + 1
  return report
}

async function reconcileRoutine(
  routine: RoutineRow,
  ctx: {
    since: Date
    until: Date
    now: Date
    maxRetries: number
    backoffBaseMs: number
    maxPerRoutine: number
    enqueue: NonNullable<ReconcileOptions["enqueue"]>
    dryRun: boolean
    report: ReconcileReport
  },
): Promise<void> {
  const [app, entity, action] = routine.event.split(":")
  const family = RECONCILE_FAMILIES[routine.event]
  if (!app || !entity || !action || !family) return
  // An event from before the routine existed was never this routine's to handle: the subscriber
  // gave it to the routines that existed then, and a retry here would act on a stale record.
  const since = routine.createdAt > ctx.since ? routine.createdAt : ctx.since

  const events = await withPrivilegedDb(routine.orgId, "routine-reconcile-events", async (tx) =>
    extractRows<{
      event_id: string
      timestamp: Date
      entity_id: string | null
      actor_type: string | null
      changes: unknown
      metadata: unknown
    }>(
      await tx.execute(drizzleSql`
        SELECT event_id, "timestamp", entity_id, actor_type::text AS actor_type, changes, metadata
        FROM ${kernelRel("audit_log")}
        WHERE org_id = ${routine.orgId}::uuid AND app = ${app} AND entity_type = ${entity}
          AND action = ${`${entity}.${action}`} AND event_id IS NOT NULL
          AND "timestamp" >= ${since.toISOString()}::timestamptz
          AND "timestamp" <= ${ctx.until.toISOString()}::timestamptz
          AND COALESCE(metadata->>'firedByRoutineId', '') <> ${routine.id}
          AND COALESCE(metadata->>'seeded', '') <> 'true'
          -- A routine chain this deep was dropped by the subscriber, on purpose: replaying it
          -- would carry the loop on (0303).
          AND CASE WHEN metadata->>'hop' ~ '^[0-9]{1,6}$' THEN (metadata->>'hop')::int ELSE 0 END
              < ${ROUTINE_EVENT_MAX_HOP}
        ORDER BY "timestamp" ASC
        LIMIT 2000`),
    ).map(
      (r): AuditEvent => ({
        eventId: r.event_id,
        timestamp: new Date(r.timestamp),
        entityId: r.entity_id,
        actorType: r.actor_type,
        data: r.changes,
        metadata: r.metadata,
      }),
    ),
  )
  if (events.length === 0) {
    if (!ctx.dryRun) await reportUndeliveredEvents({ orgId: routine.orgId, routine, exhausted: [] })
    return
  }

  const runs = await withPrivilegedDb(routine.orgId, "routine-reconcile-runs", async (tx) =>
    extractRows<{
      event_id: string | null
      event_entity_id: string | null
      status: string
      trigger: string | null
      ran_at: Date
      error: string | null
    }>(
      await tx.execute(drizzleSql`
        SELECT event_id, event_entity_id, status, "trigger", ran_at, error
        FROM ${kernelRel("routine_runs")}
        WHERE routine_id = ${routine.id}::uuid
          AND (event_id IS NOT NULL OR event_entity_id IS NOT NULL)
          AND ran_at >= ${ctx.since.toISOString()}::timestamptz`),
    ).map(
      (r): RunRow => ({
        eventId: r.event_id,
        eventEntityId: r.event_entity_id,
        status: r.status,
        trigger: r.trigger,
        ranAt: new Date(r.ran_at),
        error: r.error,
      }),
    ),
  )
  const byEvent = new Map<string, RunRow[]>()
  const servedEntities = new Set<string>()
  for (const run of runs) {
    if (run.eventId) byEvent.set(run.eventId, [...(byEvent.get(run.eventId) ?? []), run])
    if (run.eventEntityId && SERVED.has(run.status)) servedEntities.add(run.eventEntityId)
  }

  const exhausted: Array<{ eventId: string; entityId: string | null; lastError: string | null }> =
    []
  let started = 0
  const push = (ev: AuditEvent, outcome: ReconcileEventReport["outcome"], attempt?: number) =>
    ctx.report.events.push({
      routineId: routine.id,
      eventId: ev.eventId,
      entityId: ev.entityId,
      at: ev.timestamp.toISOString(),
      outcome,
      ...(attempt !== undefined ? { attempt } : {}),
    })

  for (const ev of events) {
    const own = byEvent.get(ev.eventId) ?? []
    const servedByEntity =
      !EACH_EVENT_ITS_OWN_RUN.has(routine.event) && !!ev.entityId && servedEntities.has(ev.entityId)
    if (own.some((r) => SERVED.has(r.status)) || servedByEntity) {
      push(ev, "served")
      continue
    }
    // A tick for this event is queued or running (the first one, or a retry
    // enqueued by an earlier pass or the CLI): its run row decides, not us.
    // Read for a dry run too, so it reports what an executed pass would do.
    if ((await redis.exists(inFlightKey(routine.id, ev.eventId))) > 0) {
      push(ev, "in_flight")
      continue
    }
    const failedRetries = own.filter((r) => r.trigger === "retry" && r.status === "failed")
    const lastRetry = own
      .filter((r) => r.trigger === "retry")
      .reduce<Date | null>((acc, r) => (!acc || r.ranAt > acc ? r.ranAt : acc), null)

    const check = await family(routine.orgId, ev)
    if (!check.actionable) {
      push(ev, `skipped:${check.reason}`)
      continue
    }
    if (failedRetries.length >= ctx.maxRetries) {
      const lastError = own.reduce<RunRow | null>(
        (acc, r) => (!acc || r.ranAt > acc.ranAt ? r : acc),
        null,
      )?.error
      exhausted.push({ eventId: ev.eventId, entityId: ev.entityId, lastError: lastError ?? null })
      push(ev, "exhausted", failedRetries.length)
      continue
    }
    if (lastRetry && failedRetries.length > 0) {
      const wait = ctx.backoffBaseMs * 2 ** (failedRetries.length - 1)
      if (ctx.now.getTime() < lastRetry.getTime() + wait) {
        push(ev, "backoff", failedRetries.length)
        continue
      }
    }
    // The owner gate and sender filter the subscriber applies (event-routine-gate.ts).
    const gateEvent = {
      app,
      entity,
      action,
      orgId: routine.orgId,
      entityId: ev.entityId,
      data: ev.data,
      actorType: ev.actorType ?? undefined,
    }
    const filterApplies =
      isMailSenderFilterActive(routine.eventFilter) && isMailSenderFilterEvent(gateEvent)
    let gatedOwner: Awaited<ReturnType<typeof loadRoutineOwnerContext>> = null
    // The record filter's declaration lives in the org's registries (flow-records.ts).
    const { awaitOrgApps } = await import("~/modules/apps/init")
    await awaitOrgApps(routine.orgId)
    const taskFilter =
      isProjectTaskFilterEvent(gateEvent) && isProjectTaskFilter(routine.eventFilter)
        ? routine.eventFilter
        : null
    if (isOwnerScopedEvent(gateEvent) || filterApplies || taskFilter) {
      const owner = await loadRoutineOwnerContext(routine.orgId, routine.id)
      if (!owner || !(await ownerCanSeeEventEntity(owner, gateEvent))) {
        push(ev, "skipped:owner_cannot_see")
        continue
      }
      gatedOwner = owner
      if (
        filterApplies &&
        !(await ownerMailSenderFilterMatches(owner, routine.eventFilter, gateEvent))
      ) {
        push(ev, "skipped:sender_filter")
        continue
      }
      if (taskFilter && !(await ownerProjectTaskFilterMatches(owner, taskFilter, gateEvent))) {
        push(ev, "skipped:task_filter")
        continue
      }
    }
    const attempt = failedRetries.length + 1
    if (started >= ctx.maxPerRoutine) {
      push(ev, "deferred", attempt)
      continue
    }
    if (ctx.dryRun) {
      push(ev, "would_retry", attempt)
      started++
      continue
    }
    // One retry in flight per event: set-if-absent, so two passes racing past
    // the read above still start only one.
    const marked = await redis.set(
      inFlightKey(routine.id, ev.eventId),
      String(attempt),
      "EX",
      RECONCILE_DEFAULTS.inFlightTtlSec,
      "NX",
    )
    if (marked !== "OK") {
      push(ev, "in_flight", attempt)
      continue
    }
    const triggerEvent: RoutineTriggerEvent = {
      app,
      entity,
      action,
      entityId: ev.entityId,
      data: eventDataForOwner(gatedOwner, gateEvent) ?? null,
      origin: await triggerEventOrigin({ ...gateEvent }),
      eventId: ev.eventId,
      retryAttempt: attempt,
      // The chain depth the event had: the retry's writes carry it on, as the first tick's would.
      ...(eventHopOf(ev.metadata) > 0 ? { hop: eventHopOf(ev.metadata) } : {}),
    }
    try {
      await ctx.enqueue({
        routineId: routine.id,
        orgId: routine.orgId,
        scheduledAt: ctx.now.toISOString(),
        triggerEvent,
      })
      started++
      push(ev, "retried", attempt)
      log.info(
        { routineId: routine.id, eventId: ev.eventId, entityId: ev.entityId, attempt },
        "routine event reconciler: event had no successful run, routine fired again",
      )
    } catch (err) {
      await redis.del(inFlightKey(routine.id, ev.eventId)).catch(() => {})
      log.error({ err, routineId: routine.id, eventId: ev.eventId }, "Retry could not be enqueued")
    }
  }
  if (!ctx.dryRun) await reportUndeliveredEvents({ orgId: routine.orgId, routine, exhausted })
}

/** Test access: clear the in-flight markers of a routine. */
export const RoutineEventReconcilerTestAccess = {
  async clearInFlight(routineId: string): Promise<void> {
    const keys = await redis.keys(`routine-retry-inflight:${routineId}:*`)
    if (keys.length > 0) await redis.del(...keys)
  },
}
