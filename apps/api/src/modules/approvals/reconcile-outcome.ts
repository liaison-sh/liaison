// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reconciling an approved execution whose outcome is unknown.
//
// An approved handler with an external effect can end without knowing whether
// the effect happened: the provider call timed out on our side but went through
// on theirs, or the worker died between the call and its outcome record. The
// handler protocol then holds the execution as `ambiguous` (or `started`, or no
// row), the approval stays at `approving`, and a person used to be the only way
// out, with a deny that recorded a posted reply as denied.
//
// A tool can declare a reconciler (manifest `reconcileHandler`, registry entry
// `reconcile`): a read of the provider that answers whether the effect happened.
// The approving reaper calls it and records the answer here:
//   executed      -> the execution is `succeeded` with the provider's ref, and the
//                    reaper settles the approval as approved;
//   not_executed  -> the execution is `failed_no_effect`, and the reaper reverts
//                    the approval to pending, so a person may approve it again;
//   unknown       -> nothing changes; the approval stays held for a person.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import type { ReconcileOutcome } from "~/modules/apps/app-registries"

const K = drizzleSql.raw(schemaRef("kernel"))

const MAX_REASON = 300

function clip(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, MAX_REASON) : undefined
}

/** A reconciler's answer as the sandbox returned it, read defensively: anything
 *  that is not a clear `executed` or `not_executed` is `unknown`. */
export function normalizeReconcileOutcome(out: unknown): ReconcileOutcome {
  const r =
    out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : {}
  if (r.outcome === "executed") {
    const ref =
      r.ref && typeof r.ref === "object" && !Array.isArray(r.ref)
        ? (r.ref as Record<string, unknown>)
        : undefined
    return ref ? { outcome: "executed", ref } : { outcome: "executed" }
  }
  if (r.outcome === "not_executed") {
    const reason = clip(r.reason)
    return reason ? { outcome: "not_executed", reason } : { outcome: "not_executed" }
  }
  const reason = clip(r.reason)
  return reason ? { outcome: "unknown", reason } : { outcome: "unknown" }
}

/**
 * Record a reconciler's definite answer on the execution row. Only an execution
 * whose outcome is still unknown is changed: a row that is missing, `started`
 * or `ambiguous`. A `succeeded`, `failed_no_effect` or `awaiting_output` row
 * that raced in wins. Returns true when the row now holds the answer.
 */
export async function applyReconcileOutcome(
  tx: PrivilegedDb,
  args: {
    orgId: string
    approvalRequestId: string
    toolName: string
    actorId: string
    outcome: Exclude<ReconcileOutcome, { outcome: "unknown" }>
  },
): Promise<boolean> {
  const { orgId, approvalRequestId, toolName, actorId, outcome } = args
  if (outcome.outcome === "executed") {
    const ref = JSON.stringify({ ...(outcome.ref ?? {}), reconciled: true })
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${K}.approved_handler_executions
          (org_id, approval_request_id, tool_name, status, actor_id, attempts, last_attempt_at, finished_at, result, external_ref)
        VALUES (${orgId}, ${approvalRequestId}, ${toolName}, 'succeeded', ${actorId}, 1, now(), now(), ${ref}::jsonb, ${ref}::jsonb)
        ON CONFLICT (approval_request_id, tool_name) DO UPDATE
          SET status = 'succeeded',
              result = COALESCE(${K}.approved_handler_executions.result, EXCLUDED.result),
              external_ref = COALESCE(${K}.approved_handler_executions.external_ref, '{}'::jsonb) || EXCLUDED.external_ref,
              error = NULL,
              finished_at = now()
          WHERE ${K}.approved_handler_executions.status IN ('started', 'ambiguous')
        RETURNING id
      `),
    )
    return rows.length > 0
  }
  const error = JSON.stringify({
    code: "reconciled_not_executed",
    message: outcome.reason ?? "the provider shows the action did not happen",
  })
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      INSERT INTO ${K}.approved_handler_executions
        (org_id, approval_request_id, tool_name, status, actor_id, attempts, last_attempt_at, finished_at, error)
      VALUES (${orgId}, ${approvalRequestId}, ${toolName}, 'failed_no_effect', ${actorId}, 1, now(), now(), ${error}::jsonb)
      ON CONFLICT (approval_request_id, tool_name) DO UPDATE
        SET status = 'failed_no_effect',
            error = EXCLUDED.error,
            finished_at = now()
        WHERE ${K}.approved_handler_executions.status IN ('started', 'ambiguous')
          AND NOT COALESCE(${K}.approved_handler_executions.external_ref ? 'effectLandedAt', false)
      RETURNING id
    `),
  )
  return rows.length > 0
}
