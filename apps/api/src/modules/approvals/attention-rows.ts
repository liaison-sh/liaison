// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT A STORED ATTENTION ROW ABOUT A REQUEST CAN SAY NOW.
//
// Two kinds of stored row name a request: the reminder that it waits ("Waiting more than 24 hours
// for a decision", routed-reminders.ts) and the line that says how it ended (`approval_decision`).
// The row is written once and the request goes on, so the feed asks the request each time, with
// the reader's own visibility: a reminder is only worth a row while this person can still decide
// it, and a decision names what it was about. A request that expired with no decision did not do
// what it asked: when that would have reached outside the organisation (an invoice issued, a reply
// sent), its line says who and how much, from the card's own lines, and stays in the way on Home.
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { isUuid } from "~/lib/uuid"
import {
  type CallersDecisionRow,
  FEED_STATUS_SQL,
  isCallersDecision,
  readCurrentScopes,
  resolveApprovalImpact,
} from "~/modules/approvals/attention"
import { splitToolName } from "~/modules/approvals/event-data"
import { withViewerNames } from "~/modules/apps/approval-record-names"
import { isRestrictedScope } from "~/modules/permissions/restricted-scope"

const K = drizzleSql.raw(schemaRef("kernel"))

export interface RequestNow {
  /** It waits (or stalled) and this person may decide it: the rule of the approvals feed. */
  theirs: boolean
  /**
   * What it is about, when its card has a title of its own, with each record called what the reader
   * may call it. Null for a request about a restricted record: Home names nothing of it.
   */
  title: string | null
  /** The tool it asks for: whose app the row is about. */
  toolName: string
  /**
   * Its card's lines (who it was for, the amount), in the reader's words, at most three. Empty for
   * a request about a restricted record, like the title.
   */
  lines: string[]
  /**
   * It expired with no decision and its action would have reached outside the organisation: what
   * it asked was never done, and nothing will do it unless someone asks again.
   */
  leftUndone: boolean
}

type Row = CallersDecisionRow & {
  open: boolean
  summary: { title?: unknown; lines?: unknown; impact?: "external" | "internal" } | null
  current_payload: Record<string, unknown> | null
  proposing_turn_scopes: string[] | null
}

/** The title its card was given: the action in words alone would be English in any language's line. */
function ownTitle(r: Row): string | null {
  const title = r.summary?.title
  return typeof title === "string" && title.trim() !== "" && title !== r.tool_name ? title : null
}

/** The card's lines worth a decision row: words only, the first three. */
function ownLines(r: Row): string[] {
  const lines = r.summary?.lines
  return Array.isArray(lines)
    ? lines.filter((l): l is string => typeof l === "string" && l.trim() !== "").slice(0, 3)
    : []
}

/** Expired undecided, on an action that leaves the organisation (fail-safe: undeclared is). */
function leftUndone(orgId: string, r: Row): boolean {
  if (r.status !== "expired") return false
  const { appName, toolShortName } = splitToolName(r.tool_name)
  return resolveApprovalImpact(orgId, appName, toolShortName, r.summary?.impact) === "external"
}

/** The requests of `ids` the reader can see, as they are now. One read; none when nothing names one. */
export async function readRequestsNow(
  tx: RlsClient,
  orgId: string,
  readerId: string,
  ids: readonly string[],
): Promise<Map<string, RequestNow>> {
  const unique = [...new Set(ids)].filter(isUuid)
  if (unique.length === 0) return new Map()
  const scopes = await readCurrentScopes(tx)
  const stored = extractRows<Row>(
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
  const rows = await withViewerNames(tx, orgId, stored)
  return new Map(
    rows.map((r) => {
      const restricted = (r.proposing_turn_scopes ?? []).some(isRestrictedScope)
      return [
        r.id,
        {
          theirs: r.open === true && isCallersDecision(r, readerId, scopes),
          title: restricted ? null : ownTitle(r),
          toolName: r.tool_name,
          lines: restricted ? [] : ownLines(r),
          leftUndone: leftUndone(orgId, r),
        },
      ]
    }),
  )
}
