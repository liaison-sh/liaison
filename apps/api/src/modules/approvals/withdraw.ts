// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { enqueueRoutineDecisionTurn } from "~/modules/approvals/approval-result-turn"
import {
  cancelDeferredBundleSiblings,
  loadApprovalSummary,
  lockedUpdateApproval,
  postDualSystemMessages,
} from "~/modules/approvals/event-data"

const K = drizzleSql.raw(schemaRef("kernel"))

const REASON_MAX = 1000

export class WithdrawApprovalError extends Error {
  status: 400 | 403 | 404 | 409
  code: "invalid_reason" | "forbidden" | "not_found" | "stale_status"
  details?: unknown
  constructor(
    status: 400 | 403 | 404 | 409,
    code: WithdrawApprovalError["code"],
    message: string,
    details?: unknown,
  ) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface WithdrawApprovalArgs {
  orgId: string
  requestId: string
  actor: UserContext
  reason?: string
  /**
   * What the withdrawing turn has read (scope-taint.ts), when an agent turn withdraws. The reason
   * is the agent's own text and can quote it, so on a tainted turn the reason is posted only in
   * the approval's threads, stamped with these scopes (the message sink filters each reader by
   * them), and is kept off the request row, whose readers that filter does not reach.
   */
  turnTaintScopes?: readonly string[]
}

export interface WithdrawApprovalResult {
  id: string
  status: "withdrawn"
  withdrawnAt: string
  reason: string | null
}

interface WithdrawRow {
  id: string
  org_id: string
  tool_name: string
  thread_id: string
  originating_thread_id: string
  requested_by: string
  status: string
}

/**
 * Let the REQUESTER retract their own PENDING approval request. This is the
 * only path an agent may take on an approval it raised: it can never approve,
 * deny, or edit someone else's request, and it can never claim a gated action
 * ran. Approving stays exclusively human: this function never writes
 * 'approved' and never touches the cascade/execute path.
 *
 * Ownership is the ONLY gate (row.requested_by === actor.userId): no scope
 * override, no approver override, no admin override. An approver who is not
 * the requester must use the existing human deny path in decide.ts.
 */
export async function withdrawApproval(
  args: WithdrawApprovalArgs,
): Promise<WithdrawApprovalResult> {
  // Only a real connected user may withdraw. Never compare against a literal
  // system marker: agent-initiated approvals already carry the real user's id
  // as `requested_by` (execute-tool.ts), so the ownership check below is the
  // real gate; this just refuses a caller with no user identity at all.
  if (args.actor.actorType !== "user" || !args.actor.userId) {
    throw new WithdrawApprovalError(403, "forbidden", "forbidden")
  }

  const reason = args.reason === undefined ? null : args.reason.trim()
  if (reason !== null && reason.length > REASON_MAX) {
    throw new WithdrawApprovalError(400, "invalid_reason", "invalid_reason")
  }
  // A withdraw is an undo that sends nothing out, so a tainted turn never has to ask for it: its
  // reason goes only where every reader is filtered by what the turn read.
  const taint = [...new Set(args.turnTaintScopes ?? [])]
  const rowReason = taint.length > 0 ? null : reason

  // RLS-scoped read: 404 (not 403) when the row is not visible to this actor,
  // so existence is never leaked to a caller outside the row's audience.
  const row = await withRlsContext(args.actor, async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT id, org_id, tool_name, thread_id, originating_thread_id, requested_by, status
      FROM ${K}.approval_requests
      WHERE id = ${args.requestId}
    `)
    return extractRows<WithdrawRow>(result)[0] ?? null
  })
  if (!row) throw new WithdrawApprovalError(404, "not_found", "not_found")

  // Defense in depth: the RLS read is already org scoped, but never trust a
  // single layer for a cross org existence leak. Same code and message as the
  // not-found path above, so a mismatch never reveals that the row exists.
  if (row.org_id !== args.orgId) throw new WithdrawApprovalError(404, "not_found", "not_found")

  if (row.requested_by !== args.actor.userId) {
    throw new WithdrawApprovalError(
      403,
      "forbidden",
      "only the requester may withdraw their own approval request; an approver who disagrees with it must deny it instead",
    )
  }

  // Pre-lock guards for a fast, specific refusal. Re-verified INSIDE the lock
  // below (via lockedUpdateApproval's from:'pending' guard) so a concurrent
  // cascade claim and this withdraw cannot both win.
  if (row.status === "approving") {
    throw new WithdrawApprovalError(
      409,
      "stale_status",
      "this request is already approving (mid execution); a human must resolve it, it cannot be withdrawn now",
      { currentStatus: row.status },
    )
  }
  if (row.status === "deferred") {
    throw new WithdrawApprovalError(
      409,
      "stale_status",
      "this is a step of a bundle and cannot be withdrawn on its own; withdraw the bundle head instead",
      { currentStatus: row.status },
    )
  }
  if (row.status !== "pending") {
    throw new WithdrawApprovalError(
      409,
      "stale_status",
      `this request is already ${row.status} and cannot be withdrawn`,
      { currentStatus: row.status },
    )
  }

  const withdrawn = await withPrivilegedDb(args.orgId, "approval-withdraw", async (tx) => {
    const updated = await lockedUpdateApproval<{
      id: string
      decided_at: string
      reason: string | null
      originating_thread_id: string
    }>(tx, {
      requestId: row.id,
      from: "pending",
      set: drizzleSql`
        status = 'withdrawn',
        decided_by = ${args.actor.userId},
        decided_at = now(),
        reason = ${rowReason},
        approving_started_at = NULL,
        metadata = jsonb_set(
          jsonb_set(COALESCE(metadata, '{}'::jsonb), '{withdrawnBy}', to_jsonb(${args.actor.userId}::text)),
          '{withdrawnAt}', to_jsonb(now())
        )
      `,
      returning: drizzleSql`id, decided_at, reason, originating_thread_id`,
    })
    if (!updated) {
      // Lost the race to a concurrent transition (e.g. the cascade claimed it
      // `pending -> approving` first). Re-read and report the REAL state.
      const [cur] = extractRows<{ status: string }>(
        await tx.execute(
          drizzleSql`SELECT status FROM ${K}.approval_requests WHERE id = ${row.id}`,
        ),
      )
      throw new WithdrawApprovalError(
        409,
        "stale_status",
        `this request is already ${cur?.status ?? "unknown"} and cannot be withdrawn`,
        { currentStatus: cur?.status ?? "unknown" },
      )
    }

    // A withdrawn bundle head must not strand its deferred steps: same
    // invariant deny/expiry/failure already enforce (event-data.ts). A bundle
    // head's own `bundle_id` equals its own `id`, so this is a no-op when the
    // withdrawn row is not a bundle head.
    await cancelDeferredBundleSiblings(tx, row.id)

    // Best-effort thread note. Authored as the requester, who IS the caller
    // here, so the non-participant 403 the edit path can hit never applies.
    // A message failure must never fail the withdraw itself.
    //
    // A11, deliberately NOT an explicit null (here and on the event below): the
    // sole caller of `withdrawApproval` is the kernel tool `approval_withdraw`
    // (there is no withdraw HTTP route), so a live turn here is ALWAYS the agent
    // retracting its own request, and the live-frame read names it correctly. A
    // blanket null would erase genuine agent attribution rather than protect
    // anything. If a human withdraw surface is ever added, it must pass a
    // positive null the way the edit route does.
    try {
      await postDualSystemMessages(tx, {
        // The requester's own reason, posted back where they asked, stamped with what the
        // withdrawing turn read (nothing for a person's or an untainted turn's withdraw).
        requiredScopes: reason ? taint : [],
        orgId: args.orgId,
        threadId: row.thread_id,
        originatingThreadId: updated.originating_thread_id,
        requesterId: row.requested_by,
        actorUserId: args.actor.userId,
        content: reason
          ? `Withdrawn by the requester. Reason: ${reason}.`
          : "Withdrawn by the requester.",
        metadata: {
          type: "approval-decision",
          decision: "withdrawn",
          actorId: args.actor.userId,
          reason,
        },
      })
    } catch (err) {
      log.error(
        { err, requestId: row.id },
        "Failed to post the withdraw system message; the withdraw itself still succeeded",
      )
    }

    // Same WS shape every terminal transition emits (event-data.ts's
    // emitApprovalStateChange), so an open UI card does not sit perpetually
    // pending. Run unconditionally: the WS update must land even when the
    // best-effort thread message above failed.
    const summaryData = await loadApprovalSummary(tx, args.orgId, row.id, null, null)
    await tx.queueEvent({
      app: "kernel",
      entity: "approval_request",
      action: "update",
      entityId: row.id,
      orgId: args.orgId,
      actorId: args.actor.userId,
      actorType: "user",
      data: summaryData,
    })

    return {
      id: updated.id,
      status: "withdrawn" as const,
      withdrawnAt: new Date(updated.decided_at).toISOString(),
      reason,
    }
  })
  // A routine run waiting on this call carries on, told it was withdrawn
  // (approval-result-turn.ts). No-op for any other approval.
  await enqueueRoutineDecisionTurn(args.orgId, withdrawn.id)
  return withdrawn
}
