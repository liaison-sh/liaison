// SPDX-License-Identifier: FSL-1.1-ALv2

import type { ApprovalLastFailure } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { readApprovalLastFailure } from "~/modules/approvals/last-failure"
import { readDecidedResult } from "~/modules/approvals/read-decided-result"

const K = drizzleSql.raw(schemaRef("kernel"))

// The post-approval failure shape is the shared `ApprovalLastFailure` — the SAME
// value the attention-feed card renders, read through the one helper below.
// Re-exported for existing importers.
export type { ApprovalLastFailure }

/** The `request-N` label the approval card prints — what the agent should
 *  cite to the user; the uuid stays the tool-call key. */
type WithHandle = { handle: string }

export type ApprovalStatusResult =
  | ({ state: "pending"; last_failure?: ApprovalLastFailure } & WithHandle)
  | ({ state: "approved"; result: unknown } & WithHandle)
  | ({ state: "denied"; reason?: string } & WithHandle)
  | ({ state: "withdrawn" } & WithHandle)
  | ({ state: "cancelled" } & WithHandle)
  | ({ state: "unknown"; raw_status: string } & WithHandle)
  | { state: "not_found" }

/**
 * Pulls the decided outcome of a gated approval (spec C7 "Outcome retrieval").
 * Re-invoking the original tool is NOT the retrieval path — this reads the
 * persisted decided result via readDecidedResult (Task 3).
 */
export async function getApprovalStatus(
  orgId: string,
  approvalRequestId: string,
): Promise<ApprovalStatusResult> {
  if (!approvalRequestId) return { state: "not_found" }

  const rows = await withPrivilegedDb(orgId, "mcp-approval-status", (tx) =>
    tx.execute(drizzleSql`
      SELECT status, reason, handle
      FROM ${K}.approval_requests
      WHERE id = ${approvalRequestId} AND org_id = ${orgId}
      LIMIT 1
    `),
  )
  const [row] = extractRows<{ status: string; reason: string | null; handle: string }>(rows)
  if (!row) return { state: "not_found" }
  const handle = row.handle

  switch (row.status) {
    case "approved": {
      const result = await readDecidedResult(orgId, approvalRequestId)
      return { state: "approved", handle, result }
    }
    case "denied":
      return { state: "denied", handle, reason: row.reason ?? undefined }
    case "expired":
      return { state: "denied", handle, reason: "expired" }
    case "withdrawn":
      return { state: "withdrawn", handle }
    case "cancelled":
      return { state: "cancelled", handle }
    case "pending":
    case "approving":
    case "deferred": {
      // pending / approving — surface the persisted failure (ONE source:
      // approved_handler_executions, via readApprovalLastFailure) so a request
      // that came back to pending after a failed execution is not an indistinct
      // "pending" but carries WHY (e.g. the carrier's rejection text).
      const last = await withPrivilegedDb(orgId, "mcp-approval-status-failure", (tx) =>
        readApprovalLastFailure(tx, orgId, approvalRequestId),
      )
      return last ? { state: "pending", handle, last_failure: last } : { state: "pending", handle }
    }
    default:
      // Fail closed: an unrecognised status must never be reported as the
      // reassuring "pending" default. Surface the real persisted value so a
      // caller cannot mistake it for still awaiting human approval.
      return { state: "unknown", handle, raw_status: row.status }
  }
}
