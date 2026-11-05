// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Single source of truth for "why did the most recent post-approval execution
// fail". The failure is recorded once in `approved_handler_executions` (status
// `failed_no_effect` | `ambiguous`, with the handler's error). Everything that
// surfaces it — the approvals LIST + single-get (the attention-feed card), and
// the MCP `approval_status` pull — reads it through here, so there is ONE query
// shape and ONE representation, never a parallel event-data copy.

import type { ApprovalLastFailure } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { schemaRef } from "~/db/schema-ref"

const K = drizzleSql.raw(schemaRef("kernel"))

interface FailRow {
  approval_request_id: string
  error: { code?: unknown; message?: unknown } | null
  finished_at: string | Date | null
}

function toFailure(fail: FailRow): ApprovalLastFailure {
  return {
    code: typeof fail.error?.code === "string" ? fail.error.code : "handler_failed",
    message:
      typeof fail.error?.message === "string"
        ? fail.error.message
        : "The approved action failed to execute.",
    at: fail.finished_at ? new Date(fail.finished_at).toISOString() : new Date(0).toISOString(),
  }
}

/** The most recent no-effect/ambiguous post-approval failure for ONE request,
 *  or null when it never failed. */
export async function readApprovalLastFailure(
  tx: PrivilegedDb,
  orgId: string,
  approvalRequestId: string,
): Promise<ApprovalLastFailure | null> {
  const rows = await tx.execute(drizzleSql`
    SELECT approval_request_id, error, finished_at
    FROM ${K}.approved_handler_executions
    WHERE approval_request_id = ${approvalRequestId} AND org_id = ${orgId}
      AND status IN ('failed_no_effect', 'ambiguous')
    ORDER BY finished_at DESC NULLS LAST
    LIMIT 1
  `)
  const [fail] = extractRows<FailRow>(rows)
  return fail ? toFailure(fail) : null
}

/** Batch variant for the approvals LIST — the latest failure per request id in
 *  ONE query, so building N summaries never fans out to N queries. */
export async function readApprovalLastFailures(
  tx: PrivilegedDb,
  orgId: string,
  approvalRequestIds: string[],
): Promise<Map<string, ApprovalLastFailure>> {
  const out = new Map<string, ApprovalLastFailure>()
  if (approvalRequestIds.length === 0) return out
  const rows = await tx.execute(drizzleSql`
    SELECT DISTINCT ON (approval_request_id) approval_request_id, error, finished_at
    FROM ${K}.approved_handler_executions
    WHERE org_id = ${orgId}
      AND approval_request_id IN (${drizzleSql.join(
        approvalRequestIds.map((id) => drizzleSql`${id}`),
        drizzleSql`, `,
      )})
      AND status IN ('failed_no_effect', 'ambiguous')
    ORDER BY approval_request_id, finished_at DESC NULLS LAST
  `)
  for (const fail of extractRows<FailRow>(rows)) {
    out.set(fail.approval_request_id, toFailure(fail))
  }
  return out
}
