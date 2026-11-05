// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TELLING THE CONVERSATION A SCOPE REQUEST WAS DECIDED.
//
// An agent files a scope request from inside a conversation and then waits.
// The decision used to land only in the admin's inbox and the requester's
// feed: the conversation that asked heard nothing, so on the next turn the
// agent (which only knows its transcript) said "my request is still awaiting
// approval" about a request approved minutes before. Now a decided request
// that names its conversation gets two things there:
//
//  1. A system line (`metadata.type = 'scope-request-decision'`), the same
//     kind of row as an approval's `approval-decision`, which the agent's
//     transcript replays as a fact (system-event-replay.ts).
//  2. When an agent asked, ONE turn of that agent, started off that line, so
//     the agent speaks first: it says what it can now do and asks before
//     acting, or says briefly that it still cannot. The turn is an ordinary
//     background turn through `invokeAgentForThread` (the job below), so its
//     reply is persisted, broadcast and notified like any agent reply.
//
// Runs AFTER the decision's transaction committed (the route calls it): a turn
// started inside it could read the agent's old ceiling and stay locked, and a
// decision that rolled back must not announce anything.

import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { rootLogger } from "~/lib/logger"
import { loadUserName } from "~/modules/approvals/event-data"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { getScopeCatalog } from "~/modules/permissions/scope-catalog"
import type { ScopeRequestDecision } from "~/modules/scope-requests/service"
import { sendMessage } from "~/modules/threads/message"

const log = rootLogger.child({ module: "scope-request-announce" })

/** The job that runs the agent's turn off the decision line. */
export const SCOPE_DECISION_TURN_JOB = "scope-request-decision-turn"

export interface ScopeDecisionTurnPayload {
  orgId: string
  threadId: string
  /** The decision line the turn answers. */
  messageId: string
  /** The person whose conversation it is: the request's target. */
  requesterId: string
  /** The agent that asked, which is the one that answers. */
  agentId: string
  scopeRequestId: string
}

/**
 * A scope in words: its catalog description ("Decide on approval requests"),
 * lowercased to sit inside a sentence, with the scope itself after it so the
 * agent can match it to the tool it was refused. The bare scope when the
 * catalog has no description for it.
 */
function describeScopes(orgId: string, scopes: string[]): string {
  const catalog = new Map(getScopeCatalog(orgId).map((e) => [e.scope, e.description]))
  return scopes
    .map((scope) => {
      const description = catalog.get(scope)
      return description
        ? `${description.charAt(0).toLowerCase()}${description.slice(1)} (${scope})`
        : scope
    })
    .join("; ")
}

/** The decision line, in plain words: who decided, and what changed for whom. */
export function scopeDecisionContent(
  orgId: string,
  decision: ScopeRequestDecision,
  deciderName: string,
): string {
  const who = decision.agentName ?? "The requester"
  const what = describeScopes(orgId, decision.requestedScopes)
  if (decision.status === "approved") {
    return `Access request approved by ${deciderName}. ${who} can now: ${what}.`
  }
  const reason = decision.decisionReason?.trim()
  return `Access request denied by ${deciderName}${reason ? ` (reason: ${reason})` : ""}. ${who} still cannot: ${what}.`
}

/**
 * Post the decision line in the originating conversation and, when an agent
 * asked, enqueue that agent's turn. Best effort by design: the decision is
 * already committed and answered, so a failure here is logged with its
 * context and never turns a made decision into an error response.
 */
export async function announceScopeDecision(
  orgId: string,
  deciderUserId: string,
  decision: ScopeRequestDecision,
): Promise<{ messageId: string | null; turnEnqueued: boolean }> {
  const threadId = decision.originatingThreadId
  if (!threadId) return { messageId: null, turnEnqueued: false }
  try {
    const { deciderName, perms } = await withPrivilegedDb(
      orgId,
      "scope-decision-announce-read",
      async (tx) => ({
        deciderName: await loadUserName(tx, deciderUserId),
        perms: await loadEffectivePermissions(tx, decision.targetUserId, orgId),
      }),
    )
    const content = scopeDecisionContent(orgId, decision, deciderName)
    // Posted AS the person whose conversation it is (always a participant; the
    // same identity an approval's notice in the originating thread carries),
    // under their own RLS context, so the insert policy holds it to a thread
    // they are in. The text names a decision and scope names, nothing scoped.
    const message = await withRlsContext(
      {
        actorType: "user",
        userId: decision.targetUserId,
        orgId,
        scopes: perms.scopes,
        dimensionGrants: perms.dimensionGrants,
      },
      (tx) =>
        sendMessage(tx, {
          requiredScopes: [],
          orgId,
          userId: decision.targetUserId,
          threadId,
          content,
          authorType: "system",
          agentId: decision.agentId,
          metadata: {
            type: "scope-request-decision",
            scopeRequestId: decision.id,
            decision: decision.status,
            scopes: decision.requestedScopes,
            agentId: decision.agentId,
            userGrantedScopes: decision.userGrantedScopes,
            agentGrantedScopes: decision.agentGrantedScopes,
          },
        }),
    )
    if (!message) {
      log.warn(
        { orgId, threadId, scopeRequestId: decision.id, targetUserId: decision.targetUserId },
        "scope decision not announced: the requester is no longer in the originating thread",
      )
      return { messageId: null, turnEnqueued: false }
    }
    if (decision.requestedByType !== "agent" || !decision.agentId) {
      return { messageId: message.id, turnEnqueued: false }
    }
    const payload: ScopeDecisionTurnPayload = {
      orgId,
      threadId,
      messageId: message.id,
      requesterId: decision.targetUserId,
      agentId: decision.agentId,
      scopeRequestId: decision.id,
    }
    // attempts: 1, like the bundle re-invocation: the turn spends credits and
    // posts a reply, so a retry after a partial run would answer twice. The
    // jobId keys it to the request, which is decided once (a second decide is
    // a 409), so a duplicate enqueue collapses into the first.
    await enqueueAppJob("kernel", SCOPE_DECISION_TURN_JOB, payload, {
      jobId: `${SCOPE_DECISION_TURN_JOB}:${decision.id}`,
      attempts: 1,
    })
    return { messageId: message.id, turnEnqueued: true }
  } catch (err) {
    log.error(
      { err, orgId, threadId, scopeRequestId: decision.id, agentId: decision.agentId },
      "failed to announce a scope request decision in its conversation",
    )
    return { messageId: null, turnEnqueued: false }
  }
}
