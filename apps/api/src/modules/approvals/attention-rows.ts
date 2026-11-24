// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT A STORED ATTENTION ROW ABOUT A REQUEST CAN SAY NOW.
//
// Two kinds of stored row name a request: the reminder that it waits ("Waiting more than 24 hours
// for a decision", routed-reminders.ts) and the line that says how it ended (`approval_decision`).
// The row is written once and the request goes on, so the feed asks the request each time, with
// the reader's own visibility: a reminder is only worth a row while this person can still decide
// it, and a decision names what it was about.
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import {
  approvalRowName,
  type CallersDecisionRow,
  FEED_STATUS_SQL,
  isCallersDecision,
  readCurrentScopes,
} from "~/modules/approvals/attention"
import { isRestrictedScope } from "~/modules/permissions/restricted-scope"

const K = drizzleSql.raw(schemaRef("kernel"))
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface RequestNow {
  /** It waits (or stalled) and this person may decide it: the rule of the approvals feed. */
  theirs: boolean
  /** What it is about. Null for a request about a restricted record: Home names nothing of it. */
  title: string | null
}

type Row = CallersDecisionRow & {
  open: boolean
  summary: { title?: string } | null
  current_payload: Record<string, unknown> | null
  proposing_turn_scopes: string[] | null
}

/** The requests of `ids` the reader can see, as they are now. One read; none when nothing names one. */
export async function readRequestsNow(
  tx: RlsClient,
  orgId: string,
  readerId: string,
  ids: readonly string[],
): Promise<Map<string, RequestNow>> {
  const unique = [...new Set(ids)].filter((id) => UUID_RE.test(id))
  if (unique.length === 0) return new Map()
  const scopes = await readCurrentScopes(tx)
  const rows = extractRows<Row>(
    await tx.execute(drizzleSql`
      SELECT ar.id::text AS id, ar.tool_name, ar.status, ar.metadata, ar.notify_user_ids,
             ar.requested_by, ar.approve_scope, ar.resource_owner_id,
             ar.summary, ar.current_payload, ar.proposing_turn_scopes,
             ${FEED_STATUS_SQL} AS open
        FROM ${K}.approval_requests ar
       WHERE ar.org_id = ${orgId}::uuid
         AND ar.id IN (${drizzleSql.join(
           unique.map((id) => drizzleSql`${id}::uuid`),
           drizzleSql`, `,
         )})`),
  )
  return new Map(
    rows.map((r) => [
      r.id,
      {
        theirs: r.open === true && isCallersDecision(r, readerId, scopes),
        title: (r.proposing_turn_scopes ?? []).some(isRestrictedScope)
          ? null
          : approvalRowName(r, {}).title,
      },
    ]),
  )
}
