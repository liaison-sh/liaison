// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T06: every loop safety verdict for an agent dispatch, computed from the
// `kernel.messages` parent chain and from nothing else.
//
// The guard holds NO state of its own. Hop depth is the number of agent
// authored links already in the chain, the root turn is the chain's topmost
// row, the per root cap counts agent authored descendants of that root, and
// the dedupe is a scan of siblings under one parent. That is why the same
// module covers a plain human `@mention` chain and an `agents_ask` chain
// alike: they are the same rows.
import type { ClientSurface } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { liveLocalClaimHolders } from "~/modules/agent/local-sessions/local-claim-service"
import type { TurnCoordination } from "~/modules/agent/runtime/agent-service"
import { delegateToAgent } from "~/modules/agent/scopes/effective-scope"
import { writeAuditLog } from "~/modules/audit/service"
import { postAgentAutoAddSystemMessage, postThreadSystemMessage } from "~/modules/threads/message"
import { addAgentParticipant, removeAgentParticipant } from "~/modules/threads/participant"

type AgentServiceModule = typeof import("~/modules/agent/runtime/agent-service")

/**
 * Agent authored links allowed in a chain before a dispatch is refused,
 * counted as links ALREADY IN THE CHAIN. A human mention is dispatch 1 at hop
 * depth 0 (allowed). The mentioned agent's own ask is dispatch 2 at hop depth 1
 * (allowed). The asked agent's ask is dispatch 3 at hop depth 2 and is the
 * first refused, so a human question reaches at most two agents deep.
 */
export const AGENT_HOP_BOUND = 2

/** Two identical asks to the same callee inside two minutes are one ask. */
export const AGENT_ASK_DEDUPE_WINDOW_MS = 120_000

/**
 * Hard ceiling on agent initiated turns descending from one human turn,
 * independent of the hop bound: a fan out of six siblings at hop 1 is capped
 * even though every one of them is within the hop bound.
 */
export const AGENT_TURNS_PER_ROOT_CAP = 6

/**
 * Levels the upward walk reads before it gives up. It is NOT the hop bound: a
 * chain row is a message, and four people replying to each other put four rows
 * above a mention with no agent link in any of them. This cap is the cycle and
 * termination guard alone, which is why it is far above any depth a real
 * conversation reaches.
 */
const CHAIN_WALK_LEVELS = 32

/** Levels the downward count reads. A cycle cannot run it forever either. */
const DESCENDANT_WALK_LEVELS = 64

export type DispatchVerdict =
  | { allowed: true; hopDepth: number; rootMessageId: string }
  | { allowed: false; reason: "hop_bound" | "self_ask" | "root_turn_cap" | "chain_too_deep" }
  | {
      allowed: false
      reason: "duplicate_ask"
      earlierAnswer: string | null
      /** The standing answer's own scope tag, so a caller handed that answer
       *  can tag its own reply with what the answer carries (A2). */
      earlierAnswerScopes: string[]
      /** The earlier question this one repeats; the answer hangs under IT. */
      earlierQuestionId: string
    }

export interface EvaluateAgentDispatchParams {
  orgId: string
  threadId: string
  /** The message the new one hangs under; null for a human's own post. */
  parentMessageId: string | null
  /** The agent asking; null when a human is asking. */
  callerAgentId: string | null
  calleeAgentId: string
  questionText: string
  /**
   * The message that triggers this dispatch. With no parent it IS the chain
   * root, which is what the verdict reports so a caller can count a root's
   * turns without re-deriving the chain.
   */
  triggerMessageId?: string
  /** Pinned clock for the dedupe window. Tests advance this, never the wall. */
  now?: Date
}

/**
 * The mention token a posted question opens with, as `sendMessage` parses it.
 * It names WHO is being asked, never WHAT is being asked, and the two dedupe
 * passes are handed the question with it (the pre-check reads the content about
 * to be posted) and without it (the dispatch reads the bare question). Stripped
 * on both sides, so the two passes can only ever agree.
 */
const LEADING_MENTION_TOKEN = /^\s*@\[[^\]]*\]\(agent:[^)]*\)\s*/

/**
 * Question text reduced to what makes two asks the same ask: the mention token,
 * case, runs of whitespace and trailing punctuation carry no question of their
 * own.
 */
function normalizeQuestion(text: string): string {
  return text
    .replace(LEADING_MENTION_TOKEN, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.!?,;:]+$/, "")
}

export async function evaluateAgentDispatch(
  db: RlsClient,
  params: EvaluateAgentDispatchParams,
): Promise<DispatchVerdict> {
  const { orgId, threadId, parentMessageId, callerAgentId, calleeAgentId } = params
  const k = drizzleSql.raw(schemaRef("kernel"))

  // 1. An agent cannot ask itself. First, because it needs no query and
  //    because every other refusal below would let it through.
  if (callerAgentId && callerAgentId === calleeAgentId) {
    return { allowed: false, reason: "self_ask" }
  }

  // A human's own mention is always hop 0: there is no chain above it.
  if (!parentMessageId) {
    return { allowed: true, hopDepth: 0, rootMessageId: params.triggerMessageId ?? "" }
  }

  // 2. Walk the parent chain upward, capped so a cycle terminates.
  const chain = extractRows<{ id: string; author_agent_id: string | null; depth: number }>(
    await db.execute(drizzleSql`
      WITH RECURSIVE chain AS (
        SELECT m.id, m.parent_message_id, m.author_agent_id, 1 AS depth
        FROM ${k}.messages m
        WHERE m.id = ${parentMessageId} AND m.org_id = ${orgId}
        UNION ALL
        SELECT m.id, m.parent_message_id, m.author_agent_id, c.depth + 1
        FROM ${k}.messages m
        JOIN chain c ON m.id = c.parent_message_id
        WHERE c.depth < ${CHAIN_WALK_LEVELS}
      )
      SELECT id, author_agent_id, depth FROM chain ORDER BY depth ASC`),
  )

  // A chain that fills the walk is a cycle or a pathology, never a depth this
  // guard can measure. Refused on its own reason, so a deep human conversation
  // is never reported as an agent relay that went too far.
  if (chain.length >= CHAIN_WALK_LEVELS) return { allowed: false, reason: "chain_too_deep" }

  // The hop depth is agent AUTHORSHIP: only a message an agent wrote is a relay
  // link. Human rows nest as deep as people reply and delegate nothing.
  const hopDepth = chain.filter((row) => row.author_agent_id !== null).length
  if (hopDepth >= AGENT_HOP_BOUND) return { allowed: false, reason: "hop_bound" }
  const rootMessageId = chain[chain.length - 1]?.id ?? parentMessageId

  // 3. The per root cap: agent authored messages descending from the root of
  //    this chain, the human turn that started the whole exchange.
  const [counted] = extractRows<{ agent_turns: string }>(
    await db.execute(drizzleSql`
      WITH RECURSIVE descendants AS (
        SELECT m.id, m.author_type, 1 AS depth
        FROM ${k}.messages m
        WHERE m.id = ${rootMessageId} AND m.org_id = ${orgId}
        UNION ALL
        SELECT m.id, m.author_type, d.depth + 1
        FROM ${k}.messages m
        JOIN descendants d ON m.parent_message_id = d.id
        WHERE d.depth < ${DESCENDANT_WALK_LEVELS}
      )
      SELECT COUNT(*) FILTER (WHERE author_type = 'agent') AS agent_turns FROM descendants`),
  )
  if (Number(counted?.agent_turns ?? 0) >= AGENT_TURNS_PER_ROOT_CAP) {
    return { allowed: false, reason: "root_turn_cap" }
  }

  // 4. The dedupe. A refusal that hands the caller nothing back is what makes a
  //    model ask a third time, so the verdict carries the standing answer when
  //    there is one.
  const now = params.now ?? new Date()
  // ISO strings with an explicit cast: the driver binds a Date in a raw
  // template as an untyped parameter and refuses it.
  const windowStart = new Date(now.getTime() - AGENT_ASK_DEDUPE_WINDOW_MS).toISOString()
  const nowIso = now.toISOString()
  const siblings = extractRows<{ id: string; content: string }>(
    await db.execute(drizzleSql`
      SELECT m.id, m.content
      FROM ${k}.messages m
      WHERE m.org_id = ${orgId}
        AND m.thread_id = ${threadId}
        AND m.parent_message_id = ${parentMessageId}
        AND m.deleted_at IS NULL
        AND m.created_at > ${windowStart}::timestamptz
        AND m.created_at <= ${nowIso}::timestamptz
        AND m.mentions @> ${JSON.stringify([{ type: "agent", id: calleeAgentId }])}::jsonb
      ORDER BY m.created_at DESC`),
  )
  const asked = normalizeQuestion(params.questionText)
  const duplicated = siblings.find((row) => normalizeQuestion(row.content) === asked)
  if (duplicated) {
    // The answer to THAT question, not the newest thing the callee said under
    // this parent: two questions to one callee under one parent are ordinary,
    // and handing back the wrong one answers a question nobody asked.
    const [answer] = extractRows<{ content: string; required_scopes: string[] | null }>(
      await db.execute(drizzleSql`
        SELECT m.content, m.required_scopes
        FROM ${k}.messages m
        WHERE m.org_id = ${orgId}
          AND m.thread_id = ${threadId}
          AND m.parent_message_id = ${duplicated.id}
          AND m.author_agent_id = ${calleeAgentId}
          AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC
        LIMIT 1`),
    )
    return {
      allowed: false,
      reason: "duplicate_ask",
      earlierAnswer: answer?.content ?? null,
      earlierAnswerScopes: answer?.required_scopes ?? [],
      earlierQuestionId: duplicated.id,
    }
  }

  return { allowed: true, hopDepth, rootMessageId }
}

/**
 * What the room is told when a dispatch is refused, one fixed line per reason.
 * A refusal is never silent: a question that went nowhere with no line looks
 * exactly like an agent ignoring somebody.
 *
 * The duplicate line is the same whatever the earlier answer was. That answer
 * goes back to the ASKING AGENT through its tool result, never as a second
 * public message repeating what the room already read.
 */
export const DISPATCH_REFUSAL_LINES: Record<string, string> = {
  hop_bound: "This question was not passed on: agents may relay a question twice, no further.",
  self_ask: "An agent cannot ask itself.",
  duplicate_ask: "The same question was already asked, the earlier answer stands.",
  root_turn_cap: "This conversation reached its limit of agent replies for one question.",
  caller_scope_unknown:
    "This question was not passed on: the asking agent's own permissions could not be established.",
  chain_too_deep:
    "This question was not passed on: the conversation it hangs under is too deep to follow.",
  node_daily_cap:
    "This question was not passed on: the agent reached its daily limit on the computer it runs on.",
  node_source_scope:
    "This question was not passed on: the owner of the computer that agent runs on cannot read what was asked.",
  node_routing_failed:
    "This question was not passed on: it could not be handed to the computer that agent runs on. Try again later.",
}

/**
 * The fail closed delegation refusal, as a TYPED error.
 *
 * It is the guard working, not a fault: the callee stopped being a live agent
 * between the guard's read and the hand off, so the turn is refused rather than
 * run at the callee's own ceiling. `executeTool` recognises the code and logs it
 * at warn, so a refusal never pages the watchdog (the alert noise policy).
 */
export const AGENT_DELEGATION_UNAVAILABLE = "agent_delegation_unavailable"

export class AgentDelegationUnavailableError extends Error {
  readonly code = AGENT_DELEGATION_UNAVAILABLE
  readonly retryable = false
  constructor(message: string) {
    super(message)
    this.name = "AgentDelegationUnavailableError"
  }
}

/** What one dispatched turn reports back, as `invokeAgentForThread` returns it. */
export interface DispatchedTurnResult {
  finishReason: string
  turnsAdded?: number
  withheldCapabilities?: string[]
}

/**
 * The verdict, plus a handle on the turn when one started. A mention fires and
 * forgets it; `agents_ask` races it against its own wait bound, which is why
 * the handle exists at all: `invokeAgentForThread` RESOLVES after its finalize
 * has persisted the answer, so awaiting it IS the completion signal and no
 * caller has to poll the messages table for one.
 */
/**
 * A32. The desktop is running this agent's turns in this conversation, so the
 * server does not. It is NOT a refusal: nothing is wrong, the answer is coming
 * from somewhere else, and no line is posted in the room. The audit row is the
 * record.
 */
export const DISPATCH_SKIPPED_FOR_LOCAL = "agent.dispatch.skipped_for_local"

/**
 * The claim could not be READ, so nothing here knows whether a machine is
 * answering this conversation. The audit row is the only trace, and it exists
 * because the alternative (answering anyway) is the double reply the lease was
 * built to prevent.
 */
export const DISPATCH_CLAIM_READ_FAILED = "agent.dispatch.claim_read_failed"

/**
 * A turn that could not START at all: the provider has no key, the model is
 * gone, the runtime threw before it emitted a single frame. The room saw the
 * question, the agent seat appeared, and then nothing: no Queued, no Working,
 * no Failed, no line. This is the audit half of the answer; `agent_stream`
 * with action `error` is the half the open thread renders.
 */
export const AGENT_TURN_FAILED = "agent.turn.failed"

const turnFailureLog = rootLogger.child({ module: "agent-turn-failure" })

/** What the room is told when the turn broke before it said anything. */
export const AGENT_TURN_FAILED_FALLBACK = "the agent could not start its turn"

/**
 * Publish a turn's failure to START. Two records, because they answer two
 * different questions: the ephemeral `agent_stream:error` frame is what an open
 * thread turns into the Failed state row (`AgentStateLabel` maps a stream error
 * onto Failed and prints the reason), and the audit row is what says the turn
 * existed at all once every socket has gone.
 *
 * It never throws: it runs on a path that is already handling a failure, and a
 * broken audit write must not replace the error it was called to record.
 */
export async function reportAgentTurnFailure(params: {
  orgId: string
  threadId: string
  actorUserId: string
  agentId: string | null
  /**
   * The reply thread the turn was started in (A7). The Failed frame carries
   * it, so the reply panel draws the failure and the channel does not.
   */
  replyRootId?: string | null
  error: unknown
}): Promise<void> {
  const { orgId, threadId, actorUserId, agentId } = params
  const replyRootId = params.replyRootId ?? null
  const message =
    params.error instanceof Error && params.error.message.trim().length > 0
      ? params.error.message
      : AGENT_TURN_FAILED_FALLBACK

  try {
    const { recordAgentStreamEvent } = await import("~/modules/agent/runtime/stream-registry")
    const { broadcastEphemeral } = await import("~/infra/events/event-bus")
    // The frame carries the `seq` the record allocated (S28). A record Redis
    // fails is still broadcast, without it (open: the Failed row still shows).
    const frame = await recordAgentStreamEvent(
      threadId,
      orgId,
      "error",
      { message, ...(replyRootId ? { replyRootId } : {}) },
      { requesterId: actorUserId, agentId: params.agentId ?? null },
    ).catch((err: unknown) => {
      turnFailureLog.warn({ err, threadId, agentId }, "Recording the failed turn failed")
      return null
    })
    await broadcastEphemeral({
      app: "kernel",
      entity: "agent_stream",
      action: "error",
      entityId: threadId,
      orgId,
      actorId: actorUserId,
      actorType: "agent",
      // The agent whose turn failed, as on every other agent_stream frame: a
      // client keys the run on it and heads the failure block with its name.
      data: {
        threadId,
        agentId: agentId ?? null,
        message,
        ...(replyRootId ? { replyRootId } : {}),
        ...frame,
      },
    })
  } catch (err) {
    turnFailureLog.warn({ err, threadId, agentId }, "Broadcasting the failed turn failed")
  }

  try {
    await withPrivilegedDb(orgId, "agent-turn-failed", (db) =>
      writeAuditLog(db, {
        orgId,
        actorId: actorUserId,
        actorType: "agent",
        app: "kernel",
        entityType: "thread",
        entityId: threadId,
        action: AGENT_TURN_FAILED,
        ...(agentId ? { agentId } : {}),
        metadata: { threadId, error: message, ...(replyRootId ? { replyRootId } : {}) },
      }),
    )
  } catch (err) {
    turnFailureLog.warn({ err, threadId, agentId }, "Auditing the failed turn failed")
  }

  // A guided step waiting on this turn's answer reads the audit row
  // (tours/beat-status.ts): its card re-reads once the row is there, not only
  // on the failed frame above, which may come first.
  try {
    const { nudgeActiveTours } = await import("~/modules/tours/beat-status")
    await nudgeActiveTours(orgId, actorUserId)
  } catch (err) {
    turnFailureLog.warn({ err, threadId }, "Telling the guided tours of the failed turn failed")
  }
}

/**
 * The turn, with its failure to start REPORTED rather than only logged. The
 * rejection is re-thrown: a caller that awaits the answer still learns there is
 * none, and every fire-and-forget caller keeps its own `.catch`.
 */
export function withTurnFailureReported<T>(
  turn: Promise<T>,
  ctx: {
    orgId: string
    threadId: string
    actorUserId: string
    agentId: string | null
    /** The reply thread the turn answers in; null or absent is the channel. */
    replyRootId?: string | null
  },
): Promise<T> {
  return turn.catch(async (err) => {
    await reportAgentTurnFailure({ ...ctx, error: err })
    throw err
  })
}

/** A request the dispatch handed to a node job instead of a cloud turn (P4, A17). */
export interface DispatchedNodeJob {
  jobId: string
  /** Where it runs, as the asker is told ("Olive's computer"). */
  on: string
  /** True when no node was live: the job waits and its owner was told. */
  backlog: boolean
}

export type DispatchOutcome =
  | {
      allowed: true
      hopDepth: number
      rootMessageId: string
      turn: Promise<DispatchedTurnResult>
      nodeJob?: undefined
    }
  | {
      allowed: true
      hopDepth: number
      rootMessageId: string
      /** No cloud turn: the work is a node job, answered later (A17). */
      nodeJob: DispatchedNodeJob
      turn?: undefined
    }
  | {
      allowed: false
      reason:
        | "hop_bound"
        | "self_ask"
        | "root_turn_cap"
        | "chain_too_deep"
        | "caller_scope_unknown"
        | "claimed_locally"
        | "claim_read_failed"
        | "node_daily_cap"
        | "node_source_scope"
        | "node_routing_failed"
    }
  | {
      allowed: false
      reason: "duplicate_ask"
      earlierAnswer: string | null
      earlierAnswerScopes: string[]
      earlierQuestionId: string
    }

export interface DispatchAgentMentionParams {
  orgId: string
  threadId: string
  /** The agent being addressed. */
  calleeAgentId: string
  /** The agent doing the addressing; null when a human is. */
  callerAgentId: string | null
  /**
   * Where the callee's reply will hang. Null is the audience asymmetry: a human
   * facing turn is flattened to the thread root. An agent to agent exchange
   * passes the question message, and the callee's whole turn nests under it.
   */
  parentMessageId: string | null
  /** The message that triggered this dispatch; the turn answers it. */
  triggerMessageId: string
  /**
   * The reply thread the trigger lives in (0112, A7): a refusal is told there,
   * where the question was asked, not in the channel. Null or absent is the
   * channel. The turn itself reads its root off the trigger message.
   */
  replyRootId?: string | null
  questionText: string
  actor: {
    userId: string
    orgId: string
    scopes: string[]
    dimensionGrants?: Record<string, string[]>
  }
  /** Whose name the room sees on the auto add and refusal lines. */
  adderName: string
  /**
   * The delegation BOUND, when an agent (or an external connection) is asking
   * (A4): the grants of the person the request originates from, or for a
   * routine tick the calling turn's effective scope. The delegated turn runs
   * at this intersected with the callee's ceiling, computed by
   * `delegateToAgent`, which is the only intersection in this path: nothing
   * here reassembles one. (Named for its origin; see `agents_ask`.)
   */
  callerEffectiveScope?: string[]
  /** What the asking agent's turn had already read, carried into the callee's. */
  callerTaintScopes?: string[]
  /**
   * The question the callee is to answer, as the ASKER worded it, plus the
   * asker's display name. Set by `agents_ask` only. It becomes the last,
   * user-role message of the callee's prompt, which is the instruction that
   * path never had.
   */
  askedQuestion?: { askedBy: string; question: string }
  /**
   * What the HUMAN's surface knows about this turn (P4c-T10): the app they are
   * looking at, and the mailbox turn nonce their browser minted. Carried
   * through unchanged so a turn dispatched from a thread reaches the run frame
   * with exactly what a turn dispatched from the retired agent panel did.
   */
  turnContext?: AgentTurnContext
}

/** View + mailbox binding a live human surface hands its turn. */
export interface AgentTurnContext {
  currentView?: { tabType: string; entityId: string }
  mailboxTurnNonce?: string
  /** Where the human is (desktop app, browser, mobile app); absent is unknown. */
  clientSurface?: ClientSurface
  /** Set here, never by a caller: another agent started this turn (no input budget). */
  agentDispatched?: boolean
  /**
   * The person wrote from a restricted (device-flow) session: tools that the
   * REST surface refuses to such a session (session-ceiling.ts) refuse here too.
   */
  sessionRestricted?: boolean
}

/**
 * THE ONE dispatch path: guard, then seat, then turn, in that order.
 *
 * A human `@mention` and an `agents_ask` both come through here, so neither can
 * skip the guard or the refusal line, and a second path is exactly how the
 * guard would get bypassed. `runRls` is the caller's RLS transaction runner (a
 * route hands in `withRequestRls`, a tool hands in its own client), so each
 * step keeps the transaction boundary it had: the guard reads in its own, the
 * seat and its system line share one so neither can exist alone.
 */
export async function dispatchAgentMention(
  runRls: <T>(fn: (db: RlsClient) => Promise<T>) => Promise<T>,
  params: DispatchAgentMentionParams,
): Promise<DispatchOutcome> {
  const { orgId, threadId, calleeAgentId, callerAgentId, parentMessageId, actor } = params
  const log = rootLogger.child({ module: "agent-dispatch" })

  // FAIL CLOSED on A4. An agent is asking, and what that agent may reach is
  // unknown: running the callee's turn anyway would run it at the callee's OWN
  // ceiling, which is the one thing A4 forbids. A caller that cannot say how
  // far it reaches delegates nothing.
  if (callerAgentId && !params.callerEffectiveScope) {
    const refusal = { allowed: false as const, reason: "caller_scope_unknown" as const }
    log.warn({ threadId, agentId: calleeAgentId }, "Agent dispatch refused: caller scope unknown")
    try {
      await runRls((db) =>
        postThreadSystemMessage(db, {
          orgId,
          threadId,
          actorUserId: actor.userId,
          authorName: params.adderName,
          content: DISPATCH_REFUSAL_LINES[refusal.reason],
          replyRootId: params.replyRootId ?? null,
        }),
      )
    } catch (err) {
      log.warn(
        { err, threadId, agentId: calleeAgentId },
        "Posting the dispatch refusal line failed",
      )
    }
    return refusal
  }

  // THE LOCAL CLAIM, before any of the loop guards (A32). A human message in a
  // conversation a desktop is holding for this agent is answered by that
  // machine; running the turn here as well would post the second of two
  // replies, from a runtime that cannot see the user's folder. Only a HUMAN's
  // message is held back: the desktop learns about those, and an agent to agent
  // question is never announced to it, so skipping one would leave it
  // unanswered by anybody.
  //
  // Read PRIVILEGED on purpose: the claim may be held by someone else in the
  // room, and this runs on behalf of whoever posted the message.
  if (!callerAgentId) {
    let claimed = new Set<string>()
    try {
      claimed = await withSystemDb("dispatch-local-claim-check", (db) =>
        liveLocalClaimHolders(db, { orgId, threadId }),
      )
    } catch (err) {
      // FAIL CLOSED. A claim that cannot be read is a conversation that may be
      // being answered on somebody's machine right now: answering it here as
      // well is the double reply and the double bill this whole lease exists to
      // prevent, and it is the ONE failure direction the slice cannot afford.
      // Failing closed costs at most one turn of silence, bounded by the lease's
      // own 60 s TTL and by the machine's own answer; and the read is a single
      // indexed one row select on the pool every other step uses, so a read that
      // fails is a turn that was not going to succeed either.
      log.warn({ err, threadId, agentId: calleeAgentId }, "Local claim check failed")
      try {
        await withPrivilegedDb(orgId, "dispatch-claim-read-failed", (db) =>
          writeAuditLog(db, {
            orgId,
            actorId: actor.userId,
            actorType: "agent",
            app: "kernel",
            entityType: "message",
            entityId: params.triggerMessageId,
            action: DISPATCH_CLAIM_READ_FAILED,
            agentId: calleeAgentId,
            metadata: { threadId, error: err instanceof Error ? err.message : String(err) },
          }),
        )
      } catch (auditErr) {
        log.warn({ err: auditErr, threadId }, "Auditing the failed claim read failed")
      }
      return { allowed: false, reason: "claim_read_failed" }
    }
    if (claimed.has(calleeAgentId)) {
      log.info(
        { threadId, agentId: calleeAgentId },
        "Agent dispatch skipped: a local session holds this conversation",
      )
      try {
        await withPrivilegedDb(orgId, "dispatch-skipped-for-local", (db) =>
          writeAuditLog(db, {
            orgId,
            actorId: actor.userId,
            actorType: "agent",
            app: "kernel",
            entityType: "message",
            entityId: params.triggerMessageId,
            action: DISPATCH_SKIPPED_FOR_LOCAL,
            agentId: calleeAgentId,
            // Kept for the lapse sweep, which answers this message later: a
            // restricted session's question stays restricted then too.
            metadata: {
              threadId,
              runLocation: "local",
              ...(params.turnContext?.sessionRestricted ? { sessionRestricted: true } : {}),
            },
          }),
        )
      } catch (err) {
        log.warn({ err, threadId, agentId: calleeAgentId }, "Auditing the local skip failed")
      }
      return { allowed: false, reason: "claimed_locally" }
    }
  }

  const verdict = await runRls((db) =>
    evaluateAgentDispatch(db, {
      orgId,
      threadId,
      parentMessageId,
      callerAgentId,
      calleeAgentId,
      questionText: params.questionText,
      triggerMessageId: params.triggerMessageId,
    }),
  )

  if (!verdict.allowed) {
    // Expected behaviour, never an error: a guard that fires is the system
    // working (the alert noise policy).
    log.warn({ threadId, agentId: calleeAgentId, reason: verdict.reason }, "Agent dispatch refused")
    try {
      await runRls((db) =>
        postThreadSystemMessage(db, {
          orgId,
          threadId,
          actorUserId: actor.userId,
          authorName: params.adderName,
          content: DISPATCH_REFUSAL_LINES[verdict.reason],
          replyRootId: params.replyRootId ?? null,
        }),
      )
    } catch (err) {
      log.warn(
        { err, threadId, agentId: calleeAgentId },
        "Posting the dispatch refusal line failed",
      )
    }
    return verdict
  }

  // P4 (S21, S25, A17): an agent attached to someone's node, asked by a
  // requester the attachment allows, answers from that node. Decided AFTER the
  // loop guards (a node job is a hop like any other) and BEFORE any seat or
  // turn: nothing runs here, the job is queued and the room is told where.
  const { routeDispatchToNode } = await import("~/modules/nodes/routing")
  const node = await routeDispatchToNode({
    orgId,
    threadId,
    calleeAgentId,
    callerAgentId,
    actorUserId: actor.userId,
    triggerMessageId: params.triggerMessageId,
    questionText: params.askedQuestion?.question ?? params.questionText,
    askedBy: params.askedQuestion?.askedBy ?? params.adderName,
    callerTaintScopes: params.callerTaintScopes,
  })
  if (node && !(node.kind === "queued" && node.interactive)) {
    const line =
      node.kind === "queued"
        ? `This went to ${node.on}. The answer will be posted here when it is done.`
        : DISPATCH_REFUSAL_LINES[node.reason]
    try {
      await runRls((db) =>
        postThreadSystemMessage(db, {
          orgId,
          threadId,
          actorUserId: actor.userId,
          authorName: params.adderName,
          content: line,
          replyRootId: params.replyRootId ?? null,
          metadata:
            node.kind === "queued"
              ? { nodeJobId: node.jobId, nodeQueued: true }
              : { nodeRefusal: node.reason },
        }),
      )
    } catch (err) {
      log.warn({ err, threadId, agentId: calleeAgentId }, "Posting the node routing line failed")
    }
  }
  if (node) {
    if (node.kind === "refused") return { allowed: false, reason: node.reason }
    return {
      ...verdict,
      nodeJob: { jobId: node.jobId, on: node.on, backlog: node.backlog },
    }
  }

  // S9's auto-add: a mentioned agent that is not in the room joins it, and the
  // room is told, BEFORE the agent answers.
  //
  // UNLESS an agent is the one addressing the colleague, by an `agents_ask` or
  // by naming it in a message: an agent never adds a participant on its own
  // (see `isGuestSeat`). The colleague answers as a GUEST instead: seated
  // silently for the turn, unseated when it settles.
  let guestSeated = false
  try {
    await runRls(async (db) => {
      const asGuest = isGuestSeat({ agentInitiated: Boolean(callerAgentId) })
      const seated = await addAgentParticipant(db, {
        orgId,
        threadId,
        agentId: calleeAgentId,
        actorUserId: actor.userId,
        // The seat is anchored at the MESSAGE that summoned the agent, not at
        // the wall clock of this insert: the mention was persisted first, so a
        // `now()` seat anchors past it and the agent renders a turn with no
        // user message in it.
        joinedAtMessageId: params.triggerMessageId,
        ...(asGuest ? { silent: true } : {}),
        // D23a: a seat an @mention made keeps the people's DM their DM.
        viaMention: true,
      })
      if (!seated) return
      // Only a seat THIS dispatch created is ever given back: an agent that was
      // already a member of the room stays one.
      if (asGuest) {
        guestSeated = true
        return
      }
      await postAgentAutoAddSystemMessage(db, {
        orgId,
        threadId,
        actorUserId: actor.userId,
        adderName: params.adderName,
        agentName: seated.agentName,
        // A mention made inside a reply is told in that reply thread (A7): a
        // line in the channel would surface a conversation the channel does
        // not show.
        replyRootId: params.replyRootId ?? null,
      })
    })
  } catch (err) {
    log.error({ err, threadId, agentId: calleeAgentId }, "Auto-add on mention failed")
  }

  // The guest seat's other half, defined HERE because every exit path from the
  // seat onwards owes it: the delegation refusal below THROWS past the chained
  // unseat, and `agents_ask` always states a ceiling, so that throw is the
  // everyday case rather than the exotic one.
  const unseatGuest = async () => {
    try {
      await runRls((db) =>
        removeAgentParticipant(db, {
          orgId,
          threadId,
          agentId: calleeAgentId,
          actorUserId: actor.userId,
          silent: true,
          // A seat somebody deliberately asked for meanwhile was PROMOTED out
          // of guest, and is left exactly where it is.
          onlyGuest: true,
        }),
      )
    } catch (err) {
      // Never thrown on: the answer is already in the room, and a seat that
      // outlives its turn is a defect to see in the log, not a failed turn.
      log.warn({ err, threadId, agentId: calleeAgentId }, "Removing the guest agent seat failed")
    }
  }

  // The lazy import is an exit path too: a module load that rejects after the
  // seat would leave a guest row in the DM for good.
  let invokeAgentForThread: AgentServiceModule["invokeAgentForThread"]
  try {
    ;({ invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service"))
  } catch (err) {
    if (guestSeated) await unseatGuest()
    throw err
  }
  // Only an AGENT to agent exchange nests. A human's mention leaves both fields
  // as they were, which is the flattened turn every existing caller writes.
  //
  // A HUMAN caller that STATES a ceiling nests and narrows the same way. That
  // is the MCP gateway's non agent-bound connection: its token reaches exactly
  // as far as the grantor allowed, and an agent it addresses from there must
  // not answer at its own, wider ceiling. A human caller that states NO ceiling
  // is the in-app HTTP route, which is left exactly as it was.
  let coordination: TurnCoordination | undefined
  // EVERY exit path from the seat onwards owes the guest seat back, and this
  // block has one that is not the turn: the delegation refusal THROWS, past
  // the unseat chained onto a turn that never starts.
  try {
    if (parentMessageId && (callerAgentId || params.callerEffectiveScope)) {
      coordination = { callerAgentId, parentMessageId }
      // THE QUESTION IS THE INSTRUCTION. Only a nested (ask) dispatch carries
      // one: a human `@mention` is flattened and its message already reaches
      // the turn as a `role: "user"` row. An asked agent's question does not,
      // so it is handed over here rather than left to be recovered from the
      // thread.
      if (params.askedQuestion) coordination.askedQuestion = params.askedQuestion
      // A4, through the helper that already exists. `delegateToAgent` loads the
      // callee's ceiling and intersects it with the caller's effective scope;
      // no second intersection and no second withheld computation is written
      // here.
      if (params.callerEffectiveScope) {
        try {
          const delegated = await runRls((db) =>
            delegateToAgent(db, orgId, params.callerEffectiveScope ?? [], calleeAgentId),
          )
          coordination.delegatedScope = delegated.effectiveScope
        } catch (err) {
          // The callee stopped being a live agent of this org between the guard
          // and here. Fail closed and LOUDLY: the alternative is running the
          // turn at the callee's own ceiling, which is the one thing A4
          // forbids. The question is already in the thread, so the room sees an
          // unanswered question rather than an over privileged answer.
          log.warn({ err, threadId, agentId: calleeAgentId }, "Delegation scope refused")
          throw new AgentDelegationUnavailableError(
            "the agent that was asked is no longer available to answer",
          )
        }
      }
      if (params.callerTaintScopes?.length) {
        coordination.callerTaintScopes = params.callerTaintScopes
      }
    }
  } catch (err) {
    if (guestSeated) await unseatGuest()
    throw err
  }

  const turn = withTurnFailureReported(
    invokeAgentForThread(
      threadId,
      params.triggerMessageId,
      actor,
      orgId,
      // foreground: a live @-mention keeps interactive worker-pool priority.
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      calleeAgentId,
      coordination,
      // A turn an agent started (its @mention, or `agents_ask` from any
      // caller) answers that caller, not a person: no "continue?" budget.
      params.turnContext || callerAgentId || params.askedQuestion
        ? {
            ...params.turnContext,
            agentDispatched: Boolean(callerAgentId || params.askedQuestion),
          }
        : undefined,
    ),
    {
      orgId,
      threadId,
      actorUserId: actor.userId,
      agentId: calleeAgentId,
      replyRootId: params.replyRootId ?? null,
    },
  )
  // THE UNSEAT IS CHAINED ONTO THE TURN, never left to the caller: `agents_ask`
  // races this promise against its own wait bound and returns on a timeout
  // while the turn keeps running, so a caller side unseat would miss exactly
  // the case that leaves a seat behind. Success, failure and post deadline
  // completion all pass through here, and the promise still resolves to what
  // the turn resolved to.
  if (!guestSeated) return { ...verdict, turn }
  const guestTurn = turn.then(
    async (result) => {
      await unseatGuest()
      return result
    },
    async (err) => {
      await unseatGuest()
      throw err
    },
  )
  return { ...verdict, turn: guestTurn }
}

/**
 * Is this dispatch an agent consulting a colleague? Then the seat is a GUEST
 * seat: taken silently for the one turn and given back when it settles.
 *
 * Every AGENT initiated dispatch counts, not only `agents_ask`: an agent that
 * @mentions a colleague in its own reply reaches the same seat through
 * `posted-message-dispatch`. An agent never adds a participant to a
 * conversation on its own, whatever the room: in a 1:1 DM a permanent seat
 * turns the private conversation into a group thread, and in a room with
 * people it adds a member nobody asked for (a support desk asking the finance
 * desk one question used to leave "Support Desk added Finance Desk" in the
 * room). Adding an agent for good is `agents_invite`, which asks a person
 * first.
 *
 * A HUMAN `@mention` seats the agent for good, because the person addressed it
 * and means to keep talking to it.
 */
function isGuestSeat(params: { agentInitiated: boolean }): boolean {
  return params.agentInitiated
}
