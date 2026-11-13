// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TELLING THE CONVERSATION A SECRET WAS SAVED.
//
// The agent asked for a secret and ended its turn ("I've put a card here for
// your key"). When a person saves it, the conversation gets two things, as
// for a decided scope request (scope-requests/announce.ts):
//
//  1. A system line (`metadata.type = 'secret-request-result'`) saying what was
//     saved, by whom, with the non-secret hint. Its words are built here from
//     the row's kind, target and hint only: nothing the browser sent reaches
//     it. The agent's transcript replays it as a fact (system-event-replay.ts).
//  2. When an agent asked, ONE turn of that agent off that line, so it carries
//     on with what the secret was for. The job claims the request durably
//     before the turn starts, so a retry or a second enqueue never answers twice.
//
// A cancelled request posts the line too (so the agent stops waiting) and
// starts no turn. Runs AFTER the save committed, best effort: a failure here is
// logged and never turns a made save into an error response.

import { and, eq, gt, or } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { messages, type SecretRequest } from "~/db/schema/kernel"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { wrapExternalContent } from "~/lib/external-content"
import { rootLogger } from "~/lib/logger"
import { loadUserName } from "~/modules/approvals/event-data"
import { apiConnFor } from "~/modules/apps/connections/api/declarations"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import {
  claimSecretRequestTurn,
  completeSecretRequest,
  pendingRequestIdsForTarget,
} from "~/modules/secret-requests/service"
import { describeTarget, type SecretTarget, targetFromRow } from "~/modules/secret-requests/targets"
import { sendMessage } from "~/modules/threads/message"

const log = rootLogger.child({ module: "secret-request-announce" })

/** The job that runs the agent's turn off the saved line. */
export const SECRET_REQUEST_TURN_JOB = "secret-request-turn"

export interface SecretRequestTurnPayload {
  orgId: string
  threadId: string
  /** The saved line the turn answers. */
  messageId: string
  /** The person whose turn asked: the turn runs as them. */
  requesterId: string
  /** The agent that asked, which is the one that answers. */
  agentId: string
  secretRequestId: string
}

/** The hint in words: what it is, so nobody reads a key prefix as a key's end. */
function hintPhrase(target: SecretTarget, hint: string | null): string {
  if (!hint) return ""
  switch (target.kind) {
    // The account the provider named: its text is the provider's, so fenced.
    case "oauth_connect":
      return ` (account ${wrapExternalContent(hint)})`
    case "byok":
      return ` (ends ${hint.replace(/^…/, "")})`
    case "oauth_client":
    case "google_integration_client":
      return ` (client id ${hint})`
    case "api_key":
      return ` (key prefix ${hint})`
    default:
      return ""
  }
}

/** The row's target is an API connection's credentials (declarations.ts). */
function isApiConnectionTarget(row: SecretRequest): boolean {
  const target = targetFromRow(row.kind, row.target, row.orgId)
  if (target?.kind !== "connection_credentials") return false
  return apiConnFor(row.orgId, target.app)?.connection === target.connection
}

/** The line, in plain words, from the row alone. */
export function secretRequestResultContent(
  row: Pick<SecretRequest, "orgId" | "kind" | "target" | "status" | "hint">,
  byName: string,
): string {
  const target = targetFromRow(row.kind, row.target, row.orgId)
  const what = target ? describeTarget(target, wrapExternalContent) : "The requested secret"
  if (row.status === "saved") {
    const verb = row.kind === "oauth_connect" ? "connected" : "saved"
    return `${what} ${verb} by ${byName}${target ? hintPhrase(target, row.hint) : ""}.`
  }
  return `${what}: request cancelled by ${byName}.`
}

/**
 * Post the result line in the request's conversation as the person who saved
 * or cancelled it (a participant, or RLS would not have shown them the card),
 * and, for a save an agent asked for, enqueue that agent's turn.
 */
export async function announceSecretRequestResult(
  actor: UserContext,
  row: SecretRequest,
): Promise<{ messageId: string | null; turnEnqueued: boolean }> {
  try {
    // The row was read under the person's RLS in their own org: name the
    // org from the person's session, never from the row.
    if (row.orgId !== actor.orgId) throw new Error("secret request is not in the actor's org")
    const byName = await withPrivilegedDb(actor.orgId, "secret-request-announce-read", (tx) =>
      loadUserName(tx, actor.userId),
    )
    const content = secretRequestResultContent(row, byName)
    const message = await withRlsContext(actor, (tx) =>
      sendMessage(tx, {
        // The line names the card's target, text the agent may have chosen
        // after a scoped read: it carries the row's own stamp (migration 0220).
        requiredScopes: [...row.requiredScopes],
        orgId: row.orgId,
        userId: actor.userId,
        threadId: row.threadId,
        content,
        authorType: "system",
        agentId: row.agentId,
        metadata: {
          type: "secret-request-result",
          secretRequestId: row.id,
          kind: row.kind,
          target: row.target,
          // An API connection's credentials (any app's): the replay says to test it.
          ...(isApiConnectionTarget(row) ? { apiConnection: true } : {}),
          saved: row.status === "saved",
          hint: row.hint,
          agentId: row.agentId,
          // A connect card tells the agent only this: connected, and which account.
          ...(row.kind === "oauth_connect"
            ? { connected: row.status === "saved", accountHint: row.hint }
            : {}),
        },
      }),
    )
    if (!message) {
      log.warn(
        { orgId: row.orgId, threadId: row.threadId, secretRequestId: row.id },
        "secret request result not announced: the person is not in the conversation",
      )
      return { messageId: null, turnEnqueued: false }
    }
    if (row.status !== "saved" || !row.agentId)
      return { messageId: message.id, turnEnqueued: false }
    const payload: SecretRequestTurnPayload = {
      orgId: row.orgId,
      threadId: row.threadId,
      messageId: message.id,
      requesterId: row.requestedBy,
      agentId: row.agentId,
      secretRequestId: row.id,
    }
    // attempts: 1, like every re-invocation: the turn spends credits and posts
    // a reply, so a retry after a partial run would answer twice.
    await enqueueAppJob("kernel", SECRET_REQUEST_TURN_JOB, payload, {
      jobId: `${SECRET_REQUEST_TURN_JOB}:${row.id}`,
      attempts: 1,
    })
    return { messageId: message.id, turnEnqueued: true }
  } catch (err) {
    log.error(
      { err, orgId: row.orgId, threadId: row.threadId, secretRequestId: row.id },
      "failed to announce a secret request result in its conversation",
    )
    return { messageId: null, turnEnqueued: false }
  }
}

/**
 * A secret was saved for `target` outside a card (a model key in Settings):
 * every pending request for that target completes through the same server-side
 * check the card's Save runs (a secret new since the agent asked), and each is
 * announced, so the agent that asked carries on exactly as after the card.
 * Best effort, after the save committed: a failure is logged, never thrown.
 */
export async function settleSecretRequestsForTarget(
  actor: UserContext,
  target: SecretTarget,
): Promise<number> {
  let settled = 0
  try {
    for (const id of await pendingRequestIdsForTarget(actor.orgId, target)) {
      try {
        const saved = await completeSecretRequest({
          orgId: actor.orgId,
          id,
          userId: actor.userId,
          scopes: actor.scopes ?? [],
        })
        await announceSecretRequestResult(actor, saved)
        settled++
      } catch (err) {
        log.warn(
          { err, orgId: actor.orgId, secretRequestId: id },
          "a pending secret request was not settled by a save outside its card",
        )
      }
    }
  } catch (err) {
    log.error({ err, orgId: actor.orgId }, "failed to settle pending secret requests")
  }
  return settled
}

/**
 * The asking agent's turn after the secret was saved: once (the claim), and
 * not when the conversation moved on (the person wrote after the line, or the
 * agent already spoke). Runs as the requester, AS the agent that asked.
 * Returns whether a turn was started.
 */
export async function runSecretRequestTurn(payload: SecretRequestTurnPayload): Promise<boolean> {
  return runFollowUpTurn(payload, () =>
    claimSecretRequestTurn(payload.orgId, payload.secretRequestId),
  )
}

/** A system line in a conversation that hands the turn back to an agent. */
export interface FollowUpTurnPayload {
  orgId: string
  threadId: string
  /** The line the turn answers. */
  messageId: string
  /** The person the turn runs as. */
  requesterId: string
  /** The agent that answers. */
  agentId: string
}

/**
 * One turn of `agentId` off a system line, as the requester: not when the
 * conversation moved on (the person wrote after the line, or the agent already
 * spoke), and only when `claim` wins (it makes the turn run once). The secret
 * card's line uses it, and so does a Drive pick made from a conversation
 * (google-drive/picker-announce.ts). Returns whether a turn was started.
 */
export async function runFollowUpTurn(
  payload: FollowUpTurnPayload,
  claim: () => Promise<boolean>,
): Promise<boolean> {
  const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")

  const { answered, perms } = await withPrivilegedDb(
    payload.orgId,
    "secret-request-turn-read",
    async (pdb) => {
      const [line] = await pdb
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.id, payload.messageId), eq(messages.orgId, payload.orgId)))
        .limit(1)
      const [reply] = line
        ? await pdb
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.threadId, payload.threadId),
                eq(messages.orgId, payload.orgId),
                gt(messages.createdAt, line.createdAt),
                or(
                  and(
                    eq(messages.authorType, "agent"),
                    eq(messages.authorAgentId, payload.agentId),
                  ),
                  and(eq(messages.authorType, "user"), eq(messages.authorId, payload.requesterId)),
                ),
              ),
            )
            .limit(1)
        : []
      return {
        answered: !line || Boolean(reply),
        perms: await loadEffectivePermissions(pdb, payload.requesterId, payload.orgId),
      }
    },
  )
  if (answered) return false
  if (!(await claim())) return false

  await invokeAgentForThread(
    payload.threadId,
    payload.messageId,
    {
      userId: payload.requesterId,
      orgId: payload.orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    payload.orgId,
    true, // background: a BullMQ-driven turn, nobody at the keyboard
    undefined, // budget: default
    undefined, // routineId: not a routine tick
    undefined, // seedDiscoveredTools: lean start
    false, // anchorHistory: the agent needs the conversation it asked from
    payload.agentId,
  )
  return true
}
