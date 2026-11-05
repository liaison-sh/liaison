// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "~/db"

/**
 * How many sessions of this database are blocked waiting on a heavyweight lock
 * (a row, a relation, a transaction id, an advisory lock). With `relation`,
 * only waiters on that table. Lets a test wait until a concurrent statement is
 * actually queued behind another, instead of sleeping and hoping it got there.
 */
export async function pgLockWaiters(relation?: string): Promise<number> {
  if (relation) {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE NOT granted AND relation = ${relation}::regclass`
    return row?.n ?? 0
  }
  // From pg_locks, not pg_stat_activity.wait_event_type: a login that is not a
  // superuser sees no wait events of another login's sessions, and request
  // transactions run on their own login (liaison_request). The database and
  // pid columns of pg_stat_activity stay visible to everyone.
  const [row] = await sql<{ n: number }[]>`
    SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l
    WHERE NOT l.granted AND l.pid <> pg_backend_pid()
      AND l.pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database())`
  return row?.n ?? 0
}
