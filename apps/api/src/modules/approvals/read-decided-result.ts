// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"

// Match handler-protocol.ts's kernel schema ref verbatim.
const K = drizzleSql.raw(schemaRef("kernel"))

/**
 * Reads the decided gated-tool result persisted by runApprovedToolHandler.
 * Returns null when no successful decided execution row exists yet (pending /
 * denied / failed) — liaison_approval_status distinguishes by approval status,
 * not by result presence.
 *
 * `on`: a privileged transaction the caller already holds, read on instead of
 * taking a second privileged slot.
 */
export async function readDecidedResult(
  orgId: string,
  approvalRequestId: string,
  on?: PrivilegedDb,
): Promise<unknown> {
  const read = (tx: PrivilegedDb) =>
    tx.execute(drizzleSql`
      SELECT result
      FROM ${K}.approved_handler_executions
      WHERE approval_request_id = ${approvalRequestId} AND status = 'succeeded'
      LIMIT 1
    `)
  const res = on
    ? await read(on)
    : await withPrivilegedDb(orgId, "approval-read-decided-result", read)
  const [row] = extractRows<{ result: unknown }>(res)
  return row?.result ?? null
}
