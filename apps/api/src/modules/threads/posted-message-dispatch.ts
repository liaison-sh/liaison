// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a POSTED message triggers, in one place.
//
// The rule is a property of the MESSAGE, not of the surface that wrote it: a
// message that names live agents runs their turns, and a message in a 1:1 agent
// chat that names nobody runs the agent seated there. The thread route has done
// this since S12; `threads_reply` posted the identical row and dispatched
// nobody, so a person on an external MCP client could write into their own DM
// with an agent and never get an answer.
//
// Extracted rather than copied, because two copies of a dispatch decision is
// how one of them ends up skipping the guard (`dispatchAgentMention` is still
// THE one dispatch path; this only decides WHO is dispatched).
import type { RlsClient } from "~/db"
import { withRlsContext } from "~/db/rls"
import { rootLogger } from "~/lib/logger"
import { readiness } from "~/lib/readiness"
import { writeAuditLog } from "~/modules/audit/service"
import {
  type AgentTurnContext,
  dispatchAgentMention,
  withTurnFailureReported,
} from "~/modules/threads/agent-dispatch-guard"
import { resolveLiveAgentIds, resolveSeatedAgentId } from "~/modules/threads/participant"

const log = rootLogger.child({ module: "posted-message-dispatch" })

/** The audit action for a turn its sender said runs on their own machine. */
export const DISPATCH_SKIPPED_SENDER_LOCAL = "agent.dispatch.skipped_sender_local"

/** The row that was just written, as `sendMessage` hands it back. */
export interface PostedMessage {
  id: string
  content: string
  mentions: unknown
  authorAgentId?: string | null
  authorName: string
  parentMessageId?: string | null
  /** The reply thread the message was posted in (0112), null in the channel. */
  replyRootId?: string | null
  threadType?: string
}

export interface PostedMessageDispatchParams {
  orgId: string
  threadId: string
  message: PostedMessage
  actor: {
    userId: string
    orgId: string
    scopes: string[]
    dimensionGrants?: Record<string, string[]>
    /** The poster's role ids, for the RLS role GUC when the dispatch runs in a job. */
    roles?: string[]
  }
  turnContext?: AgentTurnContext
  /**
   * The A4 ceiling the caller states for every turn it starts. An external
   * connection passes its own effective scope; the in-app route passes nothing
   * and the agent runs at its own, exactly as it always has.
   */
  callerEffectiveScope?: string[]
  /**
   * The agent whose turn for this message runs on the SENDER'S machine (the
   * desktop's "This machine" runtime). Never dispatched here, claim or no
   * claim: a local conversation answered by the server is a second reply on
   * the wrong model, from a runtime that cannot see the user's folder.
   */
  localAgentId?: string
}

/**
 * Dispatches the agents a just-posted message addresses. Returns the ids it
 * dispatched, so a caller can report them; the turns themselves are fire and
 * forget, as they have always been on the thread route.
 */
export async function dispatchForPostedMessage(
  runRls: <T>(fn: (db: RlsClient) => Promise<T>) => Promise<T>,
  params: PostedMessageDispatchParams,
  opts: {
    /**
     * This is the agent-turn-dispatch job itself (runDeferredTurnDispatch).
     * It started before the drain (no job starts after it) and holds the
     * `dispatch:<messageId>` id while it runs, so a re-enqueue under that id
     * would be dropped: it dispatches here, and the turn drain waits for it.
     */
    deferred?: boolean
  } = {},
): Promise<{ dispatchedAgentIds: string[] }> {
  // A process shutting down starts no turn (S9 step 5): the whole dispatch is
  // handed to a live worker, which runs it exactly as it would have run here.
  // A delay of one job pickup; with no other worker (a single container), the
  // job waits in Redis for the next boot.
  if (readiness().status === "draining" && !opts.deferred) {
    await enqueueDispatch(TURN_DISPATCH_JOB, toJobPayload(params), `dispatch:${params.message.id}`)
    log.info(
      { threadId: params.threadId, messageId: params.message.id },
      "Agent dispatch handed to a live worker: this process is shutting down",
    )
    return { dispatchedAgentIds: [] }
  }
  const { orgId, threadId, message, actor, turnContext, localAgentId } = params
  /**
   * Whether this agent's turn is the sender's machine's, saying so in the audit
   * when it is. A different action from the claim's own skip on purpose: the
   * lapse sweep answers what the CLAIM held back, and a message its sender
   * sent to run locally is never the server's to answer, lapse or not.
   */
  const runsLocally = async (agentId: string | null): Promise<boolean> => {
    if (!localAgentId) return false
    if (agentId !== null && agentId !== localAgentId) return false
    log.info({ threadId, agentId }, "Agent dispatch skipped: the sender runs this turn locally")
    try {
      // An audit row needs no bypass: the system audit context inserts it
      // bound to this org (audit_log_insert_rls).
      await withRlsContext({ actorType: "system", orgId, purpose: "audit" }, (db) =>
        writeAuditLog(db, {
          orgId,
          actorId: actor.userId,
          actorType: "user",
          app: "kernel",
          entityType: "message",
          entityId: message.id,
          action: DISPATCH_SKIPPED_SENDER_LOCAL,
          agentId: agentId ?? localAgentId,
          metadata: { threadId, runLocation: "local" },
        }),
      )
    } catch (err) {
      log.warn({ err, threadId }, "Auditing the sender-local skip failed")
    }
    return true
  }
  const mentionedAgentIds = Array.isArray(message.mentions)
    ? [
        ...new Set(
          (message.mentions as Array<{ type: string; id?: string }>)
            .filter((m) => m.type === "agent" && typeof m.id === "string")
            .map((m) => m.id as string),
        ),
      ]
    : []
  const isAgentChat = message.threadType === "agent_chat"
  if (mentionedAgentIds.length === 0 && !isAgentChat) return { dispatchedAgentIds: [] }

  const ceiling = params.callerEffectiveScope
    ? { callerEffectiveScope: params.callerEffectiveScope }
    : {}

  const fire = (actingAgentId?: string) =>
    withTurnFailureReported(
      import("~/modules/agent/runtime/agent-service").then(({ invokeAgentForThread }) =>
        invokeAgentForThread(
          threadId,
          message.id,
          actor,
          orgId,
          // foreground: a live user @-mention — interactive worker-pool priority
          // (the default). This is the ONE invokeAgentForThread caller that stays
          // foreground; routine ticks + re-invocations pass background=true.
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          actingAgentId,
          undefined,
          turnContext,
        ),
      ),
      {
        orgId,
        threadId,
        actorUserId: actor.userId,
        agentId: actingAgentId ?? null,
        replyRootId: message.replyRootId ?? null,
      },
    ).catch((err) => {
      log.error({ err, threadId, actingAgentId }, "Agent mention invocation failed")
    })

  // S12: a mention has standing to speak only when it NAMES a live agent of
  // this org. parseMentions checks the uuid SHAPE and nothing else, so a
  // nonexistent, foreign-org or archived id arrives looking like a real one:
  // it seats nobody (addAgentParticipant refuses it) yet still dispatched,
  // and resolveActingAgent then fell through to the requester's own personal
  // agent, which answered in the channel with no seat. One query, before any
  // dispatch; survivors only.
  const liveAgentIds = new Set(
    await runRls((tx) => resolveLiveAgentIds(tx, { orgId, agentIds: mentionedAgentIds })),
  )

  const dispatchedAgentIds: string[] = []
  for (const agentId of mentionedAgentIds) {
    if (!liveAgentIds.has(agentId)) continue
    if (await runsLocally(agentId)) continue

    // THE ONE DISPATCH PATH (P3b-T09a): guard, seat, turn, in that order,
    // in the same function `agents_ask` calls, so neither surface can skip
    // the guard or the refusal line. Fire and forget stays fire and forget:
    // the outcome's turn handle is only awaited by a caller that wants the
    // answer back.
    const outcome = await dispatchAgentMention(runRls, {
      orgId,
      threadId,
      calleeAgentId: agentId,
      callerAgentId: message.authorAgentId ?? null,
      parentMessageId: message.parentMessageId ?? null,
      triggerMessageId: message.id,
      // A7: a refusal is told in the reply thread the mention was posted in.
      replyRootId: message.replyRootId ?? null,
      questionText: message.content,
      actor,
      adderName: message.authorName,
      turnContext,
      ...ceiling,
    })
    if (outcome.allowed) {
      dispatchedAgentIds.push(agentId)
      outcome.turn?.catch((err) => {
        log.error({ err, threadId, actingAgentId: agentId }, "Agent mention invocation failed")
      })
    }
  }

  // A 1:1 agent chat that addressed no resolvable agent: the thread's own
  // agent answers. THROUGH THE SAME DISPATCH, so a direct message is
  // guarded exactly as a mention is (hop bound, per root cap, dedupe, and a
  // refusal the room can read). The callee is the agent seated in this
  // chat; a legacy seatless 1:1 has none to resolve, and answers as before.
  if (liveAgentIds.size === 0 && isAgentChat) {
    // The poster sits in this 1:1, so their own RLS sees its agent seat.
    const seated = await runRls((tx) => resolveSeatedAgentId(tx, { orgId, threadId }))
    if (!seated) {
      // A seatless legacy 1:1 names no agent to compare, so a sender who says
      // the turn runs on their machine is taken at their word: nothing here.
      if (!(await runsLocally(null))) fire()
    } else if (await runsLocally(seated)) {
      // The sender's machine answers this one.
    } else {
      const outcome = await dispatchAgentMention(runRls, {
        orgId,
        threadId,
        calleeAgentId: seated,
        callerAgentId: message.authorAgentId ?? null,
        parentMessageId: message.parentMessageId ?? null,
        triggerMessageId: message.id,
        // A7: a refusal is told in the reply thread the mention was posted in.
        replyRootId: message.replyRootId ?? null,
        questionText: message.content,
        actor,
        adderName: message.authorName,
        turnContext,
        ...ceiling,
      })
      if (outcome.allowed) {
        dispatchedAgentIds.push(seated)
        outcome.turn?.catch((err) => {
          log.error({ err, threadId, actingAgentId: seated }, "Agent chat invocation failed")
        })
      }
    }
  }

  return { dispatchedAgentIds }
}

/** The kernel job a draining process hands a posted message's dispatch to. */
export const TURN_DISPATCH_JOB = "agent-turn-dispatch"

/**
 * What the job carries: the call's own params, plain data only. The scope
 * ceiling and the turn context ride along (a dropped ceiling would widen the
 * turn's scope); `runRls` is rebuilt from the actor by the job.
 */
function toJobPayload(params: PostedMessageDispatchParams): PostedMessageDispatchParams {
  return JSON.parse(JSON.stringify(params)) as PostedMessageDispatchParams
}

type EnqueueDispatch = (
  name: string,
  payload: PostedMessageDispatchParams,
  jobId: string,
) => Promise<void>

const defaultEnqueue: EnqueueDispatch = async (name, payload, jobId) => {
  const { enqueueAppJob } = await import("~/infra/jobs/jobs")
  // One attempt: a re-run would post a second reply; the dedup id keeps a
  // retried post from queueing the dispatch twice.
  await enqueueAppJob("kernel", name, payload, { jobId, attempts: 1 })
}
let enqueueDispatch: EnqueueDispatch = defaultEnqueue

/** The `agent-turn-dispatch` job: the dispatch a draining process handed over. */
export async function runDeferredTurnDispatch(params: PostedMessageDispatchParams): Promise<void> {
  const context = {
    actorType: "user" as const,
    userId: params.actor.userId,
    orgId: params.orgId,
    scopes: params.actor.scopes,
    dimensionGrants: params.actor.dimensionGrants ?? {},
    ...(params.actor.roles ? { roles: params.actor.roles } : {}),
  }
  await dispatchForPostedMessage((fn) => withRlsContext(context, fn), params, { deferred: true })
}

/** Test seam: production code never calls it. */
export const PostedMessageDispatchTestAccess = {
  setEnqueue(fn: EnqueueDispatch): void {
    enqueueDispatch = fn
  },
  reset(): void {
    enqueueDispatch = defaultEnqueue
  },
}
