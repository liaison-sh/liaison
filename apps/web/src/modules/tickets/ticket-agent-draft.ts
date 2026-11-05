// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-1 T10/T11. "An agent has a reply ready for this ticket" is not a column on
// the ticket: it is a PENDING gated `tickets:reply` approval whose payload names
// the ticket. The same fact drives the list's "Draft ready" pill and the detail
// screen's inline draft block, so it is derived in one place from the approvals
// store the rest of the app already keeps in sync over the WebSocket.
import type { ApprovalRequestSummary } from "@liaison/shared"
import { approvalsStore } from "~/modules/approvals/approvals-store"

export const TICKET_REPLY_TOOL = "tickets:reply"

/** The pending reply approval for `ticketId` among `rows`, or null. Pure, so a
 *  test states the rows instead of driving a store. */
export function findAgentDraft(
  rows: Iterable<ApprovalRequestSummary>,
  ticketId: string,
): ApprovalRequestSummary | null {
  for (const row of rows) {
    if (!row || row.status !== "pending") continue
    if (row.toolName !== TICKET_REPLY_TOOL) continue
    const payload = row.currentPayload as Record<string, unknown> | undefined
    if (payload?.ticketId !== ticketId) continue
    return row
  }
  return null
}

/** The pending agent draft for this ticket, read from the live store. */
export function agentDraftFor(ticketId: string): ApprovalRequestSummary | null {
  return findAgentDraft(Object.values(approvalsStore.byId), ticketId)
}

export function hasAgentDraft(ticketId: string): boolean {
  return agentDraftFor(ticketId) !== null
}
