// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ticket-creation acknowledgement, sent once the ticket has COMMITTED.
//
// The inbound-mail path used to send it right after its own transaction, which
// it took for the commit. It is not: every caller runs `processInboundMessage`
// inside an outer transaction (the sync bridge's privileged transaction, or the
// sandboxed handler's), so its "transaction" is a savepoint and the ticket is
// still invisible to any other connection. The acknowledgement reads the ticket
// on its own connection, found nothing, and logged "ticket not found" for every
// new ticket while the customer never got the mail.
//
// So the request rides the ticket's own `ticket:create` event, queued in the
// same transaction as the ticket: the outbox publishes it only after the
// outermost commit (and never for a rolled-back ticket), and the handler below
// sends it. `sendTicketAcknowledgement` is send-once (`ack_sent_at`), so a
// redelivered event never sends twice.

import type { AppEvent } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "tickets-inbound" })

/** Event metadata naming a ticket whose acknowledgement goes out after commit. */
export const ACKNOWLEDGE_AFTER_COMMIT_METADATA = { acknowledgeAfterCommit: true } as const

function wantsAcknowledgement(event: AppEvent): boolean {
  if (event.ephemeral) return false
  if (event.app !== "tickets" || event.entity !== "ticket" || event.action !== "create") {
    return false
  }
  const metadata = event.metadata
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as Record<string, unknown>).acknowledgeAfterCommit === true
  )
}

/** The `once` bus handler: a committed `tickets/ticket:create` asking for its acknowledgement. */
export async function acknowledgeCommittedTicket(event: AppEvent): Promise<void> {
  if (!wantsAcknowledgement(event)) return
  const ticketId = event.entityId
  const orgId = event.orgId
  if (!ticketId || !orgId) return
  try {
    const { sendTicketAcknowledgement } = await import("~/apps/tickets/tools")
    const ack = await sendTicketAcknowledgement(ticketId, orgId)
    if ("error" in ack) {
      // The ticket committed before this event was published, so a ticket that
      // is gone now was deleted or merged away since: nothing to acknowledge.
      if (ack.error.code === "not_found") {
        log.warn({ ticketId, orgId }, "ticket acknowledgement skipped: the ticket no longer exists")
        return
      }
      log.error({ ticketId, orgId, err: ack.error }, "ticket acknowledgement send failed")
    }
  } catch (err) {
    log.error({ ticketId, orgId, err }, "ticket acknowledgement send threw")
  }
}
