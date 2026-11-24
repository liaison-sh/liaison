// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Autosave saves a page every few seconds while someone types; the subscribers of
 * `knowledge.document.update` (routines, attention, audit, the search indexer, the
 * timeline, sockets) read the outbox, so the event is coalesced where it is queued:
 *
 * - an autosave whose page had an update event in the last 60 s queues none and marks
 *   the page `update_event_pending_at`;
 * - every other update (a person's other edits, an agent, an import, the API) queues
 *   its event at once, as before, and clears the mark;
 * - `flushPendingUpdateEvents`, every minute, queues the one owed event of each marked
 *   page whose last event is 60 s old, in the transaction that clears the mark, so a
 *   crash loses neither the mark nor the event.
 *
 * So a page being typed in emits at most one event a minute, plus one final event at
 * most two minutes after the last keystroke. Event names and `data.id` are unchanged.
 */
import { sql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { jobsLogger as log } from "~/lib/logger"
import { sweepSkippingMoving, writeUnlessMoving } from "~/modules/org/transfer-state/skip-moving"

/** At most one update event per page in this window while autosave runs. */
export const UPDATE_EVENT_WINDOW_SECONDS = 60
const FLUSH_BATCH = 200

/** Whether the page's last update event is younger than the window. */
export async function updateEventIsRecent(tx: RlsClient, documentId: string): Promise<boolean> {
  const [row] = extractRows<{ recent: boolean }>(
    await tx.execute(sql`
      SELECT COALESCE(update_event_at > now() - make_interval(secs => ${UPDATE_EVENT_WINDOW_SECONDS}), false) AS recent
        FROM ${knowledgeRel("documents")} WHERE id = ${documentId}::uuid`),
  )
  return row?.recent === true
}

/** The SET fragments of an update that queues its event now. */
export function stampEventNow() {
  return [sql`update_event_at = now()`, sql`update_event_pending_at = NULL`]
}

/** The SET fragment of an autosave whose event is owed. */
export function markEventPending() {
  return sql`update_event_pending_at = now()`
}

/**
 * Queue the owed update event of every marked page whose last event is old enough.
 * One privileged transaction per organisation claims a batch and queues its events.
 * Returns how many were queued. `beforeQueue` is a test hook (a crash between claim
 * and queue).
 */
export async function flushPendingUpdateEvents(
  opts: { beforeQueue?: () => void | Promise<void> } = {},
): Promise<number> {
  const orgs = extractRows<{ org_id: string }>(
    await sweepSkippingMoving((notMoving) =>
      withSystemDb("knowledge-update-event-flush-orgs", (db) =>
        db.execute(sql`
          SELECT DISTINCT org_id::text AS org_id FROM ${knowledgeRel("documents")}
           WHERE update_event_pending_at IS NOT NULL
             AND (update_event_at IS NULL
                  OR update_event_at <= now() - make_interval(secs => ${UPDATE_EVENT_WINDOW_SECONDS}))
             AND ${notMoving(sql.raw("org_id"))}`),
      ),
    ),
  )
  let queued = 0
  for (const { org_id: orgId } of orgs) {
    try {
      const n = await writeUnlessMoving(orgId, () => flushOrgUpdateEvents(orgId, opts))
      if (typeof n === "number") queued += n
    } catch (err) {
      // One organisation's failure leaves its marks for the next run; the others go on.
      log.error({ err, orgId }, "knowledge: owed update events not flushed")
    }
  }
  return queued
}

/** One organisation's owed events, in batches; each batch claims and queues in one transaction. */
export async function flushOrgUpdateEvents(
  orgId: string,
  opts: { beforeQueue?: () => void | Promise<void> } = {},
): Promise<number> {
  let queued = 0
  for (;;) {
    const n = await withPrivilegedDb(orgId, "knowledge-update-event-flush", async (tx) => {
      const claimed = extractRows<{ id: string; actor: string }>(
        await tx.execute(sql`
          UPDATE ${knowledgeRel("documents")} d
             SET update_event_pending_at = NULL, update_event_at = now()
           WHERE d.id IN (
             SELECT id FROM ${knowledgeRel("documents")}
              WHERE org_id = ${orgId}::uuid AND update_event_pending_at IS NOT NULL
                AND (update_event_at IS NULL
                     OR update_event_at <= now() - make_interval(secs => ${UPDATE_EVENT_WINDOW_SECONDS}))
              ORDER BY update_event_pending_at
              LIMIT ${FLUSH_BATCH}
              FOR UPDATE SKIP LOCKED)
             -- Re-checked on the locked row: a flush that waited finds it claimed.
             AND d.update_event_pending_at IS NOT NULL
          RETURNING d.id::text AS id, COALESCE(d.updated_by, d.created_by)::text AS actor`),
      )
      if (claimed.length > 0) await opts.beforeQueue?.()
      for (const row of claimed) {
        await tx.queueEvent({
          app: "knowledge",
          entity: "document",
          action: "update",
          entityId: row.id,
          data: { id: row.id, coalesced: true },
          actorId: row.actor,
          actorType: "user",
          orgId,
        })
      }
      return claimed.length
    })
    queued += n
    if (n < FLUSH_BATCH) return queued
  }
}
