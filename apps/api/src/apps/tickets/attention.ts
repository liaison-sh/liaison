// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { displayHandleOfRow, loadSegmentConfig } from "~/apps/tickets/display-handle"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"

type SqlClient = RlsClient | RlsTx | PrivilegedDb

interface TicketRow {
  id: string
  handle: string
  sla_deadline: string | Date | null
  sla_target_seconds: number
  last_inbound_at: string | Date | null
  last_outbound_at: string | Date | null
  followup_at: string | Date | null
  updated_at: string | Date
  /** Selected by the awaiting-a-reply rule only. */
  assigned_to?: string | null
}

function toIso(value: string | Date | null | undefined): string {
  if (!value) return new Date().toISOString()
  return value instanceof Date ? value.toISOString() : value
}

export async function computeAttentionItems(
  tx: SqlClient,
  orgId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _callerUserId?: string,
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = []
  // Summaries and metadata name the ticket by its DISPLAY handle
  // (`ticket-B2B-12`), from the row's current segment field.
  const segment = await loadSegmentConfig(orgId)
  const h = (row: TicketRow): string =>
    displayHandleOfRow(row as unknown as Record<string, unknown>, segment)

  // Monitoring inboxes (inboxes.suppress_attention, e.g. automated bug
  // reports) are telemetry, not conversations — their tickets never raise
  // automatic attention items. Rule 4 (followup_due) is deliberately NOT
  // filtered: a follow-up is an explicit agent-set reminder.
  const notSuppressedInbox = drizzleSql`
      (source_inbox_id IS NULL OR source_inbox_id NOT IN (
        SELECT id FROM ${ticketsRel("inboxes")}
        WHERE org_id = ${orgId} AND suppress_attention = true
      ))`

  // Inboxes carry an optional attention cutoff (set by historical imports /
  // mailbox backfills): tickets whose relevant activity predates it are old
  // records, not live work, and must not flood the feed. New activity after
  // the cutoff re-qualifies the ticket. Rule 4 (followup_due) stays unfiltered,
  // same rationale as suppress_attention above.
  //
  // The activity column MUST be table-qualified: inside the NOT EXISTS
  // subquery an unqualified `created_at` binds to the inbox row, not the
  // outer ticket.
  const outerTicket = ticketsRel("tickets")
  const afterInboxCutoff = (activityTs: ReturnType<typeof drizzleSql>) => drizzleSql`
      NOT EXISTS (
        SELECT 1 FROM ${ticketsRel("inboxes")} ci
        WHERE ci.id = ${outerTicket}.source_inbox_id
          AND ci.org_id = ${orgId}
          AND ci.attention_cutoff_at IS NOT NULL
          AND ${activityTs} < ci.attention_cutoff_at
      )`

  // Rule 1: SLA risk — within 25% of deadline, not yet first-responded.
  const slaRisk = await tx.execute(drizzleSql`
    SELECT id, handle, sla_deadline, sla_target_seconds, last_inbound_at, last_outbound_at, followup_at, updated_at,
           audience, team, category_id::text AS category_id, source_inbox_id::text AS source_inbox_id
    FROM ${ticketsRel("tickets")}
    WHERE org_id = ${orgId}
      AND first_response_at IS NULL
      AND merged_into_ticket_id IS NULL
      AND status = 'open'
      AND sla_paused_at IS NULL
      AND sla_breached_at IS NULL
      AND sla_deadline <= now() + (sla_target_seconds * 0.25 * INTERVAL '1 second')
      AND ${notSuppressedInbox}
      AND ${afterInboxCutoff(drizzleSql`${outerTicket}.created_at`)}
    LIMIT 200
  `)
  for (const row of extractRows<TicketRow>(slaRisk)) {
    const remainingMs = new Date(toIso(row.sla_deadline)).getTime() - Date.now()
    const totalMs = row.sla_target_seconds * 1000
    const ratio = totalMs > 0 ? Math.max(0, Math.min(1, 1 - remainingMs / totalMs)) : 1
    const urgency = Math.min(100, Math.round(50 + ratio * 50))
    items.push({
      id: `sla_risk:${row.id}`,
      app: "tickets",
      entity: "ticket",
      entityId: row.id,
      kind: "sla_risk",
      summary: `SLA approaching for ${h(row)}`,
      urgency,
      occurredAt: toIso(row.updated_at),
      action: { type: "open_entity", tabType: "tickets:ticket", entityId: row.id },
      metadata: {
        handle: h(row),
        slaDeadline: toIso(row.sla_deadline),
        slaSecondsLeft: Math.max(0, Math.round(remainingMs / 1000)),
      },
    })
  }

  // Rule 2: Awaiting agent — last message inbound, status open. The row names
  // its assignee: Home keeps a ticket assigned to the viewer in "Needs you"
  // and files the rest under Your queues (D21).
  const awaiting = await tx.execute(drizzleSql`
    SELECT id, handle, sla_deadline, sla_target_seconds, last_inbound_at, last_outbound_at, followup_at, updated_at,
           audience, team, category_id::text AS category_id, source_inbox_id::text AS source_inbox_id,
           assigned_to::text AS assigned_to
    FROM ${ticketsRel("tickets")}
    WHERE org_id = ${orgId}
      AND merged_into_ticket_id IS NULL
      AND status = 'open'
      AND last_inbound_at IS NOT NULL
      AND (last_outbound_at IS NULL OR last_inbound_at > last_outbound_at)
      AND ${notSuppressedInbox}
      AND ${afterInboxCutoff(drizzleSql`${outerTicket}.last_inbound_at`)}
    LIMIT 200
  `)
  for (const row of extractRows<TicketRow>(awaiting)) {
    items.push({
      id: `awaiting_agent:${row.id}`,
      app: "tickets",
      entity: "ticket",
      entityId: row.id,
      kind: "awaiting_agent",
      summary: `Awaiting agent reply on ${h(row)}`,
      urgency: 60,
      occurredAt: toIso(row.last_inbound_at),
      action: { type: "open_entity", tabType: "tickets:ticket", entityId: row.id },
      metadata: {
        handle: h(row),
        lastInboundAt: toIso(row.last_inbound_at),
        assignedTo: row.assigned_to ?? null,
      },
    })
  }

  // Rule 3: Unassigned — open ticket with no assignee, > 1 hour old.
  const unassigned = await tx.execute(drizzleSql`
    SELECT id, handle, sla_deadline, sla_target_seconds, last_inbound_at, last_outbound_at, followup_at, updated_at,
           audience, team, category_id::text AS category_id, source_inbox_id::text AS source_inbox_id
    FROM ${ticketsRel("tickets")}
    WHERE org_id = ${orgId}
      AND merged_into_ticket_id IS NULL
      AND status = 'open'
      AND assigned_to IS NULL
      AND created_at <= now() - INTERVAL '1 hour'
      AND ${notSuppressedInbox}
      AND ${afterInboxCutoff(drizzleSql`COALESCE(${outerTicket}.last_inbound_at, ${outerTicket}.created_at)`)}
    LIMIT 200
  `)
  for (const row of extractRows<TicketRow>(unassigned)) {
    items.push({
      id: `unassigned:${row.id}`,
      app: "tickets",
      entity: "ticket",
      entityId: row.id,
      kind: "unassigned",
      summary: `Unassigned ticket ${h(row)}`,
      urgency: 40,
      occurredAt: toIso(row.updated_at),
      action: { type: "open_entity", tabType: "tickets:ticket", entityId: row.id },
      metadata: { handle: h(row) },
    })
  }

  // Rule 4: Followup due — awaiting_followup with followup_at within 1h.
  const followup = await tx.execute(drizzleSql`
    SELECT id, handle, sla_deadline, sla_target_seconds, last_inbound_at, last_outbound_at, followup_at, updated_at,
           audience, team, category_id::text AS category_id, source_inbox_id::text AS source_inbox_id
    FROM ${ticketsRel("tickets")}
    WHERE org_id = ${orgId}
      AND merged_into_ticket_id IS NULL
      AND status = 'awaiting_followup'
      AND followup_at IS NOT NULL
      AND followup_at <= now() + INTERVAL '1 hour'
    LIMIT 200
  `)
  for (const row of extractRows<TicketRow>(followup)) {
    items.push({
      id: `followup_due:${row.id}`,
      app: "tickets",
      entity: "ticket",
      entityId: row.id,
      kind: "followup_due",
      summary: `Follow-up due on ${h(row)}`,
      urgency: 55,
      occurredAt: toIso(row.followup_at),
      action: { type: "open_entity", tabType: "tickets:ticket", entityId: row.id },
    })
  }

  // Rule 5: Nudge due — awaiting_customer tickets with no outbound in 7d and no nudge yet.
  const nudge = await tx.execute(drizzleSql`
    SELECT id, handle, sla_deadline, sla_target_seconds, last_inbound_at, last_outbound_at, followup_at, updated_at,
           audience, team, category_id::text AS category_id, source_inbox_id::text AS source_inbox_id
    FROM ${ticketsRel("tickets")}
    WHERE org_id = ${orgId}
      AND merged_into_ticket_id IS NULL
      AND status = 'awaiting_customer'
      AND nudge_sent_at IS NULL
      AND last_outbound_at < now() - INTERVAL '7 days'
      AND ${notSuppressedInbox}
      AND ${afterInboxCutoff(drizzleSql`${outerTicket}.last_outbound_at`)}
    LIMIT 200
  `)
  for (const row of extractRows<TicketRow>(nudge)) {
    items.push({
      id: `nudge_due:${row.id}`,
      app: "tickets",
      entity: "ticket",
      entityId: row.id,
      kind: "nudge_due",
      summary: `Nudge stale ticket ${h(row)}`,
      urgency: 30,
      occurredAt: toIso(row.last_outbound_at ?? row.updated_at),
      action: { type: "open_entity", tabType: "tickets:ticket", entityId: row.id },
    })
  }

  return items
}
