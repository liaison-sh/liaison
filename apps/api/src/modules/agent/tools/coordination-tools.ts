// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Agent to agent coordination, as MESSAGES (A30 point 2).
//
// `agents_ask` is thin sugar over the mention dispatch a human already drives:
// it posts the question as a nested, agent authored reply naming the callee,
// lets `dispatchAgentMention` run the callee's turn server side, and waits a
// bounded time for the answer. There is ONE persistence shape (a `messages` row
// with `author_agent_id` and a `parent_message_id`), ONE rendering, and every
// loop guard lives on the DISPATCH, so a plain human `@mention` chain is
// covered by the same rules. No second RPC path, no table of its own.

import { personalAgentLabel } from "@liaison/shared"
import { and, desc, eq, isNull } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { RlsClient } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { agents, messages, threads, users } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { EXTERNAL_CLIENT_POST_KEY } from "~/modules/agent/context/agent-attribution"
import { capabilityCategories } from "~/modules/agent/context/context"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { redactAgentsAskResult } from "~/modules/agent/scopes/tool-identifier-redaction"
import { agentPostRequiredScopes } from "~/modules/agent/tools/chat-tools"
import { DemoSpendHttpError } from "~/modules/demo/demo-spend"
import { findNodeRoute } from "~/modules/nodes/attachments"
import {
  AGENT_HOP_BOUND,
  AgentDelegationUnavailableError,
  type DispatchedTurnResult,
  dispatchAgentMention,
  evaluateAgentDispatch,
} from "~/modules/threads/agent-dispatch-guard"
import { postAgentAutoAddSystemMessage, sendMessage } from "~/modules/threads/message"
import {
  addAgentParticipant,
  listLiveAgentHandles,
  resolveLiveAgentByHandle,
  resolveSeatedAgentId,
} from "~/modules/threads/participant"
import { createOrGetAgentDm } from "~/modules/threads/thread"

const log = rootLogger.child({ module: "coordination-tools" })

/**
 * How long an ask waits for its answer before it hands the caller a pending
 * note instead. Under the 300,000 ms per turn timeout, so a waiting caller can
 * never outlive its own turn, and well above a flash-lite turn's observed cost.
 */
const AGENT_ASK_WAIT_MS_DEFAULT = 45_000
let agentAskWaitMs = AGENT_ASK_WAIT_MS_DEFAULT

/** The ctx `executeTool` hands a kernel tool handler. */
export interface CoordinationToolContext {
  userId: string
  orgId: string
  db: RlsClient
  /** The thread the agent loop is executing in. */
  agentExecutionThreadId?: string
  /** The calling actor's effective scopes, injected by executeTool. */
  scopes?: string[]
  /** The agent taking this turn (FX3-1), or the live frame's when absent. */
  actingAgentId?: string | null
  /** The acting user's dimension grants, for the transactions this tool opens. */
  dimensionGrants?: Record<string, string[]>
  /** Where this call came from, as `createAppContext` stamps it. "mcp" with no
   *  acting agent is a PERSON on an external client: the one caller that is
   *  neither an agent turn nor the in-app UI. */
  actorType?: "user" | "agent" | "mcp"
}

export interface AgentsAskResult {
  asked: boolean
  reason?: string
  answeredBy?: string
  answer?: string | null
  note?: string
  withheldCapabilities?: string[]
  /** Present with `reason: "insufficient_scope"`: the capability categories
   *  the callee's turn ran without, in a sentence the caller can act on. */
  missingAccess?: string
  /** On an unknown handle: the handles that do exist, so the caller can ask
   *  the one the person meant instead of reporting that nobody exists. */
  availableAgents?: string[]
  /** The conversation the question was posted in, so a caller with no room of
   *  its own (a person on an external client) can open it. */
  threadId?: string
  /** What the model must DO with this result. Present on EVERY result the ask
   *  produced: a result with no answer carries the no answer obligation, a
   *  result WITH one carries the relay obligation. */
  instruction?: string
  /** "queued" when the asked agent runs on someone's node (P4, A17, F14): the
   *  work became a node job and its answer is posted into this conversation
   *  when it ends (D22). "pending" when the asked agent is still answering at
   *  the wait bound: its answer is posted into this conversation when it ends.
   *  Absent on every result that came back within the bound. */
  status?: "queued" | "pending"
  /** The node job, with `status: "queued"`. */
  jobId?: string
  /** Where the job runs, with `status: "queued"` ("Olive's computer"). */
  on?: string
  /** Present when the handle named a COLLEAGUE'S personal agent: the person it
   *  acts for, with the mention token that addresses them in a reply. */
  person?: { name: string; mention: string }
}

/**
 * The sentence a result with no answer carries.
 *
 * Measured on the live walk: when an ask was withheld or cut, a flash-lite
 * caller returned a fabricated invoice total to the person in about half of
 * the runs. The machinery was right in every one of them (no tool ran, the
 * figure never reached the agent); what was missing was any statement of what
 * a failed ask OBLIGES. A refusal that only says "no" leaves the model to fill
 * the gap, so the result says the obligation in words the model reads.
 */
export const NO_ANSWER_INSTRUCTION =
  "You did not get an answer. Tell the person the question could not be answered and why. Never state a value you did not receive."

/**
 * The sentence a result WITH an answer carries.
 *
 * An answer that came back is not a licence to state a figure: measured on
 * prod, a caller asked a colleague how many orders were waiting to be packed,
 * received an answer about an unrelated ticket, and reported a number ("22")
 * that appears nowhere in the exchange. The no answer branch had an obligation
 * in words and this one had none, so the model treated "an answer arrived" as
 * "the question was answered". The relay rule says both halves: quote only
 * what is there, and say so when what is there is not what was asked.
 */
export const RELAY_INSTRUCTION =
  "Relay only what `answer` says. Never state a figure, count, status, date or name that does not appear in it, and never compute one. If `answer` does not address the question you asked, tell the person your colleague did not answer it and say what it replied instead."

/**
 * The sentence a queued result carries (F14). A queued ask has no answer YET,
 * and the model must say so rather than wait, retry or fill the gap.
 */
export const QUEUED_INSTRUCTION =
  "Your colleague runs on someone's computer: the work is queued there (see `on`) and its answer will be posted into this conversation when it is done (or a notice saying who can share it, when this conversation may not see it). Tell the person it was handed over and where. Do not ask again, and never state a result you did not receive."

/**
 * The sentence an ask still running at the wait bound carries. The asked agent
 * is still working and its answer (or its own word that it could not answer)
 * will be posted here, so the caller hands over. Told "the question could not
 * be answered" instead, a caller reported a missing answer while its colleague
 * was still writing it.
 */
export const PENDING_INSTRUCTION =
  "Your colleague is still working on it: its answer will be posted in this conversation when it is done. Tell the person you handed the question over and that the answer will appear here. Do not ask again, do not say no answer came, and never state a result you did not receive."

const NO_LIVE_AGENT = "no live agent with that handle"

/** An unknown handle is a wrong address, not an unanswerable question. */
export const UNKNOWN_HANDLE_INSTRUCTION =
  "No agent has that handle. If one of `availableAgents` is the agent the person meant, ask it with that handle. Otherwise tell the person which agents exist. Never state a value you did not receive."

/**
 * What an agent is told when the handle it reached for is a colleague's
 * PERSONAL agent. Asked to "answer tobias" in a task discussion, an agent asked
 * @tobias, Tobias's personal agent, which then replied as Tobias. A personal
 * agent acts for its owner alone; the person is answered in the conversation,
 * addressed to them.
 */
export const PERSON_NOT_AGENT_INSTRUCTION =
  "That handle is a colleague's own personal agent, not the colleague, and it acts only for them. To answer or ask that person, write your reply in this conversation addressed to them, with the mention in `person.mention` when one is given; never route it to their agent."

/** The refusal sentence, naming whose agent the handle is. */
export function colleaguePersonalAgentRefusal(person?: { name: string; mention: string }): string {
  if (!person) return COLLEAGUE_PERSONAL_AGENT_REFUSAL
  return `that handle is ${personalAgentLabel(person.name)}, which acts only for ${person.name}: address ${person.name} directly with ${person.mention} in your reply`
}

/** The refusal when the owner has no name to give: no person is invented. */
export const COLLEAGUE_PERSONAL_AGENT_REFUSAL =
  "that handle is a colleague's personal agent, which acts only for its owner: address that person directly in your reply"

/** The mention token that addresses a person, label escaped as the wire wants. */
function personMention(name: string, userId: string): string {
  return `@[${name.replace(/([[\]\\])/g, "\\$1")}](user:${userId})`
}

/**
 * A personal agent the CALLER does not own: the person it acts for, or null.
 * A personal agent is one colleague's own; the rest of the org neither
 * addresses it nor seats it (the app's own addressable rule, `listing.ts`).
 */
function isColleaguePersonalAgent(
  callee: { kind: string; ownerUserId: string | null },
  ctx: CoordinationToolContext,
): boolean {
  return callee.kind === "personal" && !!callee.ownerUserId && callee.ownerUserId !== ctx.userId
}

/** The person to address instead, or undefined when the owner has no name to give. */
function ownerToAddress(callee: {
  ownerUserId: string | null
  ownerName: string | null
}): { name: string; mention: string } | undefined {
  const name = callee.ownerName?.trim()
  return name && callee.ownerUserId
    ? { name, mention: personMention(name, callee.ownerUserId) }
    : undefined
}

/**
 * What an agent that asked ITSELF is told. It names the mistake in words the
 * model can act on rather than restating the rule: the handle it reached for is
 * its own, so the part of the message that handle covers is its own to answer.
 */
export const SELF_ASK_REFUSAL = "that handle is you: answer that part yourself instead of asking"

/**
 * The obligation a self ask carries. NOT the no answer sentence: that one
 * tells the model to report the question as unanswerable, which is exactly
 * wrong when the only thing missing is the agent doing the work itself. Seen in
 * production: a personal agent asked `@avery` (its own handle) in the DM it
 * was already answering in, got the no answer obligation, and told the person
 * the question could not be answered.
 */
export const SELF_ASK_INSTRUCTION =
  "You asked yourself: you are the agent with that handle. Do not call kernel__agents_ask for it again. Answer the person yourself, with your own tools, in this turn; if one of them refuses, tell the person what it said."
const ASK_PENDING_NOTE = "asked, answer pending in the thread"
const NO_ANSWER_NOTE = "asked, and the colleague finished without an answer"

/**
 * The sentence an ask the callee could not fully serve carries: which
 * capability categories its turn ran without, and why. The categories are the
 * public labels (A14), and the sentence tells the caller what to say.
 */
export function insufficientScopeNote(handle: string, categories: string[]): string {
  return `${handle} ran without access to: ${categories.join(", ")}. The person asking (or someone else in this conversation) is not granted it, so ${handle} could not use it. Tell the person which access was missing and that a workspace admin can grant it; do not guess the answer. Name the missing access only to the person who asked: if other people can read this conversation, say only that ${handle} could not answer and that access may be missing, because naming it reveals what someone here lacks.`
}

/**
 * Runs `fn` in an RLS transaction of its OWN, not the caller's.
 *
 * The ask has to COMMIT its question before the callee's turn can read it: that
 * turn runs on other connections, and a row still inside the tool call's open
 * transaction is invisible to every one of them (the callee's own reply then
 * fails the parent foreign key). So the question, the dispatch and the answer
 * read each take a transaction that ends, rather than riding the tool's.
 */
function runFresh<T>(ctx: CoordinationToolContext, fn: (db: RlsClient) => Promise<T>): Promise<T> {
  const actor: UserContext = {
    actorType: "user",
    userId: ctx.userId,
    orgId: ctx.orgId,
    scopes: ctx.scopes ?? [],
    dimensionGrants: ctx.dimensionGrants ?? {},
  }
  return withRlsContext(actor, fn)
}

/** The agent taking this turn, from the explicit hand off or the live frame. */
function callerAgentIdOf(ctx: CoordinationToolContext): string | null {
  return ctx.actingAgentId ?? currentRunContext()?.agentId ?? null
}

/**
 * Resolves once the callee's turn has finished, or once the wait bound expires,
 * whichever comes first. `invokeAgentForThread` resolves AFTER its finalize has
 * persisted the answer, so the turn promise IS the completion signal and there
 * is nothing to poll. The deadline is computed at entry, so a slow callee can
 * delay the answer but can never hang the caller's turn.
 */
async function raceTurnAgainstDeadline<T>(
  turn: Promise<T>,
): Promise<{ outcome: "answered"; result: T | null } | { outcome: "timeout" }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<{ outcome: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "timeout" }), agentAskWaitMs)
    // A pending deadline must never be the reason the process stays alive.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  try {
    return await Promise.race([
      turn.then(
        (result) => ({ outcome: "answered" as const, result }),
        // A turn that threw still answered as far as the wait is concerned:
        // whatever it persisted is what the thread holds.
        () => ({ outcome: "answered" as const, result: null }),
      ),
      deadline,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The newest thing the callee said under the question, or null, WITH the scope
 * tag that answer carries.
 *
 * The tag is not decoration: whatever the callee's turn touched is about to be
 * quoted inside the caller's own reply, so by A2 the caller's reply must carry
 * those scopes too (see `recordAnswerTaint`). Reading the content without the
 * tag is what made an invoice total come back to @support tagged
 * `kernel:threads:write` (T26 F7).
 */
async function readAnswer(
  db: RlsClient,
  params: { orgId: string; calleeAgentId: string; questionMessageId: string },
): Promise<{ content: string; requiredScopes: string[] } | null> {
  const [row] = await db
    .select({ content: messages.content, requiredScopes: messages.requiredScopes })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, params.orgId),
        eq(messages.parentMessageId, params.questionMessageId),
        eq(messages.authorAgentId, params.calleeAgentId),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1)
  return row ? { content: row.content, requiredScopes: row.requiredScopes ?? [] } : null
}

/** What a settled ask left behind: the turn's result, why it failed, the answer. */
interface AskSettlement {
  turnResult: DispatchedTurnResult | null
  /** Why the asked agent's turn ended without running, in words a person may read. */
  failure: string | null
  answer: { content: string; requiredScopes: string[] } | null
}

/** What the asked agent says when its turn failed for a reason not meant for the room. */
export const ASK_TURN_FAILED_REASON = "my turn failed before I could answer"

/**
 * The reason a failed callee turn is reported with. Only the errors written
 * for a person (the turn's own refusals: out of usage, a demo budget, a
 * delegation that fell through) are quoted; anything else is a fault whose
 * text belongs in the log, not in the conversation.
 */
function askFailureReason(err: unknown): string {
  if (
    err instanceof HTTPException ||
    err instanceof DemoSpendHttpError ||
    err instanceof AgentDelegationUnavailableError
  ) {
    const text = err.message.trim()
    if (text.length > 0) return text
  }
  return ASK_TURN_FAILED_REASON
}

/** The asked agent's own word when its turn ended without an answer. */
export function askUnansweredNotice(params: { failure: string | null; withheld: boolean }): string {
  if (params.failure) return `I could not answer this question: ${params.failure}`
  if (params.withheld) {
    return "I could not answer this question here: some of the access it needs is not available in this conversation."
  }
  return "I could not answer this question: my turn ended without an answer."
}

/**
 * Waits for the asked agent's turn to END, then makes sure the thread holds
 * its word on the question.
 *
 * THE ASKED AGENT ALWAYS ANSWERS. A turn can end without writing anything
 * under the question: refused before it started (out of usage, a spending
 * budget), failed, or finished blank. Before this, such a turn left only a
 * transient failure frame, so the room read a question nobody answered and the
 * asking agent, told the answer was "pending", reported that no answer had
 * come "yet". Now the asked agent's turn closes with a reply in its OWN name
 * (author_agent_id is the asked agent, never a person) saying it could not
 * answer and why. Never throws: it runs after the caller may have stopped
 * waiting, on a turn whose failure is already reported.
 */
async function settleAsk(
  ctx: CoordinationToolContext,
  params: {
    turn: Promise<DispatchedTurnResult>
    threadId: string
    callee: { id: string; displayName: string }
    questionMessageId: string
  },
): Promise<AskSettlement> {
  let turnResult: DispatchedTurnResult | null = null
  let failure: string | null = null
  try {
    turnResult = await params.turn
  } catch (err) {
    failure = askFailureReason(err)
  }
  let answer: AskSettlement["answer"] = null
  try {
    answer = await runFresh(ctx, (db) =>
      readAnswer(db, {
        orgId: ctx.orgId,
        calleeAgentId: params.callee.id,
        questionMessageId: params.questionMessageId,
      }),
    )
  } catch (err) {
    log.warn({ err, threadId: params.threadId }, "Reading the asked agent's answer failed")
  }
  if (answer) return { turnResult, failure: null, answer }
  try {
    await runFresh(ctx, (db) =>
      sendMessage(db, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        threadId: params.threadId,
        content: askUnansweredNotice({
          failure,
          withheld: (turnResult?.withheldCapabilities?.length ?? 0) > 0,
        }),
        authorType: "agent" as const,
        agentId: params.callee.id,
        agentAuthorLabel: params.callee.displayName,
        // It says only that there is no answer: nothing the room may not read.
        requiredScopes: [],
        parentMessageId: params.questionMessageId,
        metadata: { askUnanswered: true },
      }),
    )
  } catch (err) {
    log.warn(
      { err, threadId: params.threadId, calleeAgentId: params.callee.id },
      "Posting the asked agent's no answer reply failed",
    )
  }
  return { turnResult, failure, answer: null }
}

/**
 * Union an answer's own scopes into the CALLER's turn, so the caller's reply is
 * tagged with what it is about to quote (spec-security.md D3/A2: a turn's
 * requiredScopes are its tools' scopes PLUS the scopes of every tagged item
 * injected into it, and an answer read back from another agent is such an item).
 *
 * Not a disclosure decision, and now the load-bearing one: by A4 the callee
 * ran at ITS OWN ceiling ∩ the originating requester's grants ∩ the room floor,
 * which can exceed the caller's own ceiling. So the caller may now hold data
 * under a scope it lacks. The requester and every room member are entitled to
 * it (the room floor bounds the callee); what keeps it from leaking further is
 * this tag: the caller's reply carries the answer's scopes (what the room's
 * later joiners, thread search, Meili and the per chunk websocket predicate
 * read), and the scope-taint rule judges every later write of the caller's
 * turn against them.
 */
function recordAnswerTaint(scopes: string[] | undefined): void {
  if (!scopes || scopes.length === 0) return
  currentRunContext()?.turnScopeAccumulator?.recordInjected(scopes)
}

/** True when `threadId` is a 1:1 agent chat whose one seated agent is `agentId`. */
async function isAgentDmOf(
  ctx: CoordinationToolContext,
  threadId: string,
  agentId: string,
): Promise<boolean> {
  const [thread] = await runFresh(ctx, (db) =>
    db
      .select({ type: threads.type })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.orgId, ctx.orgId)))
      .limit(1),
  )
  if (thread?.type !== "agent_chat") return false
  const seated = await runFresh(ctx, (db) =>
    resolveSeatedAgentId(db, { orgId: ctx.orgId, threadId }),
  )
  return seated === agentId
}

/** The asking person's name, for the callee's framing of the question. */
/** "{User}'s agent": the label every agent post made for a person carries. */
async function externalAgentLabel(ctx: CoordinationToolContext): Promise<string> {
  const [row] = await runFresh(ctx, (db) =>
    db
      .select({ name: users.name })
      .from(users)
      .where(and(eq(users.id, ctx.userId), eq(users.orgId, ctx.orgId)))
      .limit(1),
  )
  return `${row?.name?.trim() || "User"}'s agent`
}

async function personLabel(ctx: CoordinationToolContext): Promise<string> {
  const [row] = await runFresh(ctx, (db) =>
    db
      .select({ name: users.name })
      .from(users)
      .where(and(eq(users.id, ctx.userId), eq(users.orgId, ctx.orgId)))
      .limit(1),
  )
  const name = row?.name?.trim()
  return name
    ? `${name} (the person you work for, writing from an external app)`
    : "The person you work for, writing from an external app"
}

/**
 * The one exit of `agents_ask`.
 *
 * Two things every result passes through, whichever branch produced it:
 * every STRING it carries (the answer, the refusal reason, the pending note) is
 * scrubbed of the tool identifiers this org registered, the kernel's own
 * included (a machine name in the callee's own prompt otherwise comes back out
 * of it and reaches a person), and a result carrying no answer is told, in
 * words, that it must be reported rather than filled in.
 */
export async function handleAgentsAsk(
  params: { agentHandle: string; question: string },
  ctx: CoordinationToolContext,
): Promise<AgentsAskResult> {
  const scrubbed = redactAgentsAskResult(await askAgent(params, ctx), ctx.orgId)
  // THE THREAD ID IS FOR A PERSON WITH NO ROOM. An agent asks in the room it is
  // already in, so the id told it nothing, and the live walk caught an agent
  // writing it into a mention as the colleague's id (`@[data](user:<thread>)`).
  const { threadId, ...rest } = scrubbed
  const forPerson = !callerAgentIdOf(ctx) && ctx.actorType === "mcp"
  return {
    ...rest,
    ...(forPerson && threadId ? { threadId } : {}),
    instruction:
      scrubbed.status === "queued"
        ? QUEUED_INSTRUCTION
        : scrubbed.status === "pending"
          ? PENDING_INSTRUCTION
          : scrubbed.answer
            ? RELAY_INSTRUCTION
            : scrubbed.person || scrubbed.reason === COLLEAGUE_PERSONAL_AGENT_REFUSAL
              ? PERSON_NOT_AGENT_INSTRUCTION
              : scrubbed.reason === SELF_ASK_REFUSAL
                ? SELF_ASK_INSTRUCTION
                : scrubbed.availableAgents?.length
                  ? UNKNOWN_HANDLE_INSTRUCTION
                  : NO_ANSWER_INSTRUCTION,
  }
}

async function askAgent(
  params: { agentHandle: string; question: string },
  ctx: CoordinationToolContext,
): Promise<AgentsAskResult> {
  const callerAgentId = callerAgentIdOf(ctx)
  // A PERSON asking, from a connection bound to no agent (A30 point 1 covers
  // `agents_invite`, which seats an agent in a room the caller is in; an ask
  // has a room of its own). Anything else with no acting agent is a turn that
  // could not say who it is, and it asks nobody.
  const humanCaller = !callerAgentId && ctx.actorType === "mcp"
  if (!callerAgentId && !humanCaller) {
    return { asked: false, reason: "only an agent can ask another agent" }
  }

  // 1. Resolve, fail closed. Zero rows and two rows are both a refusal.
  const callee = await resolveLiveAgentByHandle(ctx.db, {
    orgId: ctx.orgId,
    handle: params.agentHandle,
  })
  if (!callee) {
    return {
      asked: false,
      reason: NO_LIVE_AGENT,
      availableAgents: await listLiveAgentHandles(ctx.db, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        excludeAgentId: callerAgentId ?? null,
      }),
    }
  }

  // THE SELF ASK. Named by HANDLE rather than only by id, because that is how
  // the model reaches for it: addressed in a message that listed its own handle
  // beside a colleague's, a weak model asks "@finance" and reports the answer as
  // though a colleague had given it. The refusal says who that handle is, so the
  // next step is to answer rather than to ask again.
  // Checked FIRST, before a conversation is resolved or opened: a self ask
  // posts nothing and opens nothing, wherever the turn runs.
  if (callee.id === callerAgentId) {
    return { asked: false, reason: SELF_ASK_REFUSAL }
  }

  // A COLLEAGUE'S PERSONAL AGENT is not the colleague. Refused before anything
  // is posted, with the person to address instead, UNLESS its owner attached
  // it to their node and listed this requester (A17): that allowlist is the
  // owner's own word on who may ask it, and the dispatch routes it there.
  if (isColleaguePersonalAgent(callee, ctx)) {
    const route = await findNodeRoute({
      orgId: ctx.orgId,
      agentId: callee.id,
      requesterUserId: ctx.userId,
      requesterAgentId: callerAgentId ?? null,
    })
    if (!route) {
      const person = ownerToAddress(callee)
      return {
        asked: false,
        reason: colleaguePersonalAgentRefusal(person),
        ...(person ? { person } : {}),
      }
    }
  }

  // WHERE THE QUESTION GOES. An agent asks in the conversation it is taking a
  // turn in. A person has no such conversation, so the question goes where the
  // web app puts a question to a named agent: their own 1:1 with it, resolved
  // (or opened) through the SAME helper the DM button calls, never a second way
  // of making one.
  const threadId = humanCaller
    ? (
        (await runFresh(ctx, (db) =>
          createOrGetAgentDm(db, { orgId: ctx.orgId, userId: ctx.userId, agentId: callee.id }),
        )) ?? null
      )?.id
    : ctx.agentExecutionThreadId
  if (!threadId) {
    return { asked: false, reason: "this turn has no conversation to ask in" }
  }
  // 2. One outstanding ask per turn.
  const frame = currentRunContext()
  if (frame?.agentAskInFlight) {
    return { asked: false, reason: "an earlier question is still waiting for its answer" }
  }

  // WHAT THE QUESTION ROW IS TAGGED WITH. For an AGENT this is taint: what that
  // turn has already READ, so the room reads its question under the same floor
  // as the data behind it. A PERSON on an external client has read nothing: the
  // question is their own words, and `agentPostRequiredScopes` has no turn to
  // measure, so it falls through to the connection's own scope list. An owner
  // token carries `*`, and the callee then runs at that list INTERSECTED with
  // its own ceiling, which never covers `*`: its own question was filtered out
  // of its context and it answered the message above it instead. A person's
  // question is tagged exactly as the in-app thread route tags it: with nothing.
  const requiredScopes = humanCaller ? [] : agentPostRequiredScopes(ctx)
  if (requiredScopes === null) {
    return {
      asked: false,
      reason: "this agent turn's scope taint is unknown, so the question was not posted",
    }
  }

  // The question exactly as the room will read it. `sendMessage` takes no
  // mentions parameter: the mention is parsed out of the CONTENT, so the token
  // is built literally here. The guard is handed this same string, because the
  // dedupe compares it against what earlier siblings actually say.
  //
  // NO MENTION IN THE CALLEE'S OWN 1:1. In a DM whose only agent is the callee
  // there is nobody else it could address, so the chip was noise the person
  // read above their own question (and the dispatch below names the callee
  // explicitly; it never needed the token to find it).
  const inCalleeDm = await isAgentDmOf(ctx, threadId, callee.id)
  const content = inCalleeDm
    ? params.question
    : `@[${callee.displayName}](agent:${callee.id}) ${params.question}`

  // 3. The guard, BEFORE the question is posted. The dispatch runs it again and
  //    is the authority; this pass exists so a question that is going to be
  //    refused is never posted at all. It reads the chain above the caller's
  //    own turn, and the question about to be written is the next agent link in
  //    it, which is the `+ 1`.
  const parentForChain = currentRunContext()?.turnMessageId ?? null
  const pre = await evaluateAgentDispatch(ctx.db, {
    orgId: ctx.orgId,
    threadId,
    parentMessageId: parentForChain,
    callerAgentId,
    calleeAgentId: callee.id,
    questionText: content,
    ...(parentForChain ? { triggerMessageId: parentForChain } : {}),
  })
  if (!pre.allowed) {
    if (pre.reason === "duplicate_ask") {
      // The answer to the question this one REPEATS, read under that question.
      // The guard already carries it when it exists; the re-read covers an
      // answer that landed between the guard's read and this line.
      const reread = pre.earlierAnswer
        ? null
        : await readAnswer(ctx.db, {
            orgId: ctx.orgId,
            calleeAgentId: callee.id,
            questionMessageId: pre.earlierQuestionId,
          })
      const standing = pre.earlierAnswer ?? reread?.content ?? null
      recordAnswerTaint(pre.earlierAnswer ? pre.earlierAnswerScopes : reread?.requiredScopes)
      return { asked: false, reason: pre.reason, answer: standing }
    }
    return { asked: false, reason: pre.reason }
  }
  if (pre.hopDepth + 1 >= AGENT_HOP_BOUND) {
    return { asked: false, reason: "hop_bound" }
  }

  const [caller] = callerAgentId
    ? await ctx.db
        .select({ displayName: agents.displayName })
        .from(agents)
        .where(and(eq(agents.id, callerAgentId), eq(agents.orgId, ctx.orgId)))
        .limit(1)
    : [undefined]
  // WHO ASKED, as the callee is told. A person on an external client is the
  // person, never "A colleague": framed as a colleague's question, the
  // personal agent answering its owner's own question told them it came "from
  // another agent" and tried to ask that agent back, which was itself.
  const askedBy = humanCaller ? await personLabel(ctx) : (caller?.displayName ?? "A colleague")

  const externalLabel = humanCaller ? await externalAgentLabel(ctx) : undefined

  if (frame) frame.agentAskInFlight = true
  try {
    // 4. Post the question through the ONE writer.
    const questionMsg = await runFresh(ctx, (db) =>
      sendMessage(db, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        threadId,
        content,
        // NEVER AUTHORED AS THE PERSON. A person's external client is a model
        // writing for them, so its question is "{User}'s agent"'s, marked as an
        // external-client post: the callee reads it as a request (and is framed
        // on `askedQuestion` below), never as the person's own words.
        authorType: "agent" as const,
        ...(callerAgentId
          ? { agentId: callerAgentId, agentAuthorLabel: caller?.displayName }
          : {
              agentAuthorLabel: externalLabel,
              metadata: { [EXTERNAL_CLIENT_POST_KEY]: true },
            }),
        requiredScopes,
        // The caller's own turn message. Absent (an external MCP turn has no
        // triggering message) the question is the root of its own chain.
        parentMessageId: parentForChain,
      }),
    )
    if (!questionMsg) {
      return { asked: false, reason: "this agent is not a participant of this conversation" }
    }

    // 5. Dispatch. The callee's whole turn nests under the QUESTION, which is
    //    what makes the ask chain exactly one link per hop.
    const outcome = await dispatchAgentMention((fn) => runFresh(ctx, fn), {
      orgId: ctx.orgId,
      threadId,
      calleeAgentId: callee.id,
      callerAgentId,
      parentMessageId: questionMsg.id,
      triggerMessageId: questionMsg.id,
      questionText: params.question,
      actor: {
        userId: ctx.userId,
        orgId: ctx.orgId,
        scopes: ctx.scopes ?? [],
        dimensionGrants: ctx.dimensionGrants ?? {},
      },
      adderName: caller?.displayName ?? "An agent",
      // THE ASK'S INSTRUCTION. The question row is authored by an AGENT, so
      // the callee's transcript renders it as that agent's own speech and the
      // callee is left with no request at all; worse, a question tagged with
      // the caller's taint can be filtered out of the callee's own context
      // before it gets that far. Handed over as a value, so the callee's turn
      // is framed on the question rather than on the thread it landed in.
      askedQuestion: {
        askedBy,
        question: params.question,
      },
      // A4, the delegation bound, and the taint. The callee runs at ITS OWN
      // ceiling intersected with the grants of the PERSON the request
      // originates from: exactly what that person gets addressing the callee
      // directly, never more than either. Bounding it by the ASKING agent's
      // ceiling instead made the entry point useless: @base asking @data
      // handed @data @base's empty KPI reach, so nobody could answer a data
      // question put to @base. `ctx.scopes` is the requester's grants as far
      // as this connection reaches (the in-app actor's, or an external
      // token's own list), carried unchanged down every hop of a chain. The
      // room floor still applies on the callee's side (agent-service), and
      // the caller's taint rides along below, so a write is judged exactly
      // as before. A ROUTINE TICK has no person behind it: it keeps the
      // caller's own effective scope, the bound it always had.
      ...(frame?.routineId && frame.effectiveScope
        ? { callerEffectiveScope: frame.effectiveScope }
        : frame?.effectiveScope || humanCaller
          ? { callerEffectiveScope: ctx.scopes ?? [] }
          : {}),
      ...(requiredScopes.length > 0 ? { callerTaintScopes: requiredScopes } : {}),
    })
    if (!outcome.allowed) {
      // A deduped ask hands back the standing answer rather than nothing: a
      // refusal that returns nothing is what makes a model ask a third time.
      if (outcome.reason === "duplicate_ask") {
        recordAnswerTaint(outcome.earlierAnswerScopes)
        return { asked: false, reason: outcome.reason, answer: outcome.earlierAnswer }
      }
      return { asked: false, reason: outcome.reason }
    }

    // 5b. Handed to a node (A17): nothing to wait for. The asker gets the
    //     receipt now; the answer is posted into this conversation later (D22).
    if (outcome.nodeJob) {
      return {
        asked: true,
        answeredBy: callee.handle,
        answer: null,
        status: "queued",
        jobId: outcome.nodeJob.jobId,
        on: outcome.nodeJob.on,
        note: `queued on ${outcome.nodeJob.on}`,
        threadId,
      }
    }

    // 6. Wait, bounded, on the SETTLED ask rather than on the bare turn: the
    //    settle is chained onto the turn, so an ask that outlives the bound
    //    still ends with the asked agent's word in the thread.
    const raced = await raceTurnAgainstDeadline(
      settleAsk(ctx, {
        turn: outcome.turn,
        threadId,
        callee,
        questionMessageId: questionMsg.id,
      }),
    )
    if (raced.outcome === "timeout") {
      log.warn({ threadId, calleeAgentId: callee.id }, "agents_ask reached its wait bound")
      return {
        asked: true,
        answeredBy: callee.handle,
        answer: null,
        status: "pending",
        note: ASK_PENDING_NOTE,
        threadId,
      }
    }
    const settled = raced.result
    recordAnswerTaint(settled?.answer?.requiredScopes)
    const answer = settled?.answer?.content ?? null
    // D2: what the intersection took away, as the CATEGORIES the turn itself
    // reported. Never recomputed here: a second, parallel computation is
    // exactly the drift A14 exists to prevent, and the raw scope names are
    // private to the requester either way.
    const withheld = capabilityCategories(settled?.turnResult?.withheldCapabilities ?? [])
    // AN ASK THE CALLEE COULD NOT FULLY SERVE SAYS SO, IN WORDS. A bare
    // `withheldCapabilities` list beside a null answer read as "no answer yet"
    // and the caller invented a cause. The result names what was missing (the
    // category labels, never a raw scope: A14) and marks the reason.
    const withheldPart =
      withheld.length > 0
        ? {
            withheldCapabilities: withheld,
            reason: "insufficient_scope",
            missingAccess: insufficientScopeNote(callee.handle, withheld),
          }
        : {}
    if (answer === null) {
      // The asked agent's turn is OVER and left no answer: nothing is pending.
      // Saying "answer pending" here is what let a caller tell the person, one
      // second after asking, that no answer had come back "yet".
      return {
        asked: true,
        answeredBy: callee.handle,
        answer: null,
        note: settled?.failure ? `${NO_ANSWER_NOTE}: ${settled.failure}` : NO_ANSWER_NOTE,
        threadId,
        ...(settled?.failure && withheld.length === 0 ? { reason: "callee_turn_failed" } : {}),
        ...withheldPart,
      }
    }
    return { asked: true, answeredBy: callee.handle, answer, threadId, ...withheldPart }
  } finally {
    if (frame) frame.agentAskInFlight = false
  }
}

const NO_LIVE_AGENT_OR_SEATED = "no live agent with that handle, or already in this conversation"

export interface AgentsInviteResult {
  invited: boolean
  reason?: string
  message?: string
}

type InviteCheck =
  | {
      ok: true
      threadId: string
      callerAgentId: string
      callee: { id: string; handle: string; displayName: string }
    }
  | { ok: false; reason: string }

/** Whether this invite can be carried out at all: the same answer at the gate and after the approval. */
async function checkAgentsInvite(
  params: { agentHandle: string },
  ctx: CoordinationToolContext,
): Promise<InviteCheck> {
  const threadId = ctx.agentExecutionThreadId
  if (!threadId) return { ok: false, reason: "this turn has no conversation to invite into" }
  const callerAgentId = callerAgentIdOf(ctx)
  if (!callerAgentId) return { ok: false, reason: "only an agent can invite another agent" }
  const callee = await resolveLiveAgentByHandle(ctx.db, {
    orgId: ctx.orgId,
    handle: params.agentHandle,
  })
  if (!callee) return { ok: false, reason: NO_LIVE_AGENT_OR_SEATED }
  if (callee.id === callerAgentId) return { ok: false, reason: NO_LIVE_AGENT_OR_SEATED }
  // A colleague's personal agent is theirs alone: never seated by anyone else.
  if (isColleaguePersonalAgent(callee, ctx)) {
    return { ok: false, reason: colleaguePersonalAgentRefusal(ownerToAddress(callee)) }
  }
  return {
    ok: true,
    threadId,
    callerAgentId,
    callee: { id: callee.id, handle: callee.handle, displayName: callee.displayName },
  }
}

async function agentDisplayName(
  db: RlsClient,
  orgId: string,
  agentId: string | null | undefined,
): Promise<string | null> {
  if (!agentId) return null
  const [row] = await db
    .select({ displayName: agents.displayName })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .limit(1)
  return row?.displayName ?? null
}

/**
 * The gate's check: an invite that could never be carried out is refused at
 * once, so nobody is asked to approve adding an agent that cannot be added.
 */
export async function agentsInvitePreflight(
  params: { agentHandle: string },
  ctx: CoordinationToolContext,
): Promise<unknown> {
  const check = await checkAgentsInvite(params, ctx)
  if (!check.ok) return { error: { code: "INVITE_REFUSED", message: check.reason } }
  return { ok: true }
}

/**
 * The inline approval card: "Support Desk wants to add Finance Desk to this
 * discussion". An agent never adds a participant on its own; the person it
 * works for decides, in the conversation.
 */
export async function summarizeAgentsInvite(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; actingAgentId?: string | null },
): Promise<{ kind: string; title: string; impact: "internal"; lines: string[] }> {
  const p = (params ?? {}) as { agentHandle?: string; reason?: string }
  const callee = p.agentHandle
    ? await resolveLiveAgentByHandle(ctx.tx, { orgId: ctx.orgId, handle: p.agentHandle })
    : null
  const caller =
    (await agentDisplayName(
      ctx.tx,
      ctx.orgId,
      ctx.actingAgentId ?? currentRunContext()?.agentId,
    )) ?? "An agent"
  const calleeName = callee?.displayName ?? p.agentHandle ?? "another agent"
  const reason = p.reason?.trim()
  return {
    kind: "agents_invite",
    title: `${caller} wants to add ${calleeName} to this discussion`,
    impact: "internal",
    lines: reason ? [reason] : [],
  }
}

/**
 * Seat another agent in this conversation, and nothing more. GATED: the tool
 * is registered `gated` + `noAutoApprove`, so this handler runs only after a
 * person approved the inline ask; it then posts "{caller} added {agent}".
 *
 * Inviting starts NO turn (S12: an agent speaks only when prompted), so the
 * three paths stay consistent by construction: ask is a guest seat plus
 * dispatch, mention is seat plus dispatch, invite is seat alone. The refusal
 * shapes come from `addAgentParticipant` itself, which already returns null for
 * missing, archived, foreign org and already seated.
 */
export async function handleAgentsInvite(
  params: { agentHandle: string; reason?: string },
  ctx: CoordinationToolContext,
): Promise<AgentsInviteResult> {
  const check = await checkAgentsInvite(params, ctx)
  if (!check.ok) return { invited: false, reason: check.reason }
  const { threadId, callerAgentId, callee } = check
  const callerName = await agentDisplayName(ctx.db, ctx.orgId, callerAgentId)

  const seated = await runFresh(ctx, async (db) => {
    const added = await addAgentParticipant(db, {
      orgId: ctx.orgId,
      threadId,
      agentId: callee.id,
      actorUserId: ctx.userId,
    })
    if (!added) return null
    await postAgentAutoAddSystemMessage(db, {
      orgId: ctx.orgId,
      threadId,
      actorUserId: ctx.userId,
      adderName: callerName ?? "An agent",
      agentName: added.agentName,
    })
    return added
  })
  if (!seated) return { invited: false, reason: NO_LIVE_AGENT_OR_SEATED }

  log.info({ threadId, agentId: callee.id, reason: params.reason }, "Agent invited to a thread")
  return {
    invited: true,
    message: "Agent seated. Mention it or use kernel__agents_ask when you want it to answer.",
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const CoordinationToolsTestAccess = {
  /**
   * Shortens the wait for a test that has to observe the timeout branch. The same
   * seam `AgentServiceTestAccess.setStreamText` covers, for the same reason: waiting
   * 45 real seconds to watch a deadline fire is not a test, it is a stall. Call with
   * no argument to restore the shipped value.
   */
  setAgentAskWait(ms?: number): void {
    agentAskWaitMs = ms ?? AGENT_ASK_WAIT_MS_DEFAULT
  },
}
