// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A RESTRICTED TABLE WITHOUT AN OWNER HAS NO DECIDER. An agent's change to a table shared with
// some people only is decided by the table's owner alone (tools.ts, tableDecider): the org's
// deciders may not read it, and the requester must never decide for their own agent. When the
// owner's account is erased (erase-user.ts sets owner_user_id to NULL), a gated change is refused
// before any approval is staged, and one already waiting for that owner is cancelled in the
// erasure's own transaction with the same reason: nobody may approve it any more.

import { sql as drizzleSql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { loadApprovalSummary } from "~/modules/approvals/event-data"

export const OWNERLESS_MESSAGE =
  "this table is shared with some people only and has no owner (its owner's account was erased), so nobody may approve an agent's change to it: the table needs an owner first. Ask an editor of the table to make the change by hand, or an admin to share it with the whole organisation."

/** The reason a waiting change gets when its table's owner is erased. */
export const OWNERLESS_CANCEL_REASON = `Cancelled: ${OWNERLESS_MESSAGE}`

/** The table tools whose approvals are routed to a restricted table's owner. */
const TABLE_APPROVAL_TOOLS = ["kernel:tables_rows_write", "kernel:tables_edit"]

/**
 * Cancel the pending table approvals routed to `userId` as a table's owner, in the erasure's
 * transaction; each emits the update event every terminal transition emits. Returns their ids.
 */
export async function cancelOwnerlessTableApprovals(
  tx: PrivilegedDb,
  orgId: string,
  userId: string,
): Promise<string[]> {
  const K = drizzleSql.raw(schemaRef("kernel"))
  const tools = drizzleSql.join(
    TABLE_APPROVAL_TOOLS.map((t) => drizzleSql`${t}`),
    drizzleSql`, `,
  )
  const ids = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${K}.approval_requests
         SET status = 'cancelled', decided_at = now(), reason = ${OWNERLESS_CANCEL_REASON}
       WHERE org_id = ${orgId}::uuid AND status = 'pending'
         AND resource_owner_id = ${userId}::uuid AND tool_name IN (${tools})
      RETURNING id::text AS id`),
  ).map((r) => r.id)
  for (const id of ids) {
    await tx.queueEvent({
      app: "kernel",
      entity: "approval_request",
      action: "update",
      entityId: id,
      orgId,
      actorId: null,
      actorType: "system",
      data: await loadApprovalSummary(tx, orgId, id),
    })
  }
  return ids
}
