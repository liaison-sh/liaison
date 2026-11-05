// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows } from "~/db"

export interface MarkReadInput {
  ticketId: string
  userId: string
  orgId?: string
  lastReadMessageId?: string | null
  candidateReadAt?: string
}

export interface MarkReadResult {
  readAt: string
  lastReadMessageId: string | null
  /**
   * The ticket was unread (the `projectReadState` predicate) before this mark
   * and is read after it. The caller tells every open client then, and only
   * then: an idempotent re-read of an already read ticket changes nothing.
   */
  becameRead: boolean
}

export interface MarkReadError {
  error: { code: "ticket_not_found" | "invalid_params"; message: string }
}

export async function markRead(
  tx: any,
  input: MarkReadInput,
): Promise<MarkReadResult | MarkReadError> {
  const candidate = input.candidateReadAt ?? new Date().toISOString()
  // Normalize blank/empty strings to null: some callers pass "" to mean "no
  // last read message" instead of omitting the field or passing null/undefined.
  // last_read_message_id is a uuid column; Postgres rejects "" outright.
  const rawLastMsg = input.lastReadMessageId
  const lastMsg =
    typeof rawLastMsg === "string" && rawLastMsg.trim() === "" ? null : (rawLastMsg ?? null)
  // `was_unread` is `projectReadState`'s own predicate, read before the mark.
  const ticketRows = extractRows<{ id: string; was_unread: boolean }>(
    await tx.execute(drizzleSql`
      SELECT t.id,
             (t.last_inbound_at IS NOT NULL
               AND t.status <> 'closed'
               AND NOT EXISTS (
                 SELECT 1 FROM ${ticketsRel("ticket_reads")} tr
                 WHERE tr.ticket_id = t.id AND tr.read_at >= t.last_inbound_at
               )) AS was_unread
      FROM ${ticketsRel("tickets")} t
      WHERE t.id = ${input.ticketId}
      LIMIT 1
    `),
  )
  if (ticketRows.length === 0) {
    return {
      error: { code: "ticket_not_found", message: "Ticket is not available" },
    }
  }
  if (lastMsg) {
    const messageRows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${ticketsRel("messages")}
        WHERE id = ${lastMsg}::uuid AND ticket_id = ${input.ticketId}::uuid
        LIMIT 1
      `),
    )
    if (messageRows.length === 0) {
      return {
        error: {
          code: "invalid_params",
          message: "lastReadMessageId must belong to the ticket",
        },
      }
    }
  }
  // Insert by SELECT-from-tickets: when the ticket isn't visible/exists in the
  // RLS context (or under privileged ctx, when the ticket simply doesn't exist),
  // no row is produced and we return an error envelope.
  const result = await tx.execute(drizzleSql`
    INSERT INTO ${ticketsRel("ticket_reads")} (ticket_id, user_id, org_id, read_at, last_read_message_id)
    SELECT t.id, ${input.userId}, t.org_id, ${candidate}::timestamptz, ${lastMsg}
    FROM ${ticketsRel("tickets")} t
    WHERE t.id = ${input.ticketId}
    ON CONFLICT (ticket_id, user_id) DO UPDATE
      SET read_at = GREATEST(${ticketsRel("ticket_reads")}.read_at, EXCLUDED.read_at),
          last_read_message_id = CASE
            WHEN EXCLUDED.read_at >= ${ticketsRel("ticket_reads")}.read_at
            THEN COALESCE(EXCLUDED.last_read_message_id, ${ticketsRel("ticket_reads")}.last_read_message_id)
            ELSE ${ticketsRel("ticket_reads")}.last_read_message_id
          END
    RETURNING read_at, last_read_message_id,
      (${ticketsRel("ticket_reads")}.read_at >= (
        SELECT t2.last_inbound_at FROM ${ticketsRel("tickets")} t2 WHERE t2.id = ${input.ticketId}
      )) AS covers_inbound
  `)
  const rows = extractRows<{
    read_at: string
    last_read_message_id: string | null
    covers_inbound: boolean | null
  }>(result)
  if (rows.length === 0) {
    return {
      error: { code: "ticket_not_found", message: "Ticket is not available" },
    }
  }
  const row = rows[0]
  return {
    readAt: new Date(row.read_at).toISOString(),
    lastReadMessageId: row.last_read_message_id ?? null,
    becameRead: Boolean(ticketRows[0]?.was_unread) && row.covers_inbound === true,
  }
}

export interface InboxCountsInput {
  inboxIds?: string[]
}

export interface InboxCount {
  inboxId: string
  unread: number
}

export interface ReadStateProjection {
  unread: boolean
  readByCount: number
  readByRecent: Array<{ userId: string; name: string | null; readAt: string }>
}

/**
 * Compute org-global read-state projection per ticketId. Returns a map keyed by
 * ticket id. Tickets with `last_inbound_at IS NULL` or status='closed' get
 * `unread=false`.
 */
export async function projectReadState(
  tx: any,
  ticketIds: string[],
): Promise<Record<string, ReadStateProjection>> {
  if (ticketIds.length === 0) return {}
  const idValues = ticketIds.map((id) => drizzleSql`${id}::uuid`)
  const idList = drizzleSql.join(idValues, drizzleSql`, `)
  const result = await tx.execute(drizzleSql`
    WITH per_ticket AS (
      SELECT t.id::text AS ticket_id,
             t.status,
             t.last_inbound_at,
             EXISTS (
               SELECT 1 FROM ${ticketsRel("ticket_reads")} tr
               WHERE tr.ticket_id = t.id
                 AND tr.read_at >= t.last_inbound_at
             ) AS any_read,
             COALESCE((
               SELECT COUNT(*)::int FROM ${ticketsRel("ticket_reads")} tr
               WHERE tr.ticket_id = t.id
                 AND tr.read_at >= t.last_inbound_at
             ), 0) AS read_by_count,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'userId', tr.user_id,
                 'name', u.name,
                 'readAt', tr.read_at
               ) ORDER BY tr.read_at DESC) FROM (
                 SELECT user_id, read_at FROM ${ticketsRel("ticket_reads")} tr2
                 WHERE tr2.ticket_id = t.id
                   AND tr2.read_at >= t.last_inbound_at
                 ORDER BY read_at DESC
                 LIMIT 3
               ) tr
               LEFT JOIN ${kernelRel("users")} u ON u.id = tr.user_id
             ), '[]'::jsonb) AS recent
      FROM ${ticketsRel("tickets")} t
      WHERE t.id IN (${idList})
    )
    SELECT * FROM per_ticket
  `)
  const rows = extractRows<{
    ticket_id: string
    status: string
    last_inbound_at: string | Date | null
    any_read: boolean
    read_by_count: number
    recent: Array<{ userId: string; name: string | null; readAt: string }>
  }>(result)
  const map: Record<string, ReadStateProjection> = {}
  for (const r of rows) {
    const inbound = r.last_inbound_at !== null && r.last_inbound_at !== undefined
    const isClosed = r.status === "closed"
    const unread = inbound && !isClosed && !r.any_read
    map[r.ticket_id] = {
      unread,
      readByCount: inbound ? Number(r.read_by_count ?? 0) : 0,
      readByRecent: inbound
        ? (r.recent ?? []).map((p) => ({
            userId: String(p.userId),
            name: p.name ?? null,
            readAt: new Date(p.readAt).toISOString(),
          }))
        : [],
    }
  }
  return map
}

/**
 * Unread per inbox, plus `totalUnread` when no inbox filter is given.
 *
 * The per-inbox rows only see tickets whose `source_inbox_id` is a live inbox.
 * The web's "All" badge used to SUM them, so every unread ticket with no source
 * inbox (imported, agent- or API-created, or from an archived inbox) was
 * missing from it while the "All" list showed it: the walk read "All 4" over a
 * list with far more unread rows. `totalUnread` counts every visible unread
 * ticket with the same predicate, whatever its inbox.
 */
export async function inboxCounts(
  tx: any,
  input: InboxCountsInput,
): Promise<{ counts: InboxCount[]; totalUnread?: number }> {
  const inboxIdValues = (input.inboxIds ?? []).map((id) => drizzleSql`${id}::uuid`)
  const inboxList = drizzleSql.join(inboxIdValues, drizzleSql`, `)
  const filter =
    input.inboxIds && input.inboxIds.length > 0
      ? drizzleSql`AND i.id IN (${inboxList})`
      : drizzleSql``
  const result = await tx.execute(drizzleSql`
    SELECT i.id::text AS "inboxId",
           COALESCE(COUNT(t.id) FILTER (
             WHERE t.status <> 'closed'
               AND t.merged_into_ticket_id IS NULL
               AND t.last_inbound_at IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM ${ticketsRel("ticket_reads")} tr
                 WHERE tr.ticket_id = t.id
                   AND tr.read_at >= t.last_inbound_at
               )
           ), 0)::int AS "unread"
    FROM ${ticketsRel("inboxes")} i
    LEFT JOIN ${ticketsRel("tickets")} t ON t.source_inbox_id = i.id
    WHERE i.archived_at IS NULL
      ${filter}
    GROUP BY i.id, i.name
    ORDER BY i.name ASC, i.id DESC
  `)
  const rows = extractRows<{ inboxId: string; unread: number }>(result)
  if (input.inboxIds && input.inboxIds.length > 0) return { counts: rows }
  const totalRows = extractRows<{ unread: number }>(
    await tx.execute(drizzleSql`
      SELECT COUNT(*)::int AS "unread"
      FROM ${ticketsRel("tickets")} t
      WHERE t.status <> 'closed'
        AND t.merged_into_ticket_id IS NULL
        AND t.last_inbound_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${ticketsRel("ticket_reads")} tr
          WHERE tr.ticket_id = t.id
            AND tr.read_at >= t.last_inbound_at
        )
    `),
  )
  return { counts: rows, totalUnread: Number(totalRows[0]?.unread ?? 0) }
}
