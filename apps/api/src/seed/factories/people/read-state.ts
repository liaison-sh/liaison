// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The read state factory: where a person has read up to, in the org's
// conversations, tickets and mail. Read state is history only time produces
// (a person opening each conversation), so it is written directly, in the
// shape the product's own read marks take.
//
// Privileged raw SQL, by category: attention read state. The conversation
// cursors are one set-based statement (a window over each conversation's
// latest message, the badge's own unread rule) that the query builder cannot
// express; the ticket read marks and the mail read flags live in the tickets
// and mail apps' own tables, which have no host Drizzle schema. Every schema
// is resolved through `schemaRef`, so a prefixed test schema is followed.
import { sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { messagesListShows } from "~/modules/threads/thread"

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[]
}

/**
 * Write `userId`'s conversation cursors: read up to the latest message in
 * every conversation they are in, except the `keepUnread` most recent ones
 * the Messages list shows, which are read up to just before their latest
 * message (exactly one new message each). The unread rule is the badge's and
 * the list's (badge-count.ts): newer than the cursor, not the reader's own,
 * shown in the channel. Every row is rewritten on every run. Returns the
 * conversations left unread.
 */
export async function writeConversationReadState(
  orgId: string,
  userId: string,
  keepUnread: number,
): Promise<string[]> {
  const K = sql.raw(schemaRef("kernel"))
  return withPrivilegedDb(orgId, "seed-read-state", async (tx) => {
    const result = await tx.execute(sql`
      WITH mine AS (
        SELECT t.id FROM ${K}.threads t
        JOIN ${K}.thread_participants tp
          ON tp.thread_id = t.id AND tp.user_id = ${userId}::uuid
        WHERE t.org_id = ${orgId}::uuid
      ),
      latest AS (
        SELECT DISTINCT ON (m.thread_id) m.thread_id, m.created_at
        FROM ${K}.messages m JOIN mine ON mine.id = m.thread_id
        WHERE m.deleted_at IS NULL
          AND (m.reply_root_id IS NULL OR m.also_in_channel)
          AND NOT (m.author_id = ${userId}::uuid AND m.author_type IN ('user', 'system'))
        ORDER BY m.thread_id, m.created_at DESC, m.id DESC
      ),
      kept AS (
        SELECT l.thread_id FROM latest l
        JOIN ${K}.threads t ON t.id = l.thread_id
        WHERE ${messagesListShows(K)}
        ORDER BY l.created_at DESC, l.thread_id
        LIMIT ${keepUnread}
      ),
      cursors AS (
        SELECT mine.id AS thread_id,
          CASE WHEN mine.id IN (SELECT thread_id FROM kept) THEN (
            SELECT m.id FROM ${K}.messages m, latest l
            WHERE l.thread_id = mine.id AND m.thread_id = mine.id AND m.deleted_at IS NULL
              AND m.created_at < l.created_at
            ORDER BY m.created_at DESC, m.id DESC LIMIT 1
          ) ELSE (
            SELECT m.id FROM ${K}.messages m
            WHERE m.thread_id = mine.id AND m.deleted_at IS NULL
            ORDER BY m.created_at DESC, m.id DESC LIMIT 1
          ) END AS message_id
        FROM mine
      ),
      written AS (
        INSERT INTO ${K}.user_thread_state
          (user_id, thread_id, org_id, last_read_message_id, last_read_at)
        SELECT ${userId}::uuid, c.thread_id, ${orgId}::uuid, c.message_id,
               CASE WHEN c.message_id IS NULL THEN NULL ELSE now() END
        FROM cursors c
        ON CONFLICT (user_id, thread_id) DO UPDATE SET
          last_read_message_id = EXCLUDED.last_read_message_id,
          last_read_at = EXCLUDED.last_read_at
        RETURNING thread_id
      )
      SELECT thread_id FROM written WHERE thread_id IN (SELECT thread_id FROM kept)`)
    return rowsOf<{ thread_id: string }>(result).map((r) => String(r.thread_id))
  })
}

/** Whether a table exists (an app's tables exist only once it is installed). */
async function tableExists(tx: PrivilegedDb, schema: string, table: string): Promise<boolean> {
  const result = await tx.execute(
    sql`SELECT to_regclass(${`${schema}.${table}`}) IS NOT NULL AS ok`,
  )
  return rowsOf<{ ok: boolean }>(result)[0]?.ok === true
}

/**
 * Mark the org's tickets and mail conversations read by `userId`, except the
 * one mail conversation `keepMailConversationId` names. Skips an app that is
 * not installed. Returns the tickets and mail conversations marked.
 */
export async function markAppBacklogRead(
  orgId: string,
  userId: string,
  keepMailConversationId: string,
): Promise<number> {
  const ticketsSchema = schemaRef("app_tickets")
  const mailSchema = schemaRef("app_mail")
  const TICKETS = sql.raw(ticketsSchema)
  const MAIL = sql.raw(mailSchema)
  return withPrivilegedDb(orgId, "seed-backlog-read", async (tx) => {
    let marked = 0
    if (await tableExists(tx, ticketsSchema, "ticket_reads")) {
      const result = await tx.execute(
        sql`INSERT INTO ${TICKETS}.ticket_reads (ticket_id, user_id, org_id, read_at)
            SELECT t.id, ${userId}::uuid, t.org_id, now()
            FROM ${TICKETS}.tickets t WHERE t.org_id = ${orgId}::uuid
            ON CONFLICT (ticket_id, user_id) DO UPDATE SET read_at = now()
            RETURNING ticket_id`,
      )
      marked += rowsOf(result).length
    }
    if (await tableExists(tx, mailSchema, "conversations")) {
      await tx.execute(
        sql`UPDATE ${MAIL}.messages SET is_read = true
            WHERE org_id = ${orgId}::uuid AND is_read = false
              AND conversation_id <> ${keepMailConversationId}::uuid`,
      )
      const result = await tx.execute(
        sql`UPDATE ${MAIL}.conversations SET is_read = true
            WHERE org_id = ${orgId}::uuid AND is_read = false AND id <> ${keepMailConversationId}::uuid
            RETURNING id`,
      )
      marked += rowsOf(result).length
    }
    return marked
  })
}
