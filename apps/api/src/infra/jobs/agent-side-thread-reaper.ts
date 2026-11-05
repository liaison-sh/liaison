// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-T13: an all agent side thread that has gone quiet leaves the thread list.
//
// An agent opens a side thread with `threads_create`, the same tool a human
// facing turn uses; there is no separate "side thread" kind and this slice adds
// none (`agents_ask` nests inside the current thread, `agents_invite` seats an
// agent in an existing room). So the only ephemeral threads that exist are ones
// an agent chose to create, and this is what keeps them from accumulating.
//
// It HIDES, never deletes: the exchange stays readable by id and by search, it
// simply stops occupying the list. A thread with any human participant is never
// touched, however idle, because a human is in it and it is their room.
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "agent-side-thread-reaper" })

/** Twenty four hours idle before an all agent thread leaves the list. */
export const AGENT_SIDE_THREAD_IDLE_MS = 86_400_000

export const AGENT_SIDE_THREAD_REAPER_CRON = "7 * * * *"

/**
 * Hides every all agent thread whose last message is older than the TTL.
 * Idempotent: a thread already hidden matches nothing. Returns the ids it hid,
 * which is what the job logs and what a test counts.
 */
export async function runAgentSideThreadReaper(
  params: { now?: Date } = {},
): Promise<{ hiddenThreadIds: string[] }> {
  const cutoff = new Date((params.now?.getTime() ?? Date.now()) - AGENT_SIDE_THREAD_IDLE_MS)
  const K = sql.raw(schemaRef("kernel"))
  const rows = await withSystemDb("agent-side-thread-reaper", (db) =>
    db.execute(sql`
      WITH candidate AS (
        SELECT t.id
        FROM ${K}.threads t
        WHERE t.hidden_from_list = false
          AND EXISTS (
            SELECT 1 FROM ${K}.thread_participants p
            WHERE p.thread_id = t.id AND p.participant_type = 'agent'
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${K}.thread_participants p
            WHERE p.thread_id = t.id AND p.participant_type = 'user'
          )
          -- A thread that never got a message is measured from its own
          -- creation, so an empty one cannot sit in the list forever.
          AND COALESCE(
                (SELECT MAX(m.created_at) FROM ${K}.messages m WHERE m.thread_id = t.id),
                t.created_at
              ) < ${cutoff.toISOString()}::timestamptz
      )
      UPDATE ${K}.threads SET hidden_from_list = true
      WHERE id IN (SELECT id FROM candidate)
      RETURNING id::text AS id`),
  )
  const hiddenThreadIds = extractRows<{ id: string }>(rows).map((r) => r.id)
  if (hiddenThreadIds.length > 0) {
    log.info({ count: hiddenThreadIds.length }, "Hid idle agent side threads from the list")
  }
  return { hiddenThreadIds }
}
