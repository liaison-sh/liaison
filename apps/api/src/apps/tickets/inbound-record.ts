// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { cancelSilentCloseOnReply } from "~/apps/tickets/close-silent"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import { type ValidationResult, validateAndApply } from "~/apps/tickets/state-machine"
import type { PrivilegedDb, RlsClient, RlsTx } from "~/db"
import { rootLogger } from "~/lib/logger"

type SqlClient = RlsClient | RlsTx | PrivilegedDb

export interface RecordInboundOnTicketParams {
  orgId: string
  ticketId: string
  sentAt: string
  actor: {
    actorType: "user" | "agent" | "system" | "mcp"
    userId: string
    orgId: string
  }
}

export interface RecordInboundOnTicketResult {
  transition: ValidationResult
}

/**
 * The single choke point for "an inbound customer message landed on an
 * EXISTING ticket". Every ingestion path (IMAP/Gmail sync, the public
 * tickets-create webhook append, future connectors) must funnel through this
 * so the counters, timestamps and the state-machine transition never drift
 * from one another between paths.
 */
export async function recordInboundOnTicket(
  tx: SqlClient,
  params: RecordInboundOnTicketParams,
): Promise<RecordInboundOnTicketResult> {
  const { orgId, ticketId, sentAt, actor } = params

  await tx.execute(drizzleSql`
    UPDATE ${ticketsRel("tickets")}
    SET message_count = message_count + 1,
        last_message_at = GREATEST(
          COALESCE(last_message_at, LEAST(${sentAt}::timestamptz, now())),
          LEAST(${sentAt}::timestamptz, now())
        ),
        -- Clamp a future-dated sender header to now() before it ever reaches
        -- GREATEST: an unclamped future Date header would otherwise pin
        -- last_inbound_at in the future and it could never be caught up by a
        -- later, honestly-timestamped message.
        last_inbound_at = GREATEST(
          COALESCE(last_inbound_at, LEAST(${sentAt}::timestamptz, now())),
          LEAST(${sentAt}::timestamptz, now())
        ),
        -- The customer answered: a later silence starts a new nudge cycle.
        nudge_sent_at = NULL,
        updated_at = now()
    WHERE id = ${ticketId} AND org_id = ${orgId}
  `)

  // The customer wrote back: a pending nudge or no-response close no longer applies.
  await cancelSilentCloseOnReply(tx, orgId, ticketId)

  let result: ValidationResult
  try {
    result = await validateAndApply(tx, ticketId, { kind: "inbound" }, actor)
  } catch (err) {
    rootLogger.warn(
      { module: "tickets-inbound", ticketId, err },
      "inbound message did not reopen the ticket",
    )
    return {
      transition: { ok: false, code: "transition_failed", message: "inbound transition failed" },
    }
  }
  if (result.ok === false) {
    rootLogger.warn(
      { module: "tickets-inbound", ticketId, code: result.code },
      "inbound message did not reopen the ticket",
    )
  }

  return { transition: result }
}
