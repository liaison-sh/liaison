// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq, gte, inArray, or, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { approvalRequests } from "~/db/schema/kernel"

export interface ApprovalRef {
  /** Human-facing label (`request-N`) — the ONLY identifier the approval card
   *  and the attention feed print, so it is what a reviewer can actually find. */
  handle: string
  /** Thread the approval lives in (the originating/connection thread). */
  threadId: string | null
  /** A send from an end-to-end encrypted mailbox: only a window holding that
   *  mailbox's key, unlocked, can approve it into an actual send. */
  mailboxSealed: boolean
}

/**
 * Resolve the human-facing reference of an approval from its uuid.
 *
 * Agents only ever hold the uuid (`approvalRequestId`) — createApprovalRequest
 * returns nothing else — so every agent-facing surface that reports a gated
 * call (MCP tool-call, the in-app tool bridge, approvals_list, approval_status)
 * used to cite an identifier no human could locate in the UI: the card shows
 * `request-N`, the uuid only on hover. Resolving the handle here lets those
 * surfaces hand the agent BOTH, so it can cite the label the reviewer sees.
 * Read from the row rather than re-derived so it stays correct whatever
 * routing createApprovalRequest applies.
 */
export async function resolveApprovalRef(
  orgId: string,
  approvalRequestId: string,
): Promise<ApprovalRef | null> {
  const [row] = await withPrivilegedDb(orgId, "approval-ref", (tx) =>
    tx
      .select({
        handle: approvalRequests.handle,
        threadId: approvalRequests.threadId,
        mailboxSealed: sql<boolean>`coalesce((${approvalRequests.currentPayload} ->> 'mailboxSealed')::boolean, false)`,
      })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalRequestId)),
  )
  return row
    ? {
        handle: row.handle,
        threadId: row.threadId ?? null,
        mailboxSealed: row.mailboxSealed === true,
      }
    : null
}

/**
 * The handles of the approvals requested for `userId` since `since`: the ones
 * an agent turn that started then parked, its sub-agents and sequenced bundles
 * included (the false approval claim guard).
 */
export async function approvalHandlesRequestedSince(
  orgId: string,
  userId: string,
  since: Date,
): Promise<string[]> {
  const rows = await withPrivilegedDb(orgId, "approval-handles-since", (tx) =>
    tx
      .select({ handle: approvalRequests.handle })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.orgId, orgId),
          eq(approvalRequests.requestedBy, userId),
          gte(approvalRequests.createdAt, since),
        ),
      ),
  )
  return rows.map((r) => r.handle)
}

/** Which of `handles` name an approval of `threadId` (as its thread or its originating one). */
export async function threadApprovalHandles(
  orgId: string,
  threadId: string,
  handles: string[],
): Promise<string[]> {
  if (handles.length === 0) return []
  const rows = await withPrivilegedDb(orgId, "approval-thread-handles", (tx) =>
    tx
      .select({ handle: approvalRequests.handle })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.orgId, orgId),
          inArray(approvalRequests.handle, handles),
          or(
            eq(approvalRequests.threadId, threadId),
            eq(approvalRequests.originatingThreadId, threadId),
          ),
        ),
      ),
  )
  return rows.map((r) => r.handle)
}

/**
 * Whether `threadId` holds an approval still waiting for a decision (as its
 * thread or its originating one): pending, a bundle step deferred behind its
 * head, or one inside its undo window (approving). A decided one is no card to act on: "please
 * approve the pending card" with only a decided approval in the conversation is
 * false (card-claim.ts).
 */
export async function threadHasPendingApproval(orgId: string, threadId: string): Promise<boolean> {
  const rows = await withPrivilegedDb(orgId, "approval-thread-pending", (tx) =>
    tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.orgId, orgId),
          inArray(approvalRequests.status, ["pending", "deferred", "approving"]),
          or(
            eq(approvalRequests.threadId, threadId),
            eq(approvalRequests.originatingThreadId, threadId),
          ),
        ),
      )
      .limit(1),
  )
  return rows.length > 0
}
