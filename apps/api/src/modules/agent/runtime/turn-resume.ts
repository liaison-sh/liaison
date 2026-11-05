// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Resuming an agent turn on another process (S10).
 *
 * A turn's record (turn-ledger.ts) says who runs it. When that process hands
 * it off (a draining process at its turn cap, `handOffTurn`) or dies (the
 * sweep finds its heartbeat stale and its instance gone), the `agent-turn-
 * resume` job claims the record (compare-and-set: one claimer wins, the old
 * runner is fenced from then on) and runs the turn again from its journaled
 * complete steps: the user's message is not posted again, the complete steps
 * are replayed exactly as the SDK produced them, the cut step is re-issued,
 * and the one reply is written by the claimer.
 *
 * The actor is re-read (M11): the resume runs with the person's CURRENT
 * permissions intersected with the turn's start ceiling, never wider. A person
 * removed or deactivated in between ends the turn `failed`, no tool run.
 */
import { clientSurfaceSchema } from "@liaison/shared"
import { and, eq, lt, or, sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { type AgentTurnRestrictions, agentTurns, routines, users } from "~/db/schema/kernel"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { INSTANCE_ID } from "~/infra/instance-id"
import { isInstanceLive } from "~/infra/instance-registry"
import { enqueueAppJobForServer } from "~/infra/jobs/jobs"
import { rootLogger } from "~/lib/logger"
import { invokeAgentForThread, TurnResumeRefused } from "~/modules/agent/runtime/agent-service"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import type { RunTokenAccount } from "~/modules/agent/runtime/run-token-limit"
import { liveTurnKey, takeOverLiveTurn } from "~/modules/agent/runtime/stream-registry"
import { isDurableTurnRunningHere } from "~/modules/agent/runtime/turn-handoff"
import { parseJournal } from "~/modules/agent/runtime/turn-journal"
import {
  claimForResume,
  expireStaleTurns,
  finishTurn,
  handoff,
  loadTurn,
  pruneTerminalTurns,
  TURN_MAX_AGE_MS,
  TURN_STALE_AFTER_MS,
} from "~/modules/agent/runtime/turn-ledger"
import { intersectScopes } from "~/modules/agent/subruns/spawn-agent"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"

const log = rootLogger.child({ module: "turn-resume" })

export const TURN_RESUME_JOB = "agent-turn-resume"

/** A handed-off turn with no resume after this long is re-enqueued by the sweep. */
export const HANDOFF_REQUEUE_AFTER_MS = 15_000

/**
 * Enqueue the resume of `turnId` (one job per attempt: BullMQ dedups the id),
 * after `delayMs` when given (a provider failure's backoff).
 */
export async function enqueueTurnResume(
  orgId: string,
  turnId: string,
  attempt: number,
  delayMs?: number,
): Promise<void> {
  await enqueueAppJobForServer(
    "kernel",
    TURN_RESUME_JOB,
    { orgId, turnId },
    {
      jobId: `resume:${turnId}:${attempt}`,
      ...(delayMs ? { delay: delayMs } : {}),
    },
  )
}

/**
 * Hand a turn this process runs off at a step boundary (finalize of a turn a
 * drain asked to stop, or one whose provider stopped answering mid-step): the
 * record goes `handoff` and its resume is queued, after `delayMs` when given.
 */
export async function handOffTurn(
  orgId: string,
  turnId: string,
  opts: { delayMs?: number } = {},
): Promise<void> {
  const outcome = await handoff(orgId, turnId, INSTANCE_ID)
  if (outcome === "fenced") {
    log.warn({ turnId }, "turn_handoff_fenced")
    return
  }
  const loaded = await loadTurn(orgId, turnId)
  log.info({ turnId, steps: loaded?.turn.stepCount ?? null }, "turn_handed_off")
  try {
    await enqueueTurnResume(orgId, turnId, loaded?.turn.attempt ?? 0, opts.delayMs)
  } catch (err) {
    // The sweep re-enqueues a handed-off turn that has no resume.
    log.error({ err, turnId }, "turn_resume_enqueue_failed")
  }
}

export type ResumeOutcome = "resumed" | "not_claimable" | "gone" | "failed"

const USER_FACING_RESUME_ERROR =
  "This answer was interrupted and could not be resumed. Please ask again."

/**
 * End a turn that cannot resume `failed`, and, when the person can still read
 * the conversation, say so in it (under their own RLS, as a system line).
 */
async function failTurn(
  orgId: string,
  turnId: string,
  threadId: string,
  userId: string,
  errorCode: string,
  perms?: { scopes: string[]; dimensionGrants: Record<string, string[]> },
): Promise<void> {
  // Its process stopped or died, and the turn could not be carried on.
  const ended = await finishTurn({
    orgId,
    turnId,
    runner: INSTANCE_ID,
    state: "failed",
    failureReason: "process",
    errorCode,
  })
  if (ended === "fenced" || !perms || !userId) return
  await withRlsContext(
    {
      actorType: "user",
      userId,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    (tx) =>
      sendMessage(tx, {
        requiredScopes: [],
        orgId,
        userId,
        threadId,
        content: USER_FACING_RESUME_ERROR,
        authorType: "system",
        // The turn ends here, failed: the person who started it is told.
        endsTurn: true,
      }),
  )
}

/**
 * The dimension grants a resume runs with: the person's current ones, never
 * wider than the ones the turn started with (H1). Per dimension the values
 * both sides hold; a `*` value on one side stands for the other side's
 * values, and the `*` dimension stands for any dimension the other side
 * names. Narrowing is the only failure mode: an app's own implied values
 * (a sensitivity ladder) are not expanded here, so a mismatch reads less.
 */
export function intersectDimensionGrants(
  current: Record<string, string[]>,
  started: Record<string, string[]>,
): Record<string, string[]> {
  const isAll = (g: Record<string, string[]>) => g["*"]?.includes("*") === true
  if (isAll(started)) return current
  if (isAll(current)) return started
  const out: Record<string, string[]> = {}
  for (const key of new Set([...Object.keys(current), ...Object.keys(started)])) {
    const a = current[key] ?? (key === "*" ? undefined : current["*"])
    const b = started[key] ?? (key === "*" ? undefined : started["*"])
    if (!a || !b) continue
    const values = a.includes("*") ? b : b.includes("*") ? a : a.filter((v) => b.includes(v))
    if (values.length > 0) out[key] = [...values]
  }
  return out
}

/**
 * Claim and run a handed-off or orphaned turn here. Returns what happened;
 * throws only for an infrastructure failure (the job retries).
 */
export async function resumeTurn(orgId: string, turnId: string): Promise<ResumeOutcome> {
  const loaded = await loadTurn(orgId, turnId)
  if (!loaded) return "gone"
  const { turn } = loaded
  if (turn.state !== "running" && turn.state !== "handoff") return "gone"
  if (Date.now() - turn.createdAt.getTime() > TURN_MAX_AGE_MS) {
    // Past any budget: it would answer an old message (M2).
    await expireStaleTurns()
    return "gone"
  }
  if (turn.state === "running") {
    // A running turn is taken only from a runner that is gone. This process
    // is not gone while the turn is still registered here (M3: a job re-run
    // on the same process meets a turn that still runs).
    if (turn.runnerInstanceId === INSTANCE_ID) {
      if (isDurableTurnRunningHere(turnId)) return "not_claimable"
    } else if (await isInstanceLive(turn.runnerInstanceId).catch(() => true)) {
      return "not_claimable"
    }
  }
  const previousRunner = turn.runnerInstanceId
  const claimed = await claimForResume({ orgId, turnId, expectedAttempt: turn.attempt })
  if (!claimed) return "not_claimable"
  const input = claimed.resumeInput
  if (input.resumable === false) {
    // Its caller held the reply (Share anyway) and is gone with its process:
    // nothing can post the answer the way it would have (H1).
    log.info({ turnId }, "turn_not_resumable")
    await finishTurn({
      orgId,
      turnId,
      runner: INSTANCE_ID,
      state: "interrupted",
      failureReason: "process",
      errorCode: "not_resumable",
    })
    return "gone"
  }
  // The steps as they stood at the claim (the old runner is fenced from now on).
  const fresh = await loadTurn(orgId, turnId)
  if (!fresh) return "gone"
  const steps = parseJournal(fresh.steps)
  const actorInput = (input.actor ?? {}) as {
    userId?: string
    scopes?: string[]
  }
  const restrictions: AgentTurnRestrictions = input.restrictions ?? {}
  const userId = actorInput.userId
  log.info(
    { turnId, attempt: claimed.attempt, steps: steps.length, previousRunner },
    "turn_resume_claimed",
  )
  if (!userId || !claimed.userMessageId) {
    await failTurn(orgId, turnId, claimed.threadId, userId ?? "", "resume_input_missing")
    return "failed"
  }
  // M11: the person as they are NOW, never wider than the turn's start. A
  // routine switched off in between does not run on (M6).
  const current = await withPrivilegedDb(orgId, "turn-resume:actor", async (tx) => {
    const [row] = await tx
      .select({ status: users.status })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
      .limit(1)
    if (row?.status !== "active") return { inactive: "actor_inactive" as const, perms: null }
    if (input.routineId) {
      const [routine] = await tx
        .select({ enabled: routines.enabled, status: routines.status })
        .from(routines)
        .where(and(eq(routines.id, input.routineId), eq(routines.orgId, orgId)))
        .limit(1)
      if (!routine?.enabled || routine.status !== "active") {
        return { inactive: "routine_disabled" as const, perms: null }
      }
    }
    return { inactive: null, perms: await loadEffectivePermissions(tx, userId, orgId) }
  })
  const perms = current.perms
  if (!perms) {
    const reason = current.inactive ?? "actor_inactive"
    log.warn({ turnId, userId, reason }, "turn_resume_refused")
    await failTurn(orgId, turnId, claimed.threadId, userId, reason)
    return "failed"
  }
  const ceiling = actorInput.scopes ?? []
  const scopes = intersectScopes(perms.scopes, ceiling)
  const dimensionGrants = restrictions.dimensionGrants
    ? intersectDimensionGrants(perms.dimensionGrants, restrictions.dimensionGrants)
    : perms.dimensionGrants
  const liveAgentId = input.actingAgentId ?? claimed.agentId ?? null
  const takeover = await takeOverLiveTurn({
    threadId: claimed.threadId,
    orgId,
    agentId: liveAgentId,
    turnId: input.liveTurnKey ?? null,
    fromInstance: previousRunner,
    steps: steps.length,
  }).catch((err: unknown) => {
    log.warn({ err, turnId }, "turn_live_takeover_failed")
    return null
  })
  if (takeover) {
    // The scopes a chunk of this turn is gated on: the last complete step's,
    // else what the turn started with; never an assumed [] (L4).
    const accumulatedScopes = steps[steps.length - 1]?.prep.scopes ?? input.startScopes
    // Live clients drop what they hold past the last complete step: the
    // resume re-issues the cut step, so its text would show twice (M1).
    await broadcastEphemeral({
      app: "kernel",
      entity: "agent_stream",
      action: "resume",
      entityId: claimed.threadId,
      orgId,
      actorId: userId,
      actorType: "agent",
      data: {
        threadId: claimed.threadId,
        agentId: liveAgentId,
        ...(input.liveTurnKey ? { turnId: input.liveTurnKey } : {}),
        seq: takeover.seq,
        rewindToSeq: takeover.rewindToSeq,
        ...(accumulatedScopes ? { accumulatedScopes } : {}),
      },
    }).catch((err: unknown) => log.warn({ err, turnId }, "turn_resume_frame_failed"))
  }
  const coordination = restrictions.coordination
  const surface = clientSurfaceSchema.safeParse(input.clientSurface)
  const run = () =>
    invokeAgentForThread(
      claimed.threadId,
      claimed.userMessageId ?? "",
      {
        userId,
        orgId,
        roles: perms.roles,
        scopes,
        dimensionGrants,
      },
      orgId,
      input.background ?? true,
      input.maxSteps ? { maxSteps: input.maxSteps } : undefined,
      input.routineId ?? undefined,
      undefined,
      restrictions.anchorHistory,
      input.actingAgentId ?? undefined,
      coordination
        ? {
            callerAgentId: coordination.callerAgentId,
            parentMessageId: coordination.parentMessageId,
            ...(coordination.delegatedScope ? { delegatedScope: coordination.delegatedScope } : {}),
            ...(coordination.callerTaintScopes
              ? { callerTaintScopes: coordination.callerTaintScopes }
              : {}),
            ...(coordination.askedQuestion ? { askedQuestion: coordination.askedQuestion } : {}),
          }
        : undefined,
      {
        resume: { turn: claimed, steps },
        ...(restrictions.sessionRestricted ? { sessionRestricted: true } : {}),
        ...(restrictions.agentDispatched ? { agentDispatched: true } : {}),
        ...(restrictions.askId ? { askId: restrictions.askId } : {}),
        ...(restrictions.currentView ? { currentView: restrictions.currentView } : {}),
        ...(restrictions.replyRootId !== undefined
          ? { replyRootId: restrictions.replyRootId }
          : {}),
        ...(surface.success ? { clientSurface: surface.data } : {}),
      },
    )
  // A routine tick's turn counts on the run's own token account (S17), so
  // its hard limit holds across the resume: the account is the run's shared
  // counter, read back by id at the first step.
  const account: RunTokenAccount | undefined = restrictions.tokenAccount
    ? { ...restrictions.tokenAccount, used: 0 }
    : undefined
  const framed = () =>
    restrictions.routineRunId || account
      ? runContextStore.run(
          {
            runId: claimed.runId ?? turnId,
            parentRunId: null,
            rootRunId: claimed.runId ?? turnId,
            nestingDepth: 0,
            background: input.background ?? true,
            ...(input.routineId ? { routineId: input.routineId } : {}),
            ...(restrictions.routineRunId ? { routineRunId: restrictions.routineRunId } : {}),
            ...(account ? { tokenAccount: account } : {}),
          },
          run,
        )
      : run()
  try {
    await framed()
  } catch (err) {
    const code = err instanceof TurnResumeRefused ? err.code : "resume_failed"
    log.error({ err, turnId, code }, "turn_resume_failed")
    await failTurn(orgId, turnId, claimed.threadId, userId, code, {
      scopes,
      dimensionGrants,
    }).catch((failErr: unknown) =>
      log.error({ err: failErr, turnId }, "turn_resume_fail_write_failed"),
    )
    return "failed"
  }
  return "resumed"
}

/**
 * The resume sweep (a singleton, every 10 s): running turns whose runner is
 * gone and whose heartbeat is stale, and handed-off turns no resume picked
 * up. Each gets a resume job; the job's claim makes two sweepers harmless.
 */
export async function sweepOrphanTurns(): Promise<number> {
  // Turns past their maximum age end `interrupted` and are never resumed (M2).
  await expireStaleTurns().catch((err: unknown) => log.warn({ err }, "turn_expire_failed"))
  const staleS = TURN_STALE_AFTER_MS / 1000
  const handoffS = HANDOFF_REQUEUE_AFTER_MS / 1000
  const candidates = await withSystemDb("turn-resume:sweep", (tx) =>
    tx
      .select({
        id: agentTurns.id,
        orgId: agentTurns.orgId,
        state: agentTurns.state,
        runner: agentTurns.runnerInstanceId,
        attempt: agentTurns.attempt,
      })
      .from(agentTurns)
      .where(
        or(
          and(
            eq(agentTurns.state, "running"),
            lt(agentTurns.heartbeatAt, sql`now() - make_interval(secs => ${staleS})`),
          ),
          and(
            eq(agentTurns.state, "handoff"),
            lt(agentTurns.updatedAt, sql`now() - make_interval(secs => ${handoffS})`),
          ),
        ),
      )
      .limit(100),
  )
  let queued = 0
  for (const turn of candidates) {
    if (turn.state === "running" && (await isInstanceLive(turn.runner).catch(() => true))) continue
    await enqueueTurnResume(turn.orgId, turn.id, turn.attempt)
      .then(() => {
        queued++
      })
      .catch((err: unknown) => log.warn({ err, turnId: turn.id }, "turn_sweep_enqueue_failed"))
  }
  if (queued > 0) log.info({ queued }, "turn_resume_sweep")
  return queued
}

/**
 * The live keys of `deadId`'s turns a resume will continue (stream-registry
 * `setDurableLiveTurnKeys`): records still running or handed off there.
 */
export async function durableLiveTurnKeysOf(deadId: string): Promise<string[]> {
  const rows = await withSystemDb("turn-resume:live-keys", (tx) =>
    tx
      .select({
        threadId: agentTurns.threadId,
        agentId: agentTurns.agentId,
        resumeInput: agentTurns.resumeInput,
      })
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.runnerInstanceId, deadId),
          or(eq(agentTurns.state, "running"), eq(agentTurns.state, "handoff")),
        ),
      ),
  )
  return rows.map((row) =>
    liveTurnKey(
      row.threadId,
      row.resumeInput.actingAgentId ?? row.agentId ?? null,
      row.resumeInput.liveTurnKey ?? null,
    ),
  )
}

/** Daily retention: terminal turns past 30 days, and every terminal turn's journal. */
export async function runTurnRetention(): Promise<void> {
  const pruned = await pruneTerminalTurns()
  log.info(pruned, "turn_retention")
}

/**
 * Test access to this module's private steps, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const TurnResumeTestAccess = {
  /** End a turn the resume could not carry on, with its notice to the person. */
  failTurn,
}
