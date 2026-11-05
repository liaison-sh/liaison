// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The turn ledger: the only writer of `kernel.agent_turns` and
 * `kernel.agent_turn_events` (migration 0225).
 *
 * A turn is owned by one process while it runs (`runner_instance_id`, this
 * process's `INSTANCE_ID`). Every write a runner makes is FENCED on that
 * ownership: it applies only while the row still names the runner and is
 * `running`, and answers `"fenced"` when it did not. A fenced runner has lost
 * the turn (a resume claimed it on another process): it aborts, writes no
 * message and emits no terminal frame. A false "dead" verdict therefore costs
 * at most one re-issued model step, never a doubled reply.
 *
 * The journal holds complete steps only, one `agent_turn_events` row each. A
 * step cut half-way is discarded and re-issued by the resume; outside effects
 * of write tools are kept single by the effect ledger (lib/effect-once.ts),
 * not by this journal.
 *
 * Every access goes through the privileged connection: the rows hold tool
 * results, and no route reads them.
 */
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  type AgentTurnEventRow,
  type AgentTurnFailureReason,
  type AgentTurnOrigin,
  type AgentTurnResumeInput,
  type AgentTurnRow,
  agentTurnEvents,
  agentTurns,
  effectLedger,
} from "~/db/schema/kernel"
import { INSTANCE_ID } from "~/infra/instance-id"
import { rootLogger } from "~/lib/logger"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"

const log = rootLogger.child({ module: "turn-ledger" })

/** The answer of every fenced write. */
export type FencedWrite = "ok" | "fenced"

/** A complete step as the turn runtime journals it (the shape is the runtime's). */
export type TurnStepPayload = Record<string, unknown>

/** The terminal states a runner may finish a turn in. */
export type TurnFinalState = "done" | "failed" | "interrupted"

/** A running turn whose heartbeat is older than this may be claimed for resume. */
export const TURN_STALE_AFTER_MS = 30_000

/** Terminal turns (and their events) older than this are pruned. */
export const TURN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The longest a turn may stay unfinished, across every attempt (M2): the
 * longest attempt (the 600 s budget ceiling) several times over, plus the
 * handoff and resume waits. An open turn older than this is never resumed:
 * it ends `interrupted` (`expireStaleTurns`), so it cannot answer an old
 * message days later.
 */
export const TURN_MAX_AGE_MS = 60 * 60 * 1000

/** The effect-ledger keys of a turn's write tool calls (tool-effect-key.ts). */
function turnEffectKeys(turnId: string) {
  return sql`${effectLedger.key} LIKE ${`tool:${turnId}:%`}`
}

export interface OpenTurnInput {
  orgId: string
  threadId: string
  origin: AgentTurnOrigin
  /** The job (or other durable origin) the turn came from; unique per org. */
  originRef?: string | null
  agentId?: string | null
  userMessageId?: string | null
  runId?: string | null
  resumeInput?: AgentTurnResumeInput
  /** The owning process. Default: this process. */
  runner?: string
}

/**
 * Open a turn owned by `runner`. With an `originRef` that already has a turn
 * in the org, nothing is inserted and the existing row comes back with
 * `created: false`: a re-run of the same job resumes (or skips) that turn
 * instead of starting a second one.
 */
export async function openTurn(
  input: OpenTurnInput,
): Promise<{ turn: AgentTurnRow; created: boolean }> {
  return withPrivilegedDb(input.orgId, "turn-ledger:open", async (tx) => {
    const inserted = await tx
      .insert(agentTurns)
      .values({
        orgId: input.orgId,
        threadId: input.threadId,
        origin: input.origin,
        originRef: input.originRef ?? null,
        agentId: input.agentId ?? null,
        userMessageId: input.userMessageId ?? null,
        runId: input.runId ?? null,
        runnerInstanceId: input.runner ?? INSTANCE_ID,
        resumeInput: input.resumeInput ?? {},
      })
      .onConflictDoNothing({
        target: [agentTurns.orgId, agentTurns.originRef],
        where: sql`origin_ref IS NOT NULL`,
      })
      .returning()
    const row = inserted[0]
    if (row) return { turn: row, created: true }
    // Only an origin_ref conflict can skip the insert.
    const existing = await tx
      .select()
      .from(agentTurns)
      .where(
        and(eq(agentTurns.orgId, input.orgId), eq(agentTurns.originRef, input.originRef ?? "")),
      )
      .limit(1)
    const found = existing[0]
    if (!found)
      throw new Error(`turn-ledger: open conflicted but no turn has origin_ref ${input.originRef}`)
    return { turn: found, created: false }
  })
}

/** The fence every runner write carries. */
function owned(turnId: string, runner: string) {
  return and(
    eq(agentTurns.id, turnId),
    eq(agentTurns.runnerInstanceId, runner),
    eq(agentTurns.state, "running"),
  )
}

/**
 * Journal one complete step: the event row, the step count and the heartbeat,
 * in one transaction, only while `runner` owns the turn. The event's `seq` is
 * the turn's new step count, so steps are numbered 1, 2, ... across attempts.
 */
export async function appendStep(
  orgId: string,
  turnId: string,
  runner: string,
  payload: TurnStepPayload,
): Promise<FencedWrite> {
  const started = performance.now()
  const bytes = JSON.stringify(payload).length
  const result = await withPrivilegedDb(orgId, "turn-ledger:append-step", async (tx) => {
    const bumped = await tx
      .update(agentTurns)
      .set({
        stepCount: sql`${agentTurns.stepCount} + 1`,
        heartbeatAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(owned(turnId, runner), eq(agentTurns.orgId, orgId)))
      .returning({ stepCount: agentTurns.stepCount })
    const seq = bumped[0]?.stepCount
    if (seq === undefined) return "fenced" as const
    await tx.insert(agentTurnEvents).values({ turnId, orgId, seq, kind: "step", payload })
    return "ok" as const
  })
  if (result === "ok") {
    log.info({ turnId, ms: Math.round(performance.now() - started), bytes }, "turn_step_journaled")
  } else {
    log.warn({ turnId, runner }, "turn_fenced")
  }
  return result
}

/** Refresh the heartbeat of a turn `runner` still owns. */
export async function touch(orgId: string, turnId: string, runner: string): Promise<FencedWrite> {
  const rows = await withPrivilegedDb(orgId, "turn-ledger:touch", (tx) =>
    tx
      .update(agentTurns)
      .set({ heartbeatAt: sql`now()` })
      .where(and(owned(turnId, runner), eq(agentTurns.orgId, orgId)))
      .returning({ id: agentTurns.id }),
  )
  return rows.length > 0 ? "ok" : "fenced"
}

/**
 * Hand the turn off at a step boundary (a draining process): `handoff` makes
 * it claimable by a resume at once, without waiting for the heartbeat to age.
 */
export async function handoff(orgId: string, turnId: string, runner: string): Promise<FencedWrite> {
  const rows = await withPrivilegedDb(orgId, "turn-ledger:handoff", (tx) =>
    tx
      .update(agentTurns)
      .set({ state: "handoff", heartbeatAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(owned(turnId, runner), eq(agentTurns.orgId, orgId)))
      .returning({ id: agentTurns.id }),
  )
  return rows.length > 0 ? "ok" : "fenced"
}

export interface FinishTurnInput {
  orgId: string
  turnId: string
  runner: string
  state: TurnFinalState
  /**
   * Why a turn that did not end `done` ended (migration 0228); ignored for
   * `done`. Required, so every caller that ends a turn says it.
   */
  failureReason: AgentTurnFailureReason | null
  /** The reply's message id (pre-minted, so it can be stored before the insert). */
  agentMessageId?: string | null
  errorCode?: string | null
}

/**
 * Finish a turn `runner` still owns and clear its journal (the reply now lives
 * in kernel.messages).
 *
 * Pass the transaction that inserts the reply as `tx` so the state change and
 * the message commit together. Call it FIRST in that transaction: on
 * `"fenced"` the caller must not insert the message (another process owns the
 * turn and will write the reply).
 */
export async function finishTurn(input: FinishTurnInput, tx?: PrivilegedDb): Promise<FencedWrite> {
  const run = async (db: PrivilegedDb): Promise<FencedWrite> => {
    const rows = await db
      .update(agentTurns)
      .set({
        state: input.state,
        agentMessageId: input.agentMessageId ?? null,
        errorCode: input.errorCode ?? null,
        // A failed or interrupted turn with no reason given is not known to be
        // its own failure: `process`, so a deploy's counters never read low.
        failureReason: input.state === "done" ? null : (input.failureReason ?? "process"),
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(owned(input.turnId, input.runner), eq(agentTurns.orgId, input.orgId)))
      .returning({ id: agentTurns.id })
    if (rows.length === 0) return "fenced"
    await db.delete(agentTurnEvents).where(eq(agentTurnEvents.turnId, input.turnId))
    // The turn's write results are needed only while it may be re-run (M4):
    // a finished turn is never resumed, so they go with its journal.
    await db
      .delete(effectLedger)
      .where(and(eq(effectLedger.orgId, input.orgId), turnEffectKeys(input.turnId)))
    return "ok"
  }
  const result = tx ? await run(tx) : await withPrivilegedDb(input.orgId, "turn-ledger:finish", run)
  if (result === "fenced") log.warn({ turnId: input.turnId, runner: input.runner }, "turn_fenced")
  return result
}

/**
 * Name the reply of a turn finished in this transaction (`finishTurn(…, tx)`
 * first, then the message insert, then this): the message id exists only
 * once the insert ran.
 */
export async function setTurnReply(
  tx: PrivilegedDb,
  orgId: string,
  turnId: string,
  agentMessageId: string,
): Promise<void> {
  await tx
    .update(agentTurns)
    .set({ agentMessageId })
    .where(and(eq(agentTurns.id, turnId), eq(agentTurns.orgId, orgId)))
}

export interface ClaimForResumeInput {
  orgId: string
  turnId: string
  /** The attempt the claimer read; a concurrent claim bumps it and this one loses. */
  expectedAttempt: number
  /** The claiming process. Default: this process. */
  runner?: string
  /** A running turn is claimable once its heartbeat is this old. Default 30 s. */
  staleAfterMs?: number
}

/**
 * Claim a turn for resume (compare-and-set): a `handoff` turn, or a `running`
 * one whose heartbeat is stale. The claim sets the runner, bumps `attempt`
 * and puts the turn back to `running`; from then on the previous runner is
 * fenced. Exactly one of several concurrent claimers wins; the others get
 * null. Whether the previous runner is still live is the caller's check (the
 * instance registry), made before claiming.
 */
export async function claimForResume(input: ClaimForResumeInput): Promise<AgentTurnRow | null> {
  const staleS = (input.staleAfterMs ?? TURN_STALE_AFTER_MS) / 1000
  const rows = await withPrivilegedDb(input.orgId, "turn-ledger:claim", (tx) =>
    tx
      .update(agentTurns)
      .set({
        runnerInstanceId: input.runner ?? INSTANCE_ID,
        attempt: sql`${agentTurns.attempt} + 1`,
        state: "running",
        heartbeatAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(agentTurns.id, input.turnId),
          eq(agentTurns.orgId, input.orgId),
          eq(agentTurns.attempt, input.expectedAttempt),
          or(
            eq(agentTurns.state, "handoff"),
            and(
              eq(agentTurns.state, "running"),
              lt(agentTurns.heartbeatAt, sql`now() - make_interval(secs => ${staleS})`),
            ),
          ),
        ),
      )
      .returning(),
  )
  const row = rows[0] ?? null
  if (row) log.info({ turnId: row.id, attempt: row.attempt }, "turn_claimed")
  return row
}

/**
 * Start a failed or interrupted turn over as a new attempt (M5): a job re-run
 * after a provider error answers again, as before turns were durable. The row
 * goes back to `running` under `runner` with a fresh journal and the new
 * attempt's resume input. Compare-and-set on the attempt: of two re-runs one
 * wins, the other gets null.
 */
export async function reopenForRetry(input: {
  orgId: string
  turnId: string
  expectedAttempt: number
  resumeInput: AgentTurnResumeInput
  userMessageId?: string | null
  runId?: string | null
  runner?: string
}): Promise<AgentTurnRow | null> {
  return withPrivilegedDb(input.orgId, "turn-ledger:reopen", async (tx) => {
    const rows = await tx
      .update(agentTurns)
      .set({
        state: "running",
        runnerInstanceId: input.runner ?? INSTANCE_ID,
        attempt: sql`${agentTurns.attempt} + 1`,
        stepCount: 0,
        resumeInput: input.resumeInput,
        userMessageId: input.userMessageId ?? null,
        runId: input.runId ?? null,
        agentMessageId: null,
        errorCode: null,
        finishedAt: null,
        heartbeatAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(agentTurns.id, input.turnId),
          eq(agentTurns.orgId, input.orgId),
          eq(agentTurns.attempt, input.expectedAttempt),
          inArray(agentTurns.state, ["failed", "interrupted"]),
        ),
      )
      .returning()
    const row = rows[0] ?? null
    if (!row) return null
    await tx.delete(agentTurnEvents).where(eq(agentTurnEvents.turnId, row.id))
    log.info({ turnId: row.id, attempt: row.attempt }, "turn_reopened")
    return row
  })
}

/**
 * End every open turn older than `maxAgeMs` `interrupted` (M2), whoever runs
 * it: such a turn is past any budget, and resuming it would answer an old
 * message. Its journal and its write results go with it. Returns the ids.
 */
export async function expireStaleTurns(maxAgeMs: number = TURN_MAX_AGE_MS): Promise<string[]> {
  const maxAgeS = maxAgeMs / 1000
  // An org being moved keeps its turns as they are until the move ends.
  return sweepSkippingMoving((notMoving) =>
    withSystemDb("turn-ledger:expire", async (tx) => {
      const rows = await tx
        .update(agentTurns)
        .set({
          state: "interrupted",
          errorCode: "turn_expired",
          // Nothing carried it on: its process stopped or died, or hung past
          // every budget.
          failureReason: "process",
          finishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            inArray(agentTurns.state, ["running", "handoff"]),
            lt(agentTurns.createdAt, sql`now() - make_interval(secs => ${maxAgeS})`),
            notMoving(agentTurns.orgId),
          ),
        )
        .returning({ id: agentTurns.id, orgId: agentTurns.orgId })
      if (rows.length === 0) return []
      const ids = rows.map((r) => r.id)
      await tx.delete(agentTurnEvents).where(inArray(agentTurnEvents.turnId, ids))
      for (const row of rows) {
        await tx
          .delete(effectLedger)
          .where(and(eq(effectLedger.orgId, row.orgId), turnEffectKeys(row.id)))
      }
      log.warn({ turns: ids }, "turn_expired")
      return ids
    }),
  )
}

/** The turn a durable origin (a job) already opened in the org, or null. */
export async function findByOriginRef(
  orgId: string,
  originRef: string,
): Promise<AgentTurnRow | null> {
  const rows = await withPrivilegedDb(orgId, "turn-ledger:find-origin", (tx) =>
    tx
      .select()
      .from(agentTurns)
      .where(and(eq(agentTurns.orgId, orgId), eq(agentTurns.originRef, originRef)))
      .limit(1),
  )
  return rows[0] ?? null
}

/** A turn and its journaled steps in order, or null. What a resume rebuilds from. */
export async function loadTurn(
  orgId: string,
  turnId: string,
): Promise<{ turn: AgentTurnRow; steps: AgentTurnEventRow[] } | null> {
  return withPrivilegedDb(orgId, "turn-ledger:load", async (tx) => {
    const turns = await tx
      .select()
      .from(agentTurns)
      .where(and(eq(agentTurns.id, turnId), eq(agentTurns.orgId, orgId)))
      .limit(1)
    const turn = turns[0]
    if (!turn) return null
    const steps = await tx
      .select()
      .from(agentTurnEvents)
      .where(eq(agentTurnEvents.turnId, turnId))
      .orderBy(asc(agentTurnEvents.seq))
    return { turn, steps }
  })
}

/** What a client following a turn needs (the re-attach route): no journal. */
export interface TurnStatus {
  threadId: string
  state: AgentTurnRow["state"]
  agentMessageId: string | null
  errorCode: string | null
  /** The person the turn answers (its actor), null when it records none. */
  requesterId: string | null
  /** The live stream's agent and turn key, as the turn's frames name them. */
  liveAgentId: string | null
  liveTurnKey: string | null
}

/** A turn's state and identity, or null when the org holds no such turn. */
export async function turnStatus(orgId: string, turnId: string): Promise<TurnStatus | null> {
  const rows = await withPrivilegedDb(orgId, "turn-ledger:status", (tx) =>
    tx
      .select({
        threadId: agentTurns.threadId,
        state: agentTurns.state,
        agentMessageId: agentTurns.agentMessageId,
        errorCode: agentTurns.errorCode,
        agentId: agentTurns.agentId,
        resumeInput: agentTurns.resumeInput,
      })
      .from(agentTurns)
      .where(and(eq(agentTurns.id, turnId), eq(agentTurns.orgId, orgId)))
      .limit(1),
  )
  const row = rows[0]
  if (!row) return null
  const actor = row.resumeInput.actor as { userId?: unknown } | undefined
  return {
    threadId: row.threadId,
    state: row.state,
    agentMessageId: row.agentMessageId,
    errorCode: row.errorCode,
    requesterId: typeof actor?.userId === "string" ? actor.userId : null,
    liveAgentId: row.resumeInput.actingAgentId ?? row.agentId ?? null,
    liveTurnKey: row.resumeInput.liveTurnKey ?? null,
  }
}

/**
 * Retention (instance-wide): delete `done` / `failed` / `interrupted` turns
 * finished more than `olderThanMs` ago, and the journal of every terminal
 * turn. Running and handed-off turns are never touched.
 */
export async function pruneTerminalTurns(
  olderThanMs: number = TURN_RETENTION_MS,
): Promise<{ turns: number; events: number; effects: number }> {
  const terminal = ["done", "failed", "interrupted"] as const
  const olderThanS = olderThanMs / 1000
  // An org being moved keeps its rows as they are until the move ends.
  return sweepSkippingMoving((notMoving) =>
    withSystemDb("turn-ledger:retention", async (tx) => {
      const turns = await tx
        .delete(agentTurns)
        .where(
          and(
            notMoving(agentTurns.orgId),
            inArray(agentTurns.state, terminal),
            lt(
              sql`coalesce(${agentTurns.finishedAt}, ${agentTurns.updatedAt})`,
              sql`now() - make_interval(secs => ${olderThanS})`,
            ),
          ),
        )
        .returning({ id: agentTurns.id })
      const terminalIds = tx
        .select({ id: agentTurns.id })
        .from(agentTurns)
        .where(inArray(agentTurns.state, terminal))
      const events = await tx
        .delete(agentTurnEvents)
        .where(and(inArray(agentTurnEvents.turnId, terminalIds), notMoving(agentTurnEvents.orgId)))
        .returning({ turnId: agentTurnEvents.turnId })
      // Turn write results left behind (a turn whose finish never ran): every
      // `tool:` row older than the longest a turn may stay open (M4).
      const maxAgeS = TURN_MAX_AGE_MS / 1000
      const effects = await tx
        .delete(effectLedger)
        .where(
          and(
            notMoving(effectLedger.orgId),
            sql`${effectLedger.key} LIKE 'tool:%'`,
            lt(effectLedger.createdAt, sql`now() - make_interval(secs => ${maxAgeS})`),
          ),
        )
        .returning({ key: effectLedger.key })
      return { turns: turns.length, events: events.length, effects: effects.length }
    }),
  )
}
