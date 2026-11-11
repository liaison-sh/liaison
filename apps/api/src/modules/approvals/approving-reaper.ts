// SPDX-License-Identifier: FSL-1.1-ALv2

import { APPROVING_WEDGE_GRACE_MS } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { jobsLogger as log } from "~/lib/logger"
import { enqueueRoutineDecisionTurn } from "~/modules/approvals/approval-result-turn"
import {
  emitApprovalStateChange,
  loadApprovalSummary,
  postDualSystemMessages,
} from "~/modules/approvals/event-data"
import { hasLandedEffect, promoteLandedEffect } from "~/modules/approvals/handler-protocol"
import { applyReconcileOutcome } from "~/modules/approvals/reconcile-outcome"
import { approvalFailureRequiredScopes } from "~/modules/approvals/result-notice"
import { toolRegistry } from "~/modules/apps/app-registries"
import { sweepSkippingMoving, writeUnlessMoving } from "~/modules/org/transfer-state/skip-moving"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"

const K = drizzleSql.raw(schemaRef("kernel"))

/** How long after an execution settles as `ambiguous` its reconciler first asks
 *  the provider: long enough for a write that went through upstream to be
 *  readable there (a slow Graph comment post was visible 11 s after our side
 *  gave up). */
export const AMBIGUOUS_RECONCILE_DELAY_MS = 60_000

interface StaleRow {
  id: string
  org_id: string
  tool_name: string
  proposing_turn_scopes: unknown
  thread_id: string
  originating_thread_id: string
  notify_user_ids: string[]
  requested_by: string
  decided_by: string | null
  current_payload: unknown
  operator_flagged: boolean
  past_grace: boolean
}

export async function runApprovingReaper() {
  // An org being moved keeps its approvals as they are until the move ends.
  const result = await sweepSkippingMoving((notMoving) =>
    withSystemDb("approving-reaper-scan", (db) =>
      db.execute(drizzleSql`
      SELECT id, org_id, tool_name, thread_id, originating_thread_id, notify_user_ids,
             requested_by, decided_by, current_payload, proposing_turn_scopes,
             (metadata ? 'reaperFlaggedAt') AS operator_flagged,
             (approving_started_at IS NULL
               OR approving_started_at < now() - make_interval(secs => ${APPROVING_WEDGE_GRACE_MS / 1000}::double precision)
             ) AS past_grace
      FROM ${K}.approval_requests r
      WHERE status = 'approving'
        AND ${notMoving(drizzleSql.raw("org_id"))}
        AND (
          approving_started_at < now() - make_interval(secs => ${APPROVING_WEDGE_GRACE_MS / 1000}::double precision)
          -- An execution already settled as ambiguous is over: its tool's
          -- reconciler (if any) can ask the provider now, not after the grace.
          OR EXISTS (
            SELECT 1 FROM ${K}.approved_handler_executions e
            WHERE e.approval_request_id = r.id AND e.tool_name = r.tool_name
              AND e.status = 'ambiguous'
              AND e.finished_at < now() - make_interval(secs => ${AMBIGUOUS_RECONCILE_DELAY_MS / 1000}::double precision)
          )
        )
      LIMIT 100
    `),
    ),
  )
  const stale = extractRows<StaleRow>(result)

  for (const row of stale) {
    try {
      await writeUnlessMoving(row.org_id, () => reapOne(row))
    } catch (err) {
      log.error({ err, requestId: row.id }, "Approving reaper failed for row")
    }
  }
}

/** A wedged row stays in `approving` until a human decides it (list.ts surfaces
 *  it as dead + healable), so the scan re-sees it every run — persist a flag so
 *  the operator-review error is emitted ONCE per row, not on every scan (a
 *  handful of wedged rows otherwise floods the watchdog with criticals for days). */
async function markOperatorFlagged(row: StaleRow) {
  await withSystemDb("approving-reaper-flag", (db) =>
    db.execute(drizzleSql`
      UPDATE ${K}.approval_requests
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{reaperFlaggedAt}', to_jsonb(now()))
      WHERE id = ${row.id} AND status = 'approving'
    `),
  )
}

async function reapOne(row: StaleRow) {
  const result = await withSystemDb("approving-reaper-read-exec", (db) =>
    db.execute(drizzleSql`
      SELECT status, error, external_ref FROM ${K}.approved_handler_executions
      WHERE approval_request_id = ${row.id} AND tool_name = ${row.tool_name}
    `),
  )
  const exec = extractRows<{ status: string; error: unknown; external_ref: unknown }>(result)[0]

  // A row whose external effect landed (recordEffectLanded) is a success the
  // execution never got to report: its handler was cut off after the provider
  // call, or its landed write reached the database only after the host had
  // classified the run. Promote it and terminalize below like any success.
  if (
    exec &&
    (exec.status === "started" || exec.status === "ambiguous") &&
    hasLandedEffect(exec.external_ref)
  ) {
    const promoted = await withPrivilegedDb(row.org_id, "approving-reaper-promote-landed", (tx) =>
      promoteLandedEffect(tx, row.id, row.tool_name),
    )
    if (promoted) exec.status = "succeeded"
  }

  // The outcome is unknown: ask the tool's reconciler, when it declares one,
  // whether the effect happened (reconcile-outcome.ts). A definite answer is
  // recorded on the execution row and handled by the branches below like any
  // other outcome.
  let reconciled: "executed" | "not_executed" | null = null
  if (!exec || exec.status === "started" || exec.status === "ambiguous") {
    // A missing or `started` row may still belong to a live execution until the
    // grace window has passed; an `ambiguous` one is over.
    if (row.past_grace || exec?.status === "ambiguous")
      reconciled = await reconcileUnknownOutcome(row)
    // Picked up early for its reconciler, which could not tell: the grace
    // window still runs before anyone is asked to look.
    if (!row.past_grace && reconciled === null) return
  }
  const execNow: { status: string; error: unknown } | undefined =
    reconciled === "executed"
      ? { status: "succeeded", error: null }
      : reconciled === "not_executed"
        ? { status: "failed_no_effect", error: { code: "reconciled_not_executed" } }
        : exec

  if (!execNow || execNow.status === "started") {
    if (!row.operator_flagged) {
      log.error(
        { requestId: row.id, recordStatus: execNow?.status ?? "none" },
        "Approving row without resolved handler record — operator review required",
      )
      await markOperatorFlagged(row)
    }
    return
  }
  if (execNow.status === "ambiguous") {
    if (!row.operator_flagged) {
      log.error(
        { requestId: row.id, error: execNow.error },
        "Ambiguous handler outcome past stale threshold — operator review required",
      )
      await markOperatorFlagged(row)
    }
    return
  }

  if (execNow.status === "succeeded") {
    await withPrivilegedDb(row.org_id, "approving-reaper-terminalize", async (tx) => {
      const updated = extractRows<{ id: string; decided_by: string; decided_at: string }>(
        await tx.execute(drizzleSql`
          UPDATE ${K}.approval_requests
          SET status = 'approved', approving_started_at = NULL
          WHERE id = ${row.id} AND status = 'approving'
          RETURNING id, decided_by, decided_at
        `),
      )[0]
      if (!updated) return
      const actorId = updated.decided_by ?? row.requested_by
      const meta = {
        type: "approval-decision",
        decision: "approved",
        actorId,
      }
      const text =
        reconciled === "executed"
          ? "Approved (reconciled). The provider shows the action happened."
          : "Approved (recovered). Tool executed successfully."
      await postDualSystemMessages(tx, {
        // Fixed text, no tool output.
        requiredScopes: [],
        orgId: row.org_id,
        threadId: row.thread_id,
        originatingThreadId: row.originating_thread_id,
        requesterId: row.requested_by,
        actorUserId: actorId,
        content: text,
        // A11: the reaper is a WORKER finishing a transition a human already
        // decided; no agent acted, so it records a positive null.
        agentId: null,
        metadata: meta,
      })
      const summaryData = await loadApprovalSummary(tx, row.org_id, row.id)
      await tx.queueEvent({
        app: "kernel",
        entity: "approval_request",
        action: "update",
        entityId: row.id,
        orgId: row.org_id,
        actorId,
        actorType: "system",
        // A11: same reason as the notice above.
        agentId: null,
        data: summaryData,
      })
    })
    // A routine run waiting on this call carries on (approval-result-turn.ts).
    await enqueueRoutineDecisionTurn(row.org_id, row.id)
    return
  }

  if (execNow.status === "failed_no_effect") {
    await withPrivilegedDb(row.org_id, "approving-reaper-revert", async (tx) => {
      const reverted = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          UPDATE ${K}.approval_requests
          SET status = 'pending', decided_by = NULL, decided_at = NULL, approving_started_at = NULL
          WHERE id = ${row.id} AND status = 'approving'
          RETURNING id
        `),
      )[0]
      if (!reverted) return
      const meta = { type: "approval-error", error: execNow.error }
      const text =
        reconciled === "not_executed"
          ? "The approved action did not happen (checked with the provider). Request reverted to pending."
          : "Handler failed (recovered). Request reverted to pending."
      // The text is fixed, but `meta.error` is the handler's own error object
      // verbatim and listMessages serves metadata to every reader of the row,
      // so a handler that failed while holding scoped data would disclose it
      // here. It requires what the call could reveal, like the other
      // post-approval failure notices.
      const requesterScopes = (await loadEffectivePermissions(tx, row.requested_by, row.org_id))
        .scopes
      await postDualSystemMessages(tx, {
        requiredScopes: approvalFailureRequiredScopes({
          orgId: row.org_id,
          toolName: row.tool_name,
          proposingTurnScopes: row.proposing_turn_scopes,
          requesterScopes,
        }),
        orgId: row.org_id,
        threadId: row.thread_id,
        originatingThreadId: row.originating_thread_id,
        requesterId: row.requested_by,
        actorUserId: row.requested_by,
        content: text,
        // A11: a WORKER undoing a failed execution. No agent acted.
        agentId: null,
        metadata: meta,
      })
      const summaryData = await loadApprovalSummary(tx, row.org_id, row.id)
      await tx.queueEvent({
        app: "kernel",
        entity: "approval_request",
        action: "update",
        entityId: row.id,
        orgId: row.org_id,
        actorId: row.requested_by,
        actorType: "system",
        // A11: same reason as the notice above.
        agentId: null,
        data: summaryData,
      })
    })
  }
}

/**
 * Ask the tool's reconciler whether an approved execution with an unknown
 * outcome took effect, and record a definite answer on its execution row
 * (reconcile-outcome.ts). Null when the tool declares no reconciler, the
 * reconciler cannot tell, or it failed: the row is then left as it was.
 */
export async function reconcileUnknownOutcome(row: {
  id: string
  org_id: string
  tool_name: string
  current_payload: unknown
  requested_by: string
  decided_by?: string | null
}): Promise<"executed" | "not_executed" | null> {
  const [appName, short] = row.tool_name.split(":")
  if (!appName || !short) return null
  // The reaper is an org-less cron: set the org's apps up before reading its tools.
  try {
    const { awaitOrgApps } = await import("~/modules/apps/init")
    await awaitOrgApps(row.org_id)
  } catch (err) {
    log.error(
      { err, requestId: row.id, orgId: row.org_id },
      "Reconcile: the org's apps could not be set up",
    )
    return null
  }
  const tool = toolRegistry.get([row.org_id, appName, short])
  if (!tool?.reconcile) return null
  const reconcile = tool.reconcile
  try {
    // No transaction is open while the reconciler asks the provider: the
    // reference is read in one short transaction, the answer recorded in
    // another. applyReconcileOutcome's write is guarded on the row's state
    // (started / ambiguous, no landed effect), so a change in between wins.
    const [current] = extractRows<{ external_ref: unknown }>(
      await withPrivilegedDb(row.org_id, "approving-reaper-reconcile-read", (tx) =>
        tx.execute(drizzleSql`
          SELECT external_ref FROM ${K}.approved_handler_executions
          WHERE approval_request_id = ${row.id} AND tool_name = ${row.tool_name}
        `),
      ),
    )
    const answer = await reconcile(
      { orgId: row.org_id },
      {
        approvalRequestId: row.id,
        payload: row.current_payload,
        externalRef: current?.external_ref ?? null,
      },
    )
    if (answer.outcome === "unknown") {
      log.info(
        { requestId: row.id, tool: row.tool_name, reason: answer.reason },
        "Reconciler could not tell whether the approved action happened",
      )
      return null
    }
    const applied = await withPrivilegedDb(row.org_id, "approving-reaper-reconcile-apply", (tx) =>
      applyReconcileOutcome(tx, {
        orgId: row.org_id,
        approvalRequestId: row.id,
        toolName: row.tool_name,
        actorId: row.decided_by ?? row.requested_by,
        outcome: answer,
      }),
    )
    if (!applied) return null
    log.warn(
      { requestId: row.id, tool: row.tool_name, outcome: answer.outcome },
      "Approved execution with an unknown outcome reconciled with the provider",
    )
    return answer.outcome
  } catch (err) {
    log.error(
      { err, requestId: row.id, tool: row.tool_name },
      "Reconciler failed; the approval stays held",
    )
    return null
  }
}

interface StaleDeferredRow {
  id: string
  org_id: string
  thread_id: string
  originating_thread_id: string
  requested_by: string
}

/**
 * Find deferred bundle steps whose predecessor is in a terminal state but the
 * cascade loop never ran (e.g. process crashed mid-cascade). Cancel them so
 * agents can be re-invoked rather than waiting forever.
 *
 * A deferred step is "stranded" when its `depends_on_id` row has reached a
 * terminal status (approved/denied/expired/cancelled/withdrawn) but this step is still
 * deferred more than the grace window (APPROVING_WEDGE_GRACE_MS) after the head was decided.
 *
 * IMPORTANT: a head whose handler is legitimately still driving an async
 * cascade must NOT be reaped. For async tools the head terminalizes to
 * `approved` while its `approved_handler_executions` row stays `awaiting_output`
 * (or `started`) and a poll job advances the dependents later (poll-output.ts).
 * If that async output takes longer than the grace window, keying only off the
 * head's `decided_at` would wrongly cancel a still-progressing bundle. So we
 * also require that the head has NO in-progress handler execution — only heads
 * whose execution is itself terminal (succeeded/failed_no_effect/ambiguous,
 * or absent) are eligible for reaping.
 */
export async function runDeferredStepReaper(): Promise<void> {
  // An org being moved keeps its approvals as they are until the move ends.
  const result = await sweepSkippingMoving((notMoving) =>
    withSystemDb("deferred-step-reaper-scan", (db) =>
      db.execute(drizzleSql`
      SELECT d.id, d.org_id, d.thread_id, d.originating_thread_id, d.requested_by
      FROM ${K}.approval_requests d
      JOIN ${K}.approval_requests h ON h.id = d.depends_on_id
      WHERE d.status = 'deferred'
        AND ${notMoving(drizzleSql.raw("d.org_id"))}
        AND h.status IN ('approved', 'denied', 'expired', 'cancelled', 'withdrawn')
        AND h.decided_at < now() - make_interval(secs => ${APPROVING_WEDGE_GRACE_MS / 1000}::double precision)
        AND NOT EXISTS (
          SELECT 1 FROM ${K}.approved_handler_executions e
          WHERE e.approval_request_id = h.id
            AND e.status IN ('started', 'awaiting_output')
        )
      LIMIT 100
    `),
    ),
  )
  const stale = extractRows<StaleDeferredRow>(result)

  for (const row of stale) {
    try {
      await writeUnlessMoving(row.org_id, async () => {
        await withPrivilegedDb(row.org_id, "deferred-step-reaper-cancel", async (tx) => {
          const cancelled = extractRows<{ id: string }>(
            await tx.execute(drizzleSql`
            UPDATE ${K}.approval_requests
            SET status = 'cancelled'
            WHERE id = ${row.id} AND status = 'deferred'
            RETURNING id
          `),
          )[0]
          if (!cancelled) return
          await emitApprovalStateChange(tx, {
            // Fixed text, no handler output.
            requiredScopes: [],
            orgId: row.org_id,
            requestId: row.id,
            threadId: row.thread_id,
            originatingThreadId: row.originating_thread_id,
            requesterId: row.requested_by,
            actorUserId: row.requested_by,
            actorType: "system",
            content: "Cancelled (cascade did not complete).",
            metadata: { type: "approval-decision", decision: "cancelled" },
          })
        })
        // A routine run waiting on this step carries on (approval-result-turn.ts).
        await enqueueRoutineDecisionTurn(row.org_id, row.id)
      })
    } catch (err) {
      log.error({ err, requestId: row.id }, "Deferred-step reaper failed for row")
    }
  }
}
