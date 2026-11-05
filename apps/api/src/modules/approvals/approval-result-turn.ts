// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE AGENT ANSWERS FROM AN APPROVED CALL'S RESULT, WITHOUT BEING ASKED AGAIN.
//
// An agent's gated call parks as an approval and the agent ends its turn
// ("this needs your approval"). When the person approves, the handler runs on
// the approved re-entry and its output is posted into the proposing
// conversation as an `approval-result` row (result-notice.ts). That row is read
// only by the agent's NEXT turn, and nothing started one: the conversation went
// silent until the person wrote again, though the answer was already there.
//
// So the approved re-entry hands the turn back to the agent that proposed the
// call, the same way a decided scope request does (scope-requests/announce.ts):
// ONE background turn of that agent, started off the result row, through
// `invokeAgentForThread`, the funnel every agent turn takes, so its reply is
// persisted, streamed to the web (typing, then the answer) and notified like
// any other. The result row itself is the nudge: its transcript line tells the
// agent the call ran, fences the output as untrusted data and says to answer
// from it (system-event-replay.ts). No user message is written.
//
// A ROUTINE RUN'S APPROVAL takes the same job. A routine run that parked a
// call waits for it (routine-run-resume.ts): the job, with the approval's
// routine, hands the decision to `resumeRoutineRunOnDecision` instead of
// starting a chat turn, and the run carries on with the result in its own
// thread. A run needs a refusal too, so for a routine run's approval the job is
// also enqueued on denial and expiry (`enqueueRoutineDecisionTurn`). The job id,
// the bundle rule and the once-per-approval claim are the ones below.
//
// Guards, each at the cheapest place it can be decided:
//  - In-app agent turns only (`origin = in-app-agent`, an agent recorded), or
//    a routine run's call.
//  - Approvals only, for a chat turn: a denial never reaches it (it posts no
//    result).
//  - Bundles: only the step that completes the bundle; a step with deferred
//    dependents still waiting leaves the turn to the last one. A bundle that
//    fails mid-way re-invokes the agent through `agent-reinvoke` instead.
//  - Once per question: calls one turn parked together (same agent, same
//    conversation, same ask) hand back ONE turn, from the last result posted;
//    while a sibling is undecided it waits for it, and a refused last sibling
//    hands the turn to the latest approved one (`enqueueRoutineDecisionTurn`).
//  - Once per approval: the job id is keyed to the approval, and the run claims
//    the approval durably (`metadata.resultTurnAt`) before starting the turn,
//    so a retry, a replayed event or a second enqueue never answers twice.
//  - Not when the conversation moved on: the person wrote after the decision
//    (their own turn reads the result), or the agent spoke after the result.
//  - No chaining: the resumed turn is an ordinary turn. If it makes another
//    gated call, it parks and ends; only that approval's own decision can start
//    the next turn, once.
//
// The turn's trigger (`turnId`) is the result row, but what it answers is the
// person's question: the approval carries the proposing turn's ask
// (`metadata.askId`), the turn runs with it, and its answer stores it, so a
// view finds the answer to that question past any number of approvals. An
// approval from before the ask was recorded falls back to the person's last
// message ahead of it in the proposing conversation.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { appsLogger as log } from "~/lib/logger"
import {
  approvedSiblingOwedTurn,
  claimApprovalResultTurn,
  hasDeferredDependent,
  loadRequesterContext,
} from "~/modules/approvals/event-data"

const K = drizzleSql.raw(schemaRef("kernel"))

/** The job that runs the agent's turn off an approved call's result. */
export const APPROVAL_RESULT_TURN_JOB = "approval-result-turn"

export interface ApprovalResultTurnPayload {
  orgId: string
  approvalId: string
  /** The conversation that proposed the call, where the result row is. */
  threadId: string
  /** The person whose turn proposed it, as whom the resumed turn runs. */
  requesterId: string
  /** The agent whose turn proposed it, which is the one that answers. */
  agentId: string
  /** A routine run's approval: the run resumes (routine-run-resume.ts), no chat turn. */
  routineId?: string
  /** Re-enqueued for a run that waits on decided approvals (pause, sweep): the claim was taken. */
  rerun?: boolean
  /** How many times a busy routine lock sent the job back. */
  lockRetries?: number
}

/**
 * Called by the approved re-entry once the result row is committed. Decides
 * whether the call came from an in-app agent turn whose bundle (if any) is now
 * complete, and enqueues the turn. Best effort: the approval is already done,
 * so a failure here is logged and never fails the decision.
 */
export async function enqueueApprovalResultTurn(args: {
  orgId: string
  approvalId: string
  originatingThreadId: string
  requesterId: string
  agentId: string | null
  origin: string | undefined
  originRoutineId: string | undefined
  /** A distinct job id suffix: a sibling handed the turn after a refusal (its own job ran already). */
  jobKey?: string
}): Promise<boolean> {
  // A routine run's call (a sequenced step carries no origin of its own) or an
  // in-app agent's.
  if (!args.originRoutineId && (args.origin !== "in-app-agent" || !args.agentId)) return false
  try {
    const waiting = await hasDeferredDependent(args.orgId, args.approvalId)
    // A bundle step with steps still to run: the last one hands the turn back.
    if (waiting) return false
    const payload: ApprovalResultTurnPayload = {
      orgId: args.orgId,
      approvalId: args.approvalId,
      threadId: args.originatingThreadId,
      requesterId: args.requesterId,
      agentId: args.agentId ?? "",
      ...(args.originRoutineId ? { routineId: args.originRoutineId } : {}),
    }
    // attempts: 1, like every re-invocation: the turn spends credits and posts
    // a reply, so a retry after a partial run would answer twice.
    await enqueueAppJob("kernel", APPROVAL_RESULT_TURN_JOB, payload, {
      jobId: `${APPROVAL_RESULT_TURN_JOB}:${args.approvalId}${args.jobKey ? `:${args.jobKey}` : ""}`,
      attempts: 1,
    })
    return true
  } catch (err) {
    log.error(
      { err, orgId: args.orgId, approvalId: args.approvalId, agentId: args.agentId },
      "failed to hand the turn back to the agent after an approved call",
    )
    return false
  }
}

/**
 * A routine run's approval was denied or expired: the run waiting on it is told
 * (routine-run-resume.ts), through the same job an approval takes. No-op for any
 * other approval: a chat turn still learns of a denial from the person.
 */
export async function enqueueRoutineDecisionTurn(orgId: string, approvalId: string): Promise<void> {
  try {
    const [row] = extractRows<{
      originating_thread_id: string
      requested_by: string
      agent_id: string | null
      origin: string | null
      routine_id: string | null
    }>(
      await withPrivilegedDb(orgId, "approval-routine-decision-turn", (tx) =>
        tx.execute(drizzleSql`
          SELECT originating_thread_id::text, requested_by::text, agent_id::text,
                 metadata->>'origin' AS origin, metadata->>'originRoutineId' AS routine_id
            FROM ${K}.approval_requests
           WHERE id = ${approvalId}::uuid AND org_id = ${orgId}::uuid
             AND metadata ? 'originRoutineRunId'`),
      ),
    )
    if (!row?.routine_id) {
      await handBackToApprovedSibling(orgId, approvalId)
      return
    }
    await enqueueApprovalResultTurn({
      orgId,
      approvalId,
      originatingThreadId: row.originating_thread_id,
      requesterId: row.requested_by,
      agentId: row.agent_id,
      origin: row.origin ?? undefined,
      originRoutineId: row.routine_id,
    })
  } catch (err) {
    log.error({ err, orgId, approvalId }, "failed to tell a routine run its approval was refused")
  }
}

/**
 * A chat turn's call was refused after its sibling calls (same agent, same
 * conversation, same ask) were approved: they left the turn to this one
 * (`claimApprovalResultTurn`), so the latest approved sibling hands it back.
 */
async function handBackToApprovedSibling(orgId: string, approvalId: string): Promise<void> {
  const sibling = await approvedSiblingOwedTurn(orgId, approvalId)
  if (!sibling) return
  await enqueueApprovalResultTurn({
    orgId,
    approvalId: sibling.id,
    originatingThreadId: sibling.originating_thread_id,
    requesterId: sibling.requested_by,
    agentId: sibling.agent_id,
    origin: sibling.origin ?? undefined,
    originRoutineId: undefined,
    jobKey: `after:${approvalId}`,
  })
}

/**
 * The agent's turn after its gated call was approved and ran. Runs as the
 * requester (their current permissions, floored by the agent's ceiling inside
 * the turn, exactly as their next typed message would), AS the agent that
 * proposed the call, off the result row. Returns whether a turn was started.
 */
export async function runApprovalResultTurn(payload: ApprovalResultTurnPayload): Promise<boolean> {
  if (payload.routineId) {
    const { resumeRoutineRunOnDecision } = await import(
      "~/modules/agent/routines/routine-run-resume"
    )
    const res = await resumeRoutineRunOnDecision(payload)
    return res.status !== "no_run" && res.status !== "lock_busy"
  }
  const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")

  const claim = await claimApprovalResultTurn(payload)
  if (!claim) return false
  const requester = await loadRequesterContext(
    payload.orgId,
    payload.requesterId,
    "approval-result-turn-perms",
  )

  await invokeAgentForThread(
    payload.threadId,
    // The trigger stays the result row (`turnId`, which replay and Share
    // anyway read); the answer names the ask it continues (`askId`).
    claim.messageId,
    {
      userId: payload.requesterId,
      orgId: payload.orgId,
      scopes: requester.scopes,
      dimensionGrants: requester.dimensionGrants,
    },
    payload.orgId,
    true, // background: a BullMQ-driven turn, nobody at the keyboard
    undefined, // budget: default
    undefined, // routineId: not a routine tick
    undefined, // seedDiscoveredTools: lean start
    false, // anchorHistory: the agent needs the conversation it asked from
    payload.agentId,
    undefined, // coordination: a person's turn, not an agent's ask
    // The person's message the proposing turn answered, so the answer this
    // turn gives is found as the answer to that question.
    { askId: claim.askId },
  )
  return true
}
