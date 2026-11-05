// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { displayHandleOfRow, loadSegmentConfig } from "~/apps/tickets/display-handle"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import type { ClosedReason, TicketStatus } from "~/apps/tickets/state-machine"
import { applyEffects, validateTransition } from "~/apps/tickets/state-machine"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"

export { runCloseSilentCheck } from "~/apps/tickets/close-silent"

/** One org's SLA sweep: the fan-out runs it once per org with open tickets (its `runsFor`). */
export async function runSlaCheck(orgId: string): Promise<void> {
  await withSystemDb(`tickets-sla-check:${orgId}`, async (tx) => {
    const result = await tx.execute(drizzleSql`
      UPDATE ${ticketsRel("tickets")}
      SET sla_breached_at = now()
      WHERE org_id = ${orgId}
        AND sla_deadline < now()
        AND first_response_at IS NULL
        AND status = 'open'
        AND sla_paused_at IS NULL
        AND sla_breached_at IS NULL
      RETURNING id, handle, sla_deadline, priority, team, sensitivity, audience,
                category_id::text AS category_id, source_inbox_id::text AS source_inbox_id
    `)
    // The event names the ticket by its DISPLAY handle (`ticket-B2B-12`).
    const segment = await loadSegmentConfig(orgId)
    const rows = extractRows<{
      id: string
      handle: string
      sla_deadline: string | Date
      priority: string
      team: string | null
      sensitivity: string | null
    }>(result)
    for (const row of rows) {
      await tx.queueEvent({
        app: "tickets",
        entity: "sla",
        action: "breach",
        entityId: row.id,
        data: {
          ticketId: row.id,
          handle: displayHandleOfRow(row as unknown as Record<string, unknown>, segment),
          slaDeadline:
            row.sla_deadline instanceof Date ? row.sla_deadline.toISOString() : row.sla_deadline,
          breachedAt: new Date().toISOString(),
          priority: row.priority,
          // Carry the ticket's dimension values under their grant keys so the
          // WS-side hasDimensionAccess filter (tickets:team /
          // tickets:sensitivity) keeps sla-breach frames within the same
          // team/sensitivity scope RLS enforces on the ticket itself.
          "tickets:team": row.team,
          "tickets:sensitivity": row.sensitivity,
        },
        actorId: null,
        actorType: "system",
        orgId,
      })
    }
  })
}

interface FollowupRow {
  id: string
  status: TicketStatus
  closed_reason: ClosedReason | null
  merged_into_ticket_id: string | null
  converted_to_mail_conversation_id: string | null
  first_response_at: string | Date | null
}

/** One org's follow-up sweep: the fan-out runs it once per org awaiting a follow-up (its `runsFor`). */
export async function runFollowupCheck(orgId: string): Promise<void> {
  await withSystemDb(`tickets-followup-check:${orgId}`, async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT id, status, closed_reason, merged_into_ticket_id, converted_to_mail_conversation_id, first_response_at
      FROM ${ticketsRel("tickets")}
      WHERE org_id = ${orgId}
        AND status = 'awaiting_followup'
        AND followup_at <= now()
      ORDER BY followup_at ASC
      LIMIT 1000
    `)
    for (const row of extractRows<FollowupRow>(result)) {
      const validation = validateTransition(
        {
          status: row.status,
          closedReason: row.closed_reason,
          mergedIntoTicketId: row.merged_into_ticket_id,
          convertedToMailConversationId: row.converted_to_mail_conversation_id,
          firstResponseAt:
            row.first_response_at instanceof Date
              ? row.first_response_at.toISOString()
              : row.first_response_at,
        },
        { kind: "followupCron" },
      )
      if (!validation.ok) continue
      await applyEffects(tx, row.id, validation.effects, {
        actorType: "system",
        userId: "system:tickets:followup-check",
        orgId,
      })
    }
  })
}
