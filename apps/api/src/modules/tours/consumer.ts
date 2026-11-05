// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `tour-progress`: the durable consumer that completes a guided tour's `do`
 * beat when its product event happens, whatever path caused it (the person's
 * click, a keyboard shortcut, another screen, their agent). Tours complete on
 * events, never on clicks (S23).
 *
 * For each outbox event:
 *  1. In memory first: the event's `app:entity:action` must be bound by some
 *     `do` beat of some tour (the static set below), else nothing is read.
 *  2. The actor: the beat's `actor` rule decides who may have caused it. The
 *     tour's owner is the event's `actorId`: for an agent turn that is the
 *     human who asked (`actorType: "agent"`, the requester in `actorId`, the
 *     agent in `agentId`; see AppEvent), so `user-or-agent` accepts that and
 *     `user` (the default) accepts only the person's own action. Fails
 *     closed: an event naming no actor type, and anything a routine's run
 *     emitted, completes nothing. The exception is a beat bound with
 *     `actor: "any"`, which waits on anyone's work (a routine's note) on an
 *     entity this run recorded: its rows are read for the whole org, its
 *     `match` keeps it to its own run, and an event that arrives before the
 *     tour reaches the beat is recorded on the row (`beatDoneAhead`).
 *  3. The owner's ACTIVE rows for the tours that bind it; per row, the current
 *     effective beat must be a `do` beat whose binding matches (`match` is an
 *     exact match on top-level `event.data` fields).
 *  4. A move onto a world beat passes the demo-org guard first. Advance with
 *     a compare-and-set on the row, in one privileged transaction
 *     with a per-(event, owner, tour) consumer mark, so a redelivered event
 *     never advances twice; the move queues `kernel/tour:update` for the owner.
 *     The event's entity id is kept in the beat's state, so a later beat's
 *     autoplay works on what the tour created.
 *
 * Registered after every other durable consumer, and it never throws (an error
 * is logged and costs a tour step, never another consumer's delivery).
 */
import {
  bindingScopedToRun,
  createdEntityIds,
  type EffectiveBeat,
  heldTools,
  matchEntityRef,
  type Tour,
  type TourEventBinding,
  type TourProgress,
} from "@liaison/shared"
import { and, asc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { durableConsumerMarks, messages, pendingEvents, tourProgress } from "~/db/schema/kernel"
import {
  type DurableEventContext,
  registerDurableEventConsumer,
} from "~/infra/events/durable-consumers"
import type { AppEvent } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { UUID_RE } from "~/lib/uuid"
import { listLiveAgentTurns, onLiveAgentTurnChange } from "~/modules/agent/runtime/stream-registry"
import {
  noteRoutineRunEnded,
  nudgeActiveTours,
  registerTourAgentTurnNudges,
  routineRaisedNothingFor,
} from "~/modules/tours/beat-status"
import {
  assertWorldBeatAllowed,
  completeDoBeat,
  currentIndex,
  loadTourOrgContext,
  passUnraisedBeats,
  progressOf,
  readProgressRow,
  serverTourCatalogue,
  type TourState,
  tourBeats,
  writeTourMove,
} from "~/modules/tours/service"

const log = rootLogger.child({ module: "tour-progress" })

export const TOUR_PROGRESS_CONSUMER = "tour-progress"

const eventKey = (app: string, entity: string, action: string) => `${app}:${entity}:${action}`

/** The event a held write's approval is proposed with (`TourEventBinding.heldAs`). */
const HELD_KEY = "kernel:approval_request:create"

/**
 * The bindings a held write's approval is matched against: the beat's own
 * actor and run rules (`causedBy`), on the approval of one of its `heldAs`
 * tools (one binding per tool).
 */
export function heldBindings(binding: TourEventBinding): TourEventBinding[] {
  return heldTools(binding).map((toolName) => ({
    app: "kernel",
    entity: "approval_request",
    action: "create",
    match: { toolName },
    ...(binding.actor ? { actor: binding.actor } : {}),
    ...(binding.causedBy ? { causedBy: binding.causedBy } : {}),
  }))
}

/** For each bound `app:entity:action`, the tours with a `do` beat bound to it. */
let boundIndex: Map<string, Tour[]> | null = null

function toursBoundTo(key: string): Tour[] {
  if (!boundIndex) {
    const index = new Map<string, Tour[]>()
    for (const tour of serverTourCatalogue()) {
      const keys = new Set<string>()
      for (const beat of tour.beats) {
        if (beat.kind === "do" && beat.event) {
          keys.add(eventKey(beat.event.app, beat.event.entity, beat.event.action))
          // A write that may park for approval completes on that approval too.
          if (beat.event.heldAs) keys.add(HELD_KEY)
        }
      }
      for (const k of keys) index.set(k, [...(index.get(k) ?? []), tour])
    }
    boundIndex = index
  }
  return boundIndex.get(key) ?? []
}

/** The event was emitted during a routine's run (queue-event.ts stamps it). */
function firedByRoutine(event: Pick<AppEvent, "metadata">): boolean {
  const meta = event.metadata
  if (typeof meta !== "object" || meta === null) return false
  const id = (meta as { firedByRoutineId?: unknown }).firedByRoutineId
  return typeof id === "string" && id.length > 0
}

/**
 * Did this event's actor satisfy the beat's actor rule for `ownerUserId`?
 * Fails closed: `user` needs an event that says it is the person's own
 * action (`actorType: "user"`; an event naming no type is not one), and
 * `user-or-agent` adds only an agent turn the person asked for, never a
 * routine's run (`metadata.firedByRoutineId`), which acts for them unasked.
 */
export function actorSatisfies(
  binding: TourEventBinding,
  event: Pick<AppEvent, "actorId" | "actorType" | "metadata">,
  ownerUserId: string,
): boolean {
  // Anyone's work on what this run brought in (the binding's match names it).
  if (binding.actor === "any") return true
  if (!event.actorId || event.actorId !== ownerUserId) return false
  if (firedByRoutine(event)) return false
  if (event.actorType === "user") return true
  return binding.actor === "user-or-agent" && event.actorType === "agent"
}

/** `data` at a dotted path (`currentPayload.ticketId`), or undefined. */
function fieldAt(data: unknown, path: string): unknown {
  let at: unknown = data
  for (const key of path.split(".")) {
    if (typeof at !== "object" || at === null) return undefined
    at = (at as Record<string, unknown>)[key]
  }
  return at
}

/** The message the agent turn that emitted this event answers (queue-event.ts stamps it). */
function turnMessageOf(event: Pick<AppEvent, "metadata">): string | null {
  const meta = event.metadata
  if (typeof meta !== "object" || meta === null) return null
  const id = (meta as { turnMessageId?: unknown }).turnMessageId
  return typeof id === "string" && id.length > 0 ? id : null
}

/**
 * Does the turn answering `turnMessageId` follow up on the ask `askedId`? The
 * same message, or a later message in the same conversation (the person
 * answered the agent's question back, and the agent then did it). A turn in
 * another conversation, or one answering an earlier message, does not.
 */
export async function turnFollowsAsk(
  orgId: string,
  askedId: string,
  turnMessageId: string,
): Promise<boolean> {
  if (turnMessageId === askedId) return true
  if (!UUID_RE.test(askedId) || !UUID_RE.test(turnMessageId)) return false
  const rows = await withPrivilegedDb(orgId, "tour-progress-turn", (tx) =>
    tx
      .select({ id: messages.id, threadId: messages.threadId, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), inArray(messages.id, [askedId, turnMessageId]))),
  )
  const asked = rows.find((r) => r.id === askedId)
  const turn = rows.find((r) => r.id === turnMessageId)
  if (!asked || !turn) return false
  return asked.threadId === turn.threadId && turn.createdAt >= asked.createdAt
}

/**
 * The binding against the event: its identity, its `match` (exact, dotted
 * paths, `{beat-id}` values read from `created`), and the run scoping
 * (`causedBy`, `sameEntityAs`). `created` is what this run's earlier beats
 * recorded, by beat id; a scoped binding with nothing recorded never matches,
 * so a beat is never completed by something outside its own run.
 * `followsAsk`: the event's turn answers a later message of the ask's own
 * conversation (`turnFollowsAsk`, read by the caller from the database).
 */
export function bindingMatches(
  binding: TourEventBinding,
  event: AppEvent,
  created: Readonly<Record<string, string>> = {},
  followsAsk = false,
): boolean {
  if (
    binding.app !== event.app ||
    binding.entity !== event.entity ||
    binding.action !== event.action
  ) {
    return false
  }
  if (binding.causedBy !== undefined) {
    const asked = created[binding.causedBy]
    const turn = turnMessageOf(event)
    if (!asked || !turn) return false
    if (turn !== asked && !followsAsk) return false
  }
  if (binding.sameEntityAs !== undefined) {
    const entity = created[binding.sameEntityAs]
    if (!entity || event.entityId !== entity) return false
  }
  if (!binding.match) return true
  const data = event.data
  if (typeof data !== "object" || data === null) return false
  return Object.entries(binding.match).every(([path, expected]) => {
    if (Array.isArray(expected)) return expected.includes(fieldAt(data, path) as string)
    const ref = typeof expected === "string" ? matchEntityRef(expected) : null
    const want = ref === null ? expected : created[ref]
    return want !== undefined && fieldAt(data, path) === want
  })
}

/** A tool call stored on an agent's message (`metadata.toolCalls`, agent-service.ts). */
interface StoredToolCall {
  toolName?: unknown
  status?: unknown
  result?: unknown
}

/**
 * Did the turn that wrote the agent message `messageId` make at least one
 * successful call to a tool `turnUsed` names (`TourEventBinding.turnUsed`)? A
 * call counts when it completed and its result is not a refusal (`{ error }`)
 * or a parked approval (`{ blocked: true }`). Read from the stored message:
 * its tool calls are persisted with it, before its create event is queued.
 */
export async function turnUsedSucceeded(
  orgId: string,
  messageId: string | undefined,
  turnUsed: NonNullable<TourEventBinding["turnUsed"]>,
): Promise<boolean> {
  if (!messageId || !UUID_RE.test(messageId)) return false
  const [row] = await withPrivilegedDb(orgId, "tour-progress-turn-tools", (tx) =>
    tx
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)))
      .limit(1),
  )
  const calls = (row?.metadata as { toolCalls?: unknown } | null | undefined)?.toolCalls
  if (!Array.isArray(calls)) return false
  const prefix = `${turnUsed.app}__`
  return (calls as StoredToolCall[]).some((call) => {
    if (typeof call?.toolName !== "string" || !call.toolName.startsWith(prefix)) return false
    const tool = call.toolName.slice(prefix.length)
    if (turnUsed.tools && !turnUsed.tools.includes(tool)) return false
    if (call.status !== "completed") return false
    const result = call.result
    if (typeof result === "object" && result !== null) {
      const r = result as { error?: unknown; blocked?: unknown }
      if (r.error !== undefined && r.error !== null) return false
      if (r.blocked === true) return false
    }
    return true
  })
}

/**
 * An agent turn still runs in the conversation the event happened in
 * (`TourEventBinding.turnsEnded`): the stream registry's live turns there,
 * cell-wide, read without their content (P2-13). A read Redis does not answer
 * counts as a turn running (closed: the step is not done yet, and the next
 * event or turn end looks again).
 */
async function turnRunsWhere(orgId: string, event: Pick<AppEvent, "data">): Promise<boolean> {
  const data = event.data
  if (typeof data !== "object" || data === null) return false
  const threadId = (data as { threadId?: unknown }).threadId
  if (typeof threadId !== "string" || threadId.length === 0) return false
  return anyLiveTurn(orgId, threadId).catch((err: unknown) => {
    log.warn({ err, threadId }, "Could not read the live turns of a tour step's conversation")
    return true
  })
}

async function anyLiveTurn(orgId: string, threadId: string): Promise<boolean> {
  return (await listLiveAgentTurns(threadId)).some((turn) => turn.orgId === orgId)
}

type RowState = Parameters<typeof currentIndex>[1]

/**
 * Does this event complete `beat` for a row at `state`? `held`: it did so as
 * the approval its write parked as (`heldAs`), not the write.
 */
async function eventCompletes(
  orgId: string,
  beat: EffectiveBeat,
  state: RowState,
  event: AppEvent,
  ownerUserId: string,
): Promise<{ held: boolean } | null> {
  if (beat.kind !== "do" || !beat.event) return null
  const created = createdEntityIds(state.beatStates)
  const matches = async (binding: TourEventBinding) => {
    const asked = binding.causedBy ? created[binding.causedBy] : undefined
    const turn = turnMessageOf(event)
    const follows =
      asked &&
      turn &&
      turn !== asked &&
      bindingMatches({ ...binding, causedBy: undefined }, event, created)
        ? await turnFollowsAsk(orgId, asked, turn)
        : false
    if (
      !bindingMatches(binding, event, created, follows) ||
      !actorSatisfies(binding, event, ownerUserId)
    ) {
      return false
    }
    // Not the last word while a turn still runs there: looked for again when
    // the last one ends (`settleTurnsEndedBeats`).
    if (binding.turnsEnded && (await turnRunsWhere(orgId, event))) return false
    // An agent's answer counts only from a turn that really used what it names.
    return binding.turnUsed ? turnUsedSucceeded(orgId, event.entityId, binding.turnUsed) : true
  }
  if (await matches(beat.event)) return { held: false }
  for (const held of heldBindings(beat.event)) {
    if (await matches(held)) return { held: true }
  }
  return null
}

/**
 * The later beat this event already does for a row at `state`, when it does
 * not do the current one: the agent posted its reply in the task while the
 * person was still reading its subtasks, a routine wrote its note while the
 * person was on an earlier step. Only a pending do beat whose binding is
 * scoped to this run (`bindingScopedToRun`) is looked at; the first that
 * matches wins. Recorded in the row's beat states without moving the person,
 * so reaching that beat shows it done (`beatArrived`: read it, then Next)
 * instead of waiting for an event that already happened.
 */
export async function beatDoneAhead(
  orgId: string,
  beats: readonly EffectiveBeat[],
  state: RowState,
  event: AppEvent,
  ownerUserId: string,
): Promise<{ beat: EffectiveBeat; held: boolean } | null> {
  if (state.status !== "active") return null
  for (const beat of beats.slice(currentIndex(beats, state) + 1)) {
    if (beat.kind !== "do" || !beat.event || state.beatStates[beat.id] !== undefined) continue
    if (!bindingScopedToRun(beat.event)) continue
    const done = await eventCompletes(orgId, beat, state, event, ownerUserId)
    if (done) return { beat, ...done }
  }
  return null
}

/** `state` with `beat` recorded done ahead by an event on `entityId` (`beatDoneAhead`). */
export function recordAhead(
  state: TourState,
  beat: EffectiveBeat,
  entityId: string | undefined,
  held: boolean,
): TourState {
  const beatStates = { ...state.beatStates }
  beatStates[beat.id] = entityId
    ? held
      ? { state: "done", entityId, held: true }
      : { state: "done", entityId }
    : "done"
  // An approve step done ahead records what the approved write made on the
  // step that held it, as `completeDoBeat` does on the spot.
  if (beat.whenHeld && entityId) beatStates[beat.whenHeld] = { state: "done", entityId }
  return { status: state.status, beatId: state.beatId, beatIndex: state.beatIndex, beatStates }
}

/**
 * The beat this event completes for a row at `state`, or null. `held`: it
 * completed on the approval its write parked as (`heldAs`), not the write.
 */
async function beatCompletedBy(
  orgId: string,
  beats: readonly EffectiveBeat[],
  state: RowState,
  event: AppEvent,
  ownerUserId: string,
): Promise<{ beat: EffectiveBeat; held: boolean } | null> {
  const beat = beats[currentIndex(beats, state)]
  if (!beat) return null
  const done = await eventCompletes(orgId, beat, state, event, ownerUserId)
  return done ? { beat, ...done } : null
}

/** How long a step's look for an event it missed waits before looking again. */
const RECONCILE_THROTTLE_SECONDS = 15

/**
 * The current step's event may have happened while nothing was there to see
 * it complete the step (a deploy restarting the consumer mid-delivery, an
 * event recorded before a beat was looked ahead for): the events of the last
 * hour the outbox still keeps (`pending_events`, kept an hour after
 * processing) are matched against the step, as the consumer would have, and
 * the first that completes it does so, under the same consumer mark (so the
 * live delivery and this never both move the person). Only a do step whose
 * binding is scoped to its run is looked for, at most once per throttle
 * window. Returns the progress as it now stands.
 * `turnsEnded`: the conversation's last agent turn just ended, and the step
 * waits on that (`TourEventBinding.turnsEnded`): looked for at once, events
 * still in delivery included (the live delivery may have looked while that
 * turn still ran; the consumer mark keeps the two from both moving the person).
 */
export async function reconcileCurrentBeat(
  ctx: { orgId: string; userId: string; tour: Tour; beats: readonly EffectiveBeat[] },
  progress: TourProgress,
  opts: { turnsEnded?: boolean } = {},
): Promise<TourProgress> {
  const { orgId, userId, tour, beats } = ctx
  try {
    if (progress.status !== "active" || progress.beatId === null) return progress
    // A whenRaised step whose routine finished without raising its request
    // (the run ended while nothing was there to see it) is passed first.
    const current = beats.find((b) => b.id === progress.beatId)
    if (current?.whenRaised && progress.beatStates[current.id] === undefined) {
      const row = await withPrivilegedDb(orgId, "tour-progress-pass-read", (tx) =>
        readProgressRow(tx, { orgId, userId, tourId: tour.id }),
      )
      if (row?.status === "active" && row.beatId === current.id) {
        const next = await passUnraisedBeats(beats, row, (b, states) =>
          routineRaisedNothingFor(orgId, b, states, row.startedAt),
        )
        if (next !== row) {
          const written = await withPrivilegedDb(orgId, "tour-progress-pass", (tx) =>
            writeTourMove(tx, {
              orgId,
              userId,
              tour,
              beats,
              from: row,
              next,
              actor: { userId, actorType: "system" },
            }),
          )
          return written ?? progress
        }
      }
    }
    const beat = beats.find((b) => b.id === progress.beatId)
    if (beat?.kind !== "do" || !beat.event || !bindingScopedToRun(beat.event)) {
      return progress
    }
    if (progress.beatStates[beat.id] !== undefined) return progress
    const settling = opts.turnsEnded === true && beat.event.turnsEnded === true
    if (!settling) {
      const gate = await redis.set(
        `tour:reconcile:${orgId}:${userId}:${tour.id}:${beat.id}`,
        "1",
        "EX",
        RECONCILE_THROTTLE_SECONDS,
        "NX",
      )
      if (gate !== "OK") return progress
    }
    const keys = [
      { app: beat.event.app, entity: beat.event.entity, action: beat.event.action },
      ...(heldTools(beat.event).length > 0
        ? [{ app: "kernel", entity: "approval_request", action: "create" }]
        : []),
    ]
    const since = new Date(progress.startedAt)
    const rows = await withPrivilegedDb(orgId, "tour-progress-reconcile", (tx) =>
      tx
        .select({ id: pendingEvents.id, payload: pendingEvents.payload })
        .from(pendingEvents)
        .where(
          and(
            eq(pendingEvents.orgId, orgId),
            gte(pendingEvents.createdAt, since),
            settling ? undefined : isNotNull(pendingEvents.processedAt),
            or(
              ...keys.map(
                (k) => sql`(${pendingEvents.payload}->>'app' = ${k.app}
                  AND ${pendingEvents.payload}->>'entity' = ${k.entity}
                  AND ${pendingEvents.payload}->>'action' = ${k.action})`,
              ),
            ),
          ),
        )
        .orderBy(asc(pendingEvents.seq))
        .limit(200),
    )
    for (const r of rows) {
      const event = r.payload as AppEvent
      const fresh = await withPrivilegedDb(orgId, "tour-progress-reconcile-read", (tx) =>
        readProgressRow(tx, { orgId, userId, tourId: tour.id }),
      )
      if (fresh?.status !== "active" || fresh.beatId !== beat.id) return progress
      const completed = await beatCompletedBy(orgId, beats, fresh, event, userId)
      if (!completed) continue
      const move = completeDoBeat(beats, fresh, event.entityId, { held: completed.held })
      if (!move) return progress
      if (move.target?.kind === "world") await assertWorldBeatAllowed(orgId)
      const written = await withPrivilegedDb(
        orgId,
        "tour-progress-reconcile-advance",
        async (tx) => {
          const [mark] = await tx
            .insert(durableConsumerMarks)
            .values({ consumer: TOUR_PROGRESS_CONSUMER, eventId: `${r.id}:${userId}:${tour.id}` })
            .onConflictDoNothing()
            .returning({ eventId: durableConsumerMarks.eventId })
          if (!mark) return null
          return writeTourMove(tx, {
            orgId,
            userId,
            tour,
            beats,
            from: fresh,
            next: move.next,
            actor: { userId, actorType: "system" },
          })
        },
      )
      return written ?? progress
    }
    return progress
  } catch (err) {
    log.warn({ err, tourId: tour.id }, "Could not look for a tour step's missed event")
    return progress
  }
}

/**
 * Could this event's actor own a tour at all? Only a person's own action or an
 * agent turn they asked for completes a beat (`actorSatisfies`), and a tour
 * belongs to a user, keyed by their uuid. A system or MCP actor is neither: its
 * id can be a label (`system:mail:gmail-incremental-sync`), which the progress
 * read would reject as an invalid uuid on every sync event.
 */
export function eventMayOwnTour(event: Pick<AppEvent, "actorId" | "actorType">): boolean {
  if (event.actorType !== "user" && event.actorType !== "agent") return false
  return typeof event.actorId === "string" && UUID_RE.test(event.actorId)
}

/** Some tour binds this `app:entity:action` to a beat any actor may complete. */
function boundToAnyActor(key: string): boolean {
  return toursBoundTo(key).some((tour) =>
    tour.beats.some(
      (b) =>
        b.kind === "do" &&
        b.event?.actor === "any" &&
        eventKey(b.event.app, b.event.entity, b.event.action) === key,
    ),
  )
}

export async function handleTourProgressEvent(ctx: DurableEventContext): Promise<void> {
  const event = ctx.event
  try {
    if (!event.orgId) return
    if (event.app === "kernel" && event.entity === "tour") return
    // An approval was raised or decided: a step whose agent turn parked a call
    // for approval (or whose approval went through) re-reads its status.
    if (
      event.app === "kernel" &&
      event.entity === "approval_request" &&
      (event.action === "create" || event.action === "update")
    ) {
      await nudgeActiveTours(event.orgId).catch((err) =>
        log.warn({ err, eventId: ctx.eventId }, "Could not nudge tour runs on an approval"),
      )
    }
    // A routine run finished: the tour steps waiting on it re-read their status.
    if (event.app === "kernel" && event.entity === "routine" && event.action === "run_completed") {
      const data = (event.data ?? {}) as { routineId?: unknown; eventEntityId?: unknown }
      const routineId = typeof data.routineId === "string" ? data.routineId : event.entityId
      if (routineId) {
        await noteRoutineRunEnded({
          orgId: event.orgId,
          routineId,
          eventEntityId: typeof data.eventEntityId === "string" ? data.eventEntityId : null,
        })
      }
    }
    const key = eventKey(event.app, event.entity, event.action)
    const tours = toursBoundTo(key)
    if (tours.length === 0) return
    // A beat any actor may complete (a routine's note on this run's ticket)
    // belongs to whoever runs the tour, not to the event's actor: every active
    // row of the org is read, and the binding's match keeps each to its run.
    const anyActor = boundToAnyActor(key)
    if (!anyActor && !eventMayOwnTour(event)) return
    const actorId = event.actorId
    const orgId = event.orgId
    const rows = await withPrivilegedDb(orgId, "tour-progress-read", (tx) =>
      tx
        .select()
        .from(tourProgress)
        .where(
          and(
            eq(tourProgress.orgId, orgId),
            anyActor || !actorId ? undefined : eq(tourProgress.userId, actorId),
            eq(tourProgress.status, "active"),
            inArray(
              tourProgress.tourId,
              tours.map((t) => t.id),
            ),
          ),
        ),
    )
    if (rows.length === 0) return
    const orgCtx = await loadTourOrgContext(orgId)
    for (const row of rows) {
      const tour = tours.find((t) => t.id === row.tourId)
      if (!tour) continue
      const ownerUserId = row.userId
      const beats = tourBeats(tour, orgCtx)
      let move: ReturnType<typeof completeDoBeat> = null
      const completed = await beatCompletedBy(orgId, beats, row, event, ownerUserId)
      if (completed) {
        move = completeDoBeat(beats, row, event.entityId, { held: completed.held })
      } else {
        const ahead = await beatDoneAhead(orgId, beats, row, event, ownerUserId)
        if (ahead) {
          move = {
            ok: true,
            next: recordAhead(row, ahead.beat, event.entityId, ahead.held),
            target: null,
          }
        }
      }
      // A whenRaised step the person is on (or this move lands on) whose
      // routine finished without raising its request is passed: the routine's
      // run_completed is often what settles it.
      const base: TourState = move ? move.next : row
      const passed = await passUnraisedBeats(beats, base, (beat, states) =>
        routineRaisedNothingFor(orgId, beat, states, row.startedAt),
      )
      if (passed !== base) {
        move = { ok: true, next: passed, target: beats[currentIndex(beats, passed)] ?? null }
      }
      if (!move) continue
      // Landing on a world beat (a live event injected into the org) is for a
      // demo org only, whichever path moves the person there.
      if (move.target?.kind === "world") {
        try {
          await assertWorldBeatAllowed(orgId)
        } catch (err) {
          log.warn({ err, eventId: ctx.eventId, tourId: tour.id }, "Tour world beat refused")
          continue
        }
      }
      await withPrivilegedDb(orgId, "tour-progress-advance", async (tx) => {
        const [mark] = await tx
          .insert(durableConsumerMarks)
          .values({
            consumer: TOUR_PROGRESS_CONSUMER,
            eventId: `${ctx.eventId}:${ownerUserId}:${tour.id}`,
          })
          .onConflictDoNothing()
          .returning({ eventId: durableConsumerMarks.eventId })
        if (!mark) return // this event already advanced this tour (a redelivery)
        await writeTourMove(tx, {
          orgId,
          userId: ownerUserId,
          tour,
          beats,
          from: row,
          next: move.next,
          actor: { userId: ownerUserId, actorType: "system" },
        })
      })
    }
  } catch (err) {
    // Never rethrow: a failure here costs a tour step, never the outbox row's
    // other consumers (the fanout consumer's rule).
    log.error(
      { err, eventId: ctx.eventId, app: event.app, entity: event.entity, action: event.action },
      "Tour progress consumer failed",
    )
  }
}

/** The tours with a do beat that waits for the turns in its conversation to end. */
let turnsEndedTours: Tour[] | null = null

function toursWaitingOnTurns(): Tour[] {
  turnsEndedTours ??= serverTourCatalogue().filter((tour) =>
    tour.beats.some((b) => b.kind === "do" && b.event?.turnsEnded === true),
  )
  return turnsEndedTours
}

/**
 * An agent turn ended in `threadId`: once none runs there any more, each
 * active run of the org standing on a step that waits for that
 * (`TourEventBinding.turnsEnded`) looks for its event again, at once. The
 * event came while a turn still ran (an agent the replier asked was still
 * answering) and was let through then. Never throws.
 */
export async function settleTurnsEndedBeats(orgId: string, threadId: string): Promise<void> {
  try {
    const tours = toursWaitingOnTurns()
    if (tours.length === 0 || !UUID_RE.test(orgId)) return
    // A read Redis does not answer settles nothing now (the catch below).
    if (await anyLiveTurn(orgId, threadId)) return
    const rows = await withPrivilegedDb(orgId, "tour-progress-turns-ended", (tx) =>
      tx
        .select()
        .from(tourProgress)
        .where(
          and(
            eq(tourProgress.orgId, orgId),
            eq(tourProgress.status, "active"),
            inArray(
              tourProgress.tourId,
              tours.map((t) => t.id),
            ),
          ),
        ),
    )
    if (rows.length === 0) return
    const orgCtx = await loadTourOrgContext(orgId)
    for (const row of rows) {
      const tour = tours.find((t) => t.id === row.tourId)
      if (!tour) continue
      const beats = tourBeats(tour, orgCtx)
      const beat = beats.find((b) => b.id === row.beatId)
      if (beat?.kind !== "do" || beat.event?.turnsEnded !== true) continue
      if (row.beatStates[beat.id] !== undefined) continue
      await reconcileCurrentBeat(
        { orgId, userId: row.userId, tour, beats },
        progressOf(tour, row, beats),
        { turnsEnded: true },
      )
    }
  } catch (err) {
    log.warn({ err, threadId }, "Could not settle tour steps waiting on a conversation's turns")
  }
}

let turnsEndedRegistered = false

export function registerTourProgressConsumer(): void {
  registerDurableEventConsumer(TOUR_PROGRESS_CONSUMER, handleTourProgressEvent)
  registerTourAgentTurnNudges()
  if (turnsEndedRegistered) return
  turnsEndedRegistered = true
  onLiveAgentTurnChange((change) => {
    if (change.running) return
    void settleTurnsEndedBeats(change.orgId, change.threadId)
  })
}
