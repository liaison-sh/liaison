// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The ONE place a tour step's status is computed (`TourBeatStatus`,
 * packages/shared/src/tours/api.ts): from the run's beat states, the routine
 * runs on what the run brought in, and the agent turns the server is running.
 * The tour card renders it and infers nothing from live frames.
 *
 * Inputs and how each change reaches the card:
 *  - the run's beat states (kernel.tour_progress): every write queues a
 *    `kernel:tour` frame (service.ts);
 *  - a routine run under way: recorded here when it starts (`noteRoutineRunStarted`,
 *    a short-lived Redis entry by the event's entity) and cleared when its
 *    `run_completed` lands (`noteRoutineRunEnded`); a finished run is its
 *    kernel.routine_runs row. Both nudge the org's active runs;
 *  - an agent turn: the stream registry (runtime/stream-registry.ts), whose
 *    start and end nudge the requester's active runs;
 *  - how the turn answering the step's question ended (`askOutcome`): the
 *    agent's answer row, or what a turn that ended without one leaves behind
 *    (its refusal line, its `agent.turn.failed` audit row, which nudges the
 *    requester's runs once written, its failed `agent_turns` row).
 * A nudge is an ephemeral `kernel:tour` frame (the card re-reads progress);
 * a lost one is covered by the re-read on reconnect and on focus.
 */
import {
  beatArrived,
  beatWaitsOn,
  createdEntityIds,
  type EffectiveBeat,
  heldTools,
  matchEntityRef,
  RUN_CONVERSATION,
  routeEntityRefs,
  TOUR_WS_ENTITY,
  type TourBeatStatus,
  type TourFrameData,
  type TourProgress,
  waitsOnAgentTurn,
} from "@liaison/shared"
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import {
  agentTurns,
  approvalRequests,
  auditLog,
  messages,
  routineRuns,
  routines,
  tourProgress,
} from "~/db/schema/kernel"
import type { RoutineRunPauseState } from "~/db/schema/kernel/routine-runs"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { UUID_RE } from "~/lib/uuid"
import {
  type LiveAgentTurnMeta,
  listLiveAgentTurns,
  onLiveAgentTurnChange,
} from "~/modules/agent/runtime/stream-registry"
import { AGENT_TURN_FAILED } from "~/modules/threads/agent-dispatch-guard"

const log = rootLogger.child({ module: "tour-beat-status" })

/** A run this long without its end is not running any more (a crash, a lost end). */
export const ROUTINE_RUNNING_TTL_SECONDS = 30 * 60

const runningKey = (orgId: string, entityId: string) => `tour:routine-running:${orgId}:${entityId}`

interface RunningEntry {
  routineId: string
  routineName: string | null
  startedAt: string
}

/**
 * A routine run started on `eventEntityId` (the event's entity: the ticket a
 * new-ticket routine reads). Recorded under the entity and under the routine
 * itself (a step may wait on a routine it switched on), then the org's active
 * tour runs are told. Never throws.
 */
export async function noteRoutineRunStarted(input: {
  orgId: string
  routineId: string
  routineName: string | null
  eventEntityId: string | null
  startedAt: string
}): Promise<void> {
  try {
    const entry: RunningEntry = {
      routineId: input.routineId,
      routineName: input.routineName,
      startedAt: input.startedAt,
    }
    const keys = [input.routineId, ...(input.eventEntityId ? [input.eventEntityId] : [])]
    for (const id of keys) {
      const key = runningKey(input.orgId, id)
      await redis.hset(key, input.routineId, JSON.stringify(entry))
      await redis.expire(key, ROUTINE_RUNNING_TTL_SECONDS)
    }
    await nudgeActiveTours(input.orgId)
  } catch (err) {
    log.warn({ err, routineId: input.routineId }, "Could not record a routine run start for tours")
  }
}

/** The run's `run_completed` landed: it no longer runs. Never throws. */
export async function noteRoutineRunEnded(input: {
  orgId: string
  routineId: string
  eventEntityId: string | null
}): Promise<void> {
  try {
    const keys = [input.routineId, ...(input.eventEntityId ? [input.eventEntityId] : [])]
    for (const id of keys) await redis.hdel(runningKey(input.orgId, id), input.routineId)
    await nudgeActiveTours(input.orgId)
  } catch (err) {
    log.warn({ err, routineId: input.routineId }, "Could not record a routine run end for tours")
  }
}

/**
 * Tell the owners of active tour runs (the org's, or one user's) that their
 * step's status may have changed: an ephemeral `kernel:tour` frame each, on
 * which the card re-reads its progress.
 */
export async function nudgeActiveTours(orgId: string, userId?: string): Promise<void> {
  if (!UUID_RE.test(orgId) || (userId !== undefined && !UUID_RE.test(userId))) return
  const rows = await withPrivilegedDb(orgId, "tour-status-nudge", (tx) =>
    tx
      .select({
        userId: tourProgress.userId,
        tourId: tourProgress.tourId,
        status: tourProgress.status,
        beatId: tourProgress.beatId,
        beatIndex: tourProgress.beatIndex,
      })
      .from(tourProgress)
      .where(
        and(
          eq(tourProgress.orgId, orgId),
          eq(tourProgress.status, "active"),
          userId ? eq(tourProgress.userId, userId) : undefined,
        ),
      ),
  )
  for (const row of rows) {
    const data: TourFrameData = {
      ownerUserId: row.userId,
      tourId: row.tourId,
      status: row.status,
      beatId: row.beatId,
      beatIndex: row.beatIndex,
      emittedAt: new Date().toISOString(),
    }
    await broadcastEphemeral({
      app: "kernel",
      entity: TOUR_WS_ENTITY,
      action: "update",
      entityId: `${row.userId}:${row.tourId}`,
      data,
      actorId: row.userId,
      actorType: "system",
      orgId,
    })
  }
}

/** The entity refs a beat's event binding names (`{live-ticket}`). */
function entityRefs(beat: EffectiveBeat): string[] {
  const out: string[] = []
  for (const value of Object.values(beat.event?.match ?? {})) {
    if (typeof value !== "string") continue
    const ref = matchEntityRef(value)
    if (ref && !out.includes(ref)) out.push(ref)
  }
  return out
}

/** The ids a beat's event binding names from what the run recorded. */
function namedEntities(beat: EffectiveBeat, created: Record<string, string>): string[] {
  const out: string[] = []
  for (const ref of entityRefs(beat)) {
    const id = created[ref]
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * The beat whose entities say which routine run `beat` waits on: its own, or,
 * for a step naming none (a show step has no event: "the routine drafted the
 * reply"), the nearest earlier step of the tour that waits on a routine and
 * names some (`metadata.originRoutineId: {enable}`). Without it such a step
 * read `pending` all along and its card never said the routine was working.
 */
function routineSource(beat: EffectiveBeat, beats: readonly EffectiveBeat[]): EffectiveBeat {
  if (entityRefs(beat).length > 0) return beat
  const at = beats.findIndex((b) => b.id === beat.id)
  for (let i = at - 1; i >= 0; i--) {
    const earlier = beats[i] as EffectiveBeat
    if (beatWaitsOn(earlier) === "routine" && entityRefs(earlier).length > 0) return earlier
  }
  return beat
}

function routineRowStatus(
  status: string,
  routineName: string | null,
  error: string | null,
  pauseState: RoutineRunPauseState | null = null,
): TourBeatStatus {
  if (status === "succeeded" || status === "output_thread_recreated") {
    return { kind: "routine-succeeded", routineName }
  }
  if (status === "dispatched") return { kind: "routine-running", routineName, startedAt: "" }
  if (status === "waiting_approval") {
    // Its approval was decided and the run carries on (the resume claimed it:
    // `resumingAt`). A run that pauses again writes a fresh pause state
    // without it, so this is the run working now, not a stale claim.
    if (pauseState?.resumingAt) {
      return { kind: "routine-running", routineName, startedAt: pauseState.resumingAt }
    }
    // Paused on an approval it asked for: the run did its part and waits on
    // the person, nothing failed. It carries on once the approval is decided.
    return { kind: "pending" }
  }
  if (status.startsWith("skipped")) return { kind: "routine-skipped", routineName, status, error }
  return { kind: "routine-failed", routineName, error }
}

async function routineStatus(
  orgId: string,
  progress: TourProgress,
  beat: EffectiveBeat,
  beats: readonly EffectiveBeat[],
): Promise<TourBeatStatus> {
  const ids = namedEntities(routineSource(beat, beats), createdEntityIds(progress.beatStates))
  if (ids.length === 0) return { kind: "pending" }
  let running: RunningEntry | null = null
  for (const id of ids) {
    const entries = await redis.hvals(runningKey(orgId, id))
    for (const raw of entries) {
      try {
        const entry = JSON.parse(raw) as RunningEntry
        if (!running || entry.startedAt > running.startedAt) running = entry
      } catch {
        // A malformed entry says nothing.
      }
    }
  }
  const uuids = ids.filter((id) => UUID_RE.test(id))
  const since = new Date(progress.startedAt)
  const [last] = await withPrivilegedDb(orgId, "tour-status-routine", (tx) =>
    tx
      .select({
        status: routineRuns.status,
        error: routineRuns.error,
        ranAt: routineRuns.ranAt,
        startedAt: routineRuns.startedAt,
        pauseState: routineRuns.pauseState,
        routineName: routines.name,
      })
      .from(routineRuns)
      .innerJoin(routines, eq(routines.id, routineRuns.routineId))
      .where(
        and(
          eq(routineRuns.orgId, orgId),
          gte(routineRuns.ranAt, since),
          uuids.length > 0
            ? or(inArray(routineRuns.eventEntityId, ids), inArray(routineRuns.routineId, uuids))
            : inArray(routineRuns.eventEntityId, ids),
        ),
      )
      .orderBy(desc(routineRuns.ranAt))
      .limit(1),
  )
  // A run that started after the last one recorded is the one under way.
  if (running && (!last || Date.parse(running.startedAt) > last.ranAt.getTime())) {
    return {
      kind: "routine-running",
      routineName: running.routineName,
      startedAt: running.startedAt,
    }
  }
  if (!last) return { kind: "pending" }
  const view = routineRowStatus(last.status, last.routineName, last.error, last.pauseState)
  return view.kind === "routine-running" && view.startedAt === ""
    ? { ...view, startedAt: (last.startedAt ?? last.ranAt).toISOString() }
    : view
}

/**
 * The conversations the beat's agent answers in: the run's conversation with
 * the person's agent, and the one holding each request the beat names: the
 * one its event is caused by (a task's discussion, a channel), and one its
 * anchor is pinned to (`agent-answer[data-turn-id={ask-agent}]`: the answer
 * of that question's turn).
 */
async function watchedThreads(
  orgId: string,
  beat: EffectiveBeat,
  created: Record<string, string>,
): Promise<string[]> {
  const out: string[] = []
  const run = created[RUN_CONVERSATION]
  if (run) out.push(run)
  const refs = [
    ...(beat.event?.causedBy ? [beat.event.causedBy] : []),
    ...(beat.anchor ? routeEntityRefs(beat.anchor) : []),
  ]
  const asks = [...new Set(refs.map((ref) => created[ref]))].filter(
    (id): id is string => id !== undefined && UUID_RE.test(id),
  )
  if (asks.length > 0) {
    const rows = await withPrivilegedDb(orgId, "tour-status-ask-thread", (tx) =>
      tx
        .select({ threadId: messages.threadId })
        .from(messages)
        .where(and(eq(messages.orgId, orgId), inArray(messages.id, asks))),
    )
    for (const row of rows) if (!out.includes(row.threadId)) out.push(row.threadId)
  }
  return out
}

/** What the step status reads of a live turn: no content (P2-13). */
type LiveTurnFacts = Pick<LiveAgentTurnMeta, "orgId" | "requesterId" | "startedAt">

/**
 * The person's agent works while one of their turns runs in the watched
 * conversations, in any process (the registry is cell-wide). A read Redis does
 * not answer says `pending` (open: Do it for me is not held back on a guess).
 */
async function agentStatus(
  orgId: string,
  userId: string,
  threads: readonly string[],
  list: (threadId: string) => Promise<LiveTurnFacts[]> = listLiveAgentTurns,
): Promise<TourBeatStatus> {
  let lists: LiveTurnFacts[][]
  try {
    lists = await Promise.all(threads.map((threadId) => list(threadId)))
  } catch (err) {
    log.warn({ err }, "Could not read the live turns of a tour step's conversations")
    return { kind: "pending" }
  }
  let since: number | null = null
  for (const turns of lists) {
    for (const snap of turns) {
      if (snap.orgId !== orgId) continue
      // The person's own turn, or one whose requester is unknown (fail open on
      // "working": it only holds Do it for me back while the turn runs).
      if (snap.requesterId !== "" && snap.requesterId !== userId) continue
      if (since === null || snap.startedAt < since) since = snap.startedAt
    }
  }
  return since === null
    ? { kind: "pending" }
    : { kind: "agent-working", since: new Date(since).toISOString() }
}

/**
 * A tool call of the person's agent parked for approval in the conversations
 * the step watches, since the run began (since its ask, for a step caused by
 * one), still pending: whatever tool, whatever the reason (a scope mark, a
 * policy). A write the step declares may park (`heldAs`) is not one: it
 * completes the step, and its approve step (`whenHeld`) asks for it.
 */
async function parkedApproval(
  orgId: string,
  userId: string,
  progress: TourProgress,
  beat: EffectiveBeat,
  threads: readonly string[],
): Promise<TourBeatStatus | null> {
  const ids = threads.filter((id) => UUID_RE.test(id))
  if (ids.length === 0) return null
  // The step's own held write completes it (`heldAs`); its approve step asks for it.
  const declared = beat.event ? heldTools(beat.event) : []
  const rows = await withPrivilegedDb(orgId, "tour-status-approvals", (tx) =>
    tx
      .select({
        id: approvalRequests.id,
        toolName: approvalRequests.toolName,
        reason: approvalRequests.reason,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.orgId, orgId),
          eq(approvalRequests.status, "pending"),
          inArray(approvalRequests.threadId, ids),
          gte(approvalRequests.createdAt, new Date(progress.startedAt)),
          or(
            eq(approvalRequests.requestedBy, userId),
            sql`${userId}::uuid = ANY(${approvalRequests.notifyUserIds})`,
          ),
        ),
      )
      .orderBy(asc(approvalRequests.createdAt)),
  )
  const parked = rows.find((r) => !declared.includes(r.toolName))
  return parked
    ? {
        kind: "held-for-approval",
        requestId: parked.id,
        toolName: parked.toolName,
        reason: parked.reason,
      }
    : null
}

/** How many of the person's messages, from the recorded question on, a step looks at. */
const ASK_WINDOW = 20

type AgentFailed = Extract<TourBeatStatus, { kind: "agent-failed" }>

interface AskOutcome {
  /**
   * The newest of the person's messages in the question's conversation, at or
   * after the recorded question, whose turn answered (an agent row carrying
   * its id as `askId` or `turnId`, what `agent-answer[data-turn-id]` reads).
   */
  answered: string | null
  /** None answered and the newest one's turn ended without an answer. */
  failed: AgentFailed | null
}

/**
 * How the turn answering `askId` (a message of the person's, recorded by an
 * earlier step) ended, following the person's later messages in the same
 * conversation: a person who asked again ("?", Try again) waits on that
 * message's turn. A turn that ended without an answer leaves, whichever way
 * it ended (a turn started by the person's own message included):
 *  - refused before it ran (a spend or usage gate): the refusal line, a
 *    system row stamped with the asker's id (`metadata.demoRefusal` carries a
 *    demo refusal's code), written before the refusal is thrown, and the
 *    `agent.turn.failed` audit row the dispatch writes for the thrown error;
 *  - failed while it ran (a model or tool error): the audit row too, and its
 *    `agent_turns` row ends `failed` (or `interrupted`: cut off, never resumed).
 * Each of those is read only past the newest message's own time, so a failure
 * of an earlier turn never counts. Null when `askId` is not the person's message.
 */
async function askOutcome(
  orgId: string,
  userId: string,
  askId: string,
): Promise<AskOutcome | null> {
  if (!UUID_RE.test(askId)) return null
  return withPrivilegedDb(orgId, "tour-status-ask-outcome", async (tx) => {
    const [ask] = await tx
      .select({ threadId: messages.threadId, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.id, askId),
          eq(messages.authorId, userId),
          eq(messages.authorType, "user"),
        ),
      )
      .limit(1)
    if (!ask) return null
    const asks = await tx
      .select({ id: messages.id, content: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.threadId, ask.threadId),
          eq(messages.authorId, userId),
          eq(messages.authorType, "user"),
          isNull(messages.deletedAt),
          gte(messages.createdAt, ask.createdAt),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(ASK_WINDOW)
    const newest = asks[0]
    if (!newest) return null
    const ids = asks.map((a) => a.id)
    const askedId = sql<string | null>`${messages.metadata}->>'askId'`
    const turnId = sql<string | null>`${messages.metadata}->>'turnId'`
    const answers = await tx
      .select({ askedId, turnId })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.threadId, ask.threadId),
          eq(messages.authorType, "agent"),
          isNull(messages.deletedAt),
          gte(messages.createdAt, ask.createdAt),
          or(inArray(askedId, ids), inArray(turnId, ids)),
        ),
      )
    const answeredIds = new Set(answers.flatMap((a) => [a.askedId, a.turnId]))
    const answered = asks.find((a) => answeredIds.has(a.id))?.id ?? null
    if (answered) return { answered, failed: null }

    const failed = (message: string | null, code: string | null): AskOutcome => ({
      answered: null,
      failed: {
        kind: "agent-failed",
        threadId: ask.threadId,
        askId: newest.id,
        question: newest.content,
        message: message?.trim() ? message.trim() : null,
        code,
      },
    })
    const [refusal] = await tx
      .select({
        content: messages.content,
        code: sql<string>`${messages.metadata}->>'demoRefusal'`,
      })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.threadId, ask.threadId),
          eq(messages.authorType, "system"),
          eq(messages.authorId, userId),
          gte(messages.createdAt, newest.createdAt),
          sql`${messages.metadata}->>'demoRefusal' IS NOT NULL`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1)
    if (refusal) return failed(refusal.content, refusal.code)
    const [reported] = await tx
      .select({ error: sql<string | null>`${auditLog.metadata}->>'error'` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, orgId),
          eq(auditLog.entityType, "thread"),
          eq(auditLog.entityId, ask.threadId),
          eq(auditLog.action, AGENT_TURN_FAILED),
          eq(auditLog.actorId, userId),
          gte(auditLog.timestamp, newest.createdAt),
        ),
      )
      .orderBy(desc(auditLog.timestamp))
      .limit(1)
    if (reported) return failed(reported.error, null)
    const [ended] = await tx
      .select({ errorCode: agentTurns.errorCode })
      .from(agentTurns)
      .where(
        and(
          inArray(agentTurns.state, ["failed", "interrupted"]),
          gte(agentTurns.heartbeatAt, newest.createdAt),
          eq(agentTurns.orgId, orgId),
          eq(agentTurns.threadId, ask.threadId),
          eq(agentTurns.userMessageId, newest.id),
        ),
      )
      .limit(1)
    if (ended) return failed(null, null)
    return { answered: null, failed: null }
  })
}

/**
 * The questions the step waits on the answer to: what the beats its event is
 * caused by and its anchor is pinned to recorded (`{ask-agent}`), when that is
 * a message (`askOutcome` reads nothing for anything else).
 */
function recordedQuestions(beat: EffectiveBeat, created: Record<string, string>): string[] {
  const refs = [
    ...(beat.event?.causedBy ? [beat.event.causedBy] : []),
    ...(beat.anchor ? routeEntityRefs(beat.anchor) : []),
  ]
  const out: string[] = []
  for (const ref of refs) {
    const id = ref === RUN_CONVERSATION ? undefined : created[ref]
    if (id && UUID_RE.test(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/** The turn answering one of the step's questions ended without an answer: `agent-failed`. */
async function askFailure(
  orgId: string,
  userId: string,
  beat: EffectiveBeat,
  created: Record<string, string>,
): Promise<AgentFailed | null> {
  for (const askId of recordedQuestions(beat, created)) {
    const outcome = await askOutcome(orgId, userId, askId)
    if (outcome?.failed) return outcome.failed
  }
  return null
}

/**
 * A step pointing at the answer to a recorded question
 * (`agent-answer[data-turn-id={ask-agent}]`) follows the person's newest
 * message in that conversation whose turn answered: one who asked again ("?"
 * after a refusal, Try again) reads that answer, and the anchor would never
 * match the question that got none. The recorded entity is moved to it in the
 * run's beat states (compare-and-set: a concurrent move wins); the progress
 * returned carries the new states.
 */
async function followAnsweredQuestion(
  orgId: string,
  userId: string,
  progress: TourProgress,
  beat: EffectiveBeat,
): Promise<TourProgress> {
  if (beatWaitsOn(beat) !== "agent" || !beat.anchor) return progress
  let states = progress.beatStates
  for (const ref of routeEntityRefs(beat.anchor)) {
    const state = states[ref]
    if (ref === RUN_CONVERSATION || typeof state !== "object") continue
    const outcome = await askOutcome(orgId, userId, state.entityId)
    if (outcome?.answered && outcome.answered !== state.entityId) {
      states = { ...states, [ref]: { ...state, entityId: outcome.answered } }
    }
  }
  if (states === progress.beatStates) return progress
  const [row] = await withPrivilegedDb(orgId, "tour-follow-answer", (tx) =>
    tx
      .update(tourProgress)
      .set({ beatStates: states, updatedAt: new Date() })
      .where(
        and(
          eq(tourProgress.orgId, orgId),
          eq(tourProgress.userId, userId),
          eq(tourProgress.tourId, progress.tourId),
          eq(tourProgress.status, "active"),
          eq(tourProgress.beatId, beat.id),
          sql`${tourProgress.beatStates} = ${JSON.stringify(progress.beatStates)}::jsonb`,
        ),
      )
      .returning({ beatStates: tourProgress.beatStates, updatedAt: tourProgress.updatedAt }),
  )
  return row
    ? { ...progress, beatStates: row.beatStates, updatedAt: row.updatedAt.toISOString() }
    : progress
}

/** A step that approves something: it waits on the person's press, never on a turn. */
function approvesSomething(beat: EffectiveBeat): boolean {
  return beat.event?.entity === "approval_request" && beat.event.action === "update"
}

/**
 * The status of `progress`'s current step, `beat` (`TourBeatStatus`). `beats`
 * is the tour's steps: a step waiting on a routine without naming its run
 * reads the run an earlier step names.
 */
export async function computeBeatStatus(input: {
  orgId: string
  userId: string
  progress: TourProgress
  beat: EffectiveBeat
  beats?: readonly EffectiveBeat[]
}): Promise<TourBeatStatus> {
  const { orgId, userId, progress, beat, beats = [beat] } = input
  const state = progress.beatStates[beat.id]
  if (beatArrived(beat, progress.beatStates)) {
    return { kind: "done", held: typeof state === "object" && state.held === true }
  }
  const waitsOn = beatWaitsOn(beat)
  if (waitsOn === "routine") {
    const run = await routineStatus(orgId, progress, beat, beats)
    // A step approving what the routine staged waits on the PERSON once the
    // run has done its work. Its "the routine has finished" line, with its
    // check, read as this step being done while its card still waited
    // (sales walk 2026-10-27: "the runner did not understand where we're
    // at"). Running, failed or skipped still say so: the card is not there yet.
    return approvesSomething(beat) && run.kind === "routine-succeeded" ? { kind: "pending" } : run
  }
  if (waitsOn === "agent" && !approvesSomething(beat)) {
    const threads = await watchedThreads(orgId, beat, createdEntityIds(progress.beatStates))
    const held = await parkedApproval(orgId, userId, progress, beat, threads)
    if (held) return held
    // A do step whose request starts the turn, or a show step that waits for
    // the answer (Next stays off while the agent is still answering). A turn
    // on the question that ended without an answer says so (Try again).
    if (waitsOnAgentTurn(beat) || beat.kind === "show") {
      const live = await agentStatus(orgId, userId, threads)
      if (live.kind !== "pending") return live
      return (await askFailure(orgId, userId, beat, createdEntityIds(progress.beatStates))) ?? live
    }
  }
  return { kind: "pending" }
}

/**
 * `progress` with its current step's status. A paused or finished run, or one
 * whose step no longer exists, carries none. A failed read leaves the status
 * at `pending` rather than failing the progress read.
 */
export async function withBeatStatus(
  orgId: string,
  userId: string,
  progress: TourProgress,
  beats: readonly EffectiveBeat[],
): Promise<TourProgress> {
  if (progress.status !== "active" || progress.beatId === null) return progress
  const beat = beats.find((b) => b.id === progress.beatId)
  if (!beat) return progress
  try {
    const followed = await followAnsweredQuestion(orgId, userId, progress, beat)
    return {
      ...followed,
      beatStatus: await computeBeatStatus({ orgId, userId, progress: followed, beat, beats }),
    }
  } catch (err) {
    log.warn({ err, tourId: progress.tourId }, "Could not compute a tour step's status")
    return { ...progress, beatStatus: { kind: "pending" } }
  }
}

let registered = false
/**
 * An agent turn started or ended: its requester's active tour runs re-read
 * their step (a step waiting on that turn says the agent works, then stops
 * saying so). Once per process.
 */
export function registerTourAgentTurnNudges(): void {
  if (registered) return
  registered = true
  onLiveAgentTurnChange((change) => {
    if (!change.requesterId) return
    void nudgeActiveTours(change.orgId, change.requesterId).catch((err) =>
      log.warn({ err }, "Could not nudge tour runs on an agent turn change"),
    )
  })
}

/** Test access: the agent status over a fake stream list. */
export const BeatStatusTestAccess = { agentStatus, runningKey }

/**
 * WHETHER A `whenRaised` STEP IS PASSED: the routine its event names
 * (`metadata.originRoutineId: {beat}`, the routine this run switched on) has
 * finished a run since this tour began, and that routine raised no request on
 * the step's tools in that time (decided or not: a request approved early still
 * belongs to its own step). A run still under way (no finished run row, or a
 * node run still `dispatched`) passes nothing yet: its request may still come.
 *
 * Sales walk 2026-10-27: the CRM step also completed on the reply's approval
 * (a fallback for a run that staged no record), so pressing the reply first
 * finished the CRM step, skipped the reply step, and left the CRM records to
 * nobody. The step now completes on its own request only, and a run that
 * raised none passes it.
 */
export async function routineRaisedNothingFor(
  orgId: string,
  beat: EffectiveBeat,
  beatStates: TourProgress["beatStates"],
  since: Date,
): Promise<boolean> {
  if (!beat.whenRaised || !beat.event?.match) return false
  const ref = beat.event.match["metadata.originRoutineId"]
  const beatRef = typeof ref === "string" ? matchEntityRef(ref) : null
  const routineId = beatRef ? createdEntityIds(beatStates)[beatRef] : undefined
  if (!routineId || !UUID_RE.test(routineId)) return false
  const named = beat.event.match.toolName
  const tools = typeof named === "string" ? [named] : Array.isArray(named) ? named : []
  if (tools.length === 0) return false
  return withPrivilegedDb(orgId, "tour-step-raised", async (tx) => {
    const [finished] = await tx
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.orgId, orgId),
          eq(routineRuns.routineId, routineId),
          gte(routineRuns.ranAt, since),
          sql`${routineRuns.status} <> 'dispatched'`,
        ),
      )
      .limit(1)
    if (!finished) return false
    const [raised] = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.orgId, orgId),
          inArray(approvalRequests.toolName, tools),
          gte(approvalRequests.createdAt, since),
          sql`${approvalRequests.metadata}->>'originRoutineId' = ${routineId}`,
        ),
      )
      .limit(1)
    return !raised
  })
}
