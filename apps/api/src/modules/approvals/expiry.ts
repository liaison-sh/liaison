// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { jobsLogger as log } from "~/lib/logger"
import { enqueueRoutineDecisionTurn } from "~/modules/approvals/approval-result-turn"
import {
  cancelDeferredBundleSiblings,
  cancelDeferredDependents,
  emitApprovalStateChange,
  lockedUpdateApproval,
} from "~/modules/approvals/event-data"

const K = drizzleSql.raw(schemaRef("kernel"))

export async function runApprovalExpiry(payload: { orgId: string; requestId: string }) {
  const expiredId = await withPrivilegedDb(payload.orgId, "approval-expiry", async (tx) => {
    // Accept both 'pending' and 'deferred' as source states so that deferred
    // bundle steps are expired when their deadline is reached.
    const expired = await lockedUpdateApproval<{
      id: string
      handle: string
      thread_id: string
      originating_thread_id: string
      requested_by: string
    }>(tx, {
      requestId: payload.requestId,
      from: ["pending", "deferred"] as const,
      set: drizzleSql`status = 'expired'`,
      returning: drizzleSql`id, handle, thread_id, originating_thread_id, requested_by`,
    })
    if (!expired) return null
    // Expiring a bundle head cancels every deferred step of the same bundle.
    await cancelDeferredBundleSiblings(tx, payload.requestId)
    await cancelDeferredDependents(tx, payload.requestId)
    await emitApprovalStateChange(tx, {
      // Fixed text ("Expired without decision."): no handler output.
      requiredScopes: [],
      orgId: payload.orgId,
      requestId: expired.id,
      threadId: expired.thread_id,
      originatingThreadId: expired.originating_thread_id,
      requesterId: expired.requested_by,
      actorUserId: expired.requested_by,
      actorType: "system",
      content: "Expired without decision.",
      // The handle is what makes SIX expiries in one thread six facts instead
      // of the same sentence six times. The client renders the line from this
      // ("request-42 expired without decision."), in the reader's language;
      // `content` stays the plain fallback for a row read any other way.
      metadata: {
        type: "approval-decision",
        decision: "expired",
        requestHandle: expired.handle,
      },
    })
    return expired.id
  })
  // A routine run waiting on this call carries on, told it expired
  // (approval-result-turn.ts). No-op for any other approval.
  if (expiredId) await enqueueRoutineDecisionTurn(payload.orgId, expiredId)
}

export async function runApprovalExpirySweep() {
  // Include 'deferred' steps — they can also reach their expires_at deadline
  // while waiting for a bundle head to resolve.
  const expiring = await withSystemDb("approval-expiry-sweep-scan", (db) =>
    db.execute(drizzleSql`
      SELECT id, org_id FROM ${K}.approval_requests
      WHERE status IN ('pending', 'deferred') AND expires_at <= now()
      LIMIT 200
    `),
  )
  const rows = extractRows<{ id: string; org_id: string }>(expiring)
  for (const r of rows) {
    try {
      await runApprovalExpiry({ orgId: r.org_id, requestId: r.id })
    } catch (err) {
      log.error({ err, requestId: r.id }, "Expiry sweep failed for request")
    }
  }
}
