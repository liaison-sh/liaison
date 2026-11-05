// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows } from "~/db"

export interface ListForContactInput {
  contactId: string
  limit?: number
}

export interface ContactTicketRow {
  id: string
  handle: string
  subject: string
  status: string
  lastActivityAt: string | null
}

export async function listForContact(
  tx: any,
  input: ListForContactInput,
): Promise<{ items: ContactTicketRow[] }> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
  const result = await tx.execute(drizzleSql`
    SELECT id::text AS id, handle, subject, status,
           last_message_at AS "lastActivityAt"
    FROM ${ticketsRel("tickets")}
    WHERE contact_id = ${input.contactId}
      AND merged_into_ticket_id IS NULL
    ORDER BY last_message_at DESC NULLS LAST
    LIMIT ${limit}
  `)
  const rows = extractRows<{
    id: string
    handle: string
    subject: string
    status: string
    lastActivityAt: string | Date | null
  }>(result)
  return {
    items: rows.map((r) => ({
      id: r.id,
      handle: r.handle,
      subject: r.subject,
      status: r.status,
      lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt).toISOString() : null,
    })),
  }
}
