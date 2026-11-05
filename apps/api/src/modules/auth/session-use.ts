// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE FIRST USE OF A SESSION'S ACCESS TOKEN, ON THE SESSION ROW.
//
// A refresh whose response was lost leaves its client holding the spent token
// while the server holds an unused successor. A refresh whose client got the
// response uses the successor at once: the refresh exists to resend the
// request that met a 401. So "has the successor authenticated a request yet?"
// is what lets refreshSession (auth.ts) re-issue the successor to a client
// that never received it, and still treat any other replay of a rotated token
// as theft.
//
// One conditional UPDATE per session per process: the access token names its
// session (`sid`), and the row is written only while `used_at` is NULL. The
// set of sessions already stamped here is bounded and only skips writes; a
// node that forgets it writes the same no-op again.

import { and, eq, isNull } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { sessions } from "~/db/schema/kernel"
import { authLogger as log } from "~/lib/logger"

const STAMPED_MAX = 10_000
const stamped = new Set<string>()

/**
 * Records that `sessionId` authenticated a request. Never throws: a failed
 * write is logged and the request goes on (the cost is that a replay of the
 * predecessor inside the lost-response window is not recognised as theft).
 */
export async function noteSessionUse(sessionId: string): Promise<void> {
  if (stamped.has(sessionId)) return
  try {
    await withSystemDb("session-first-use", (db) =>
      db
        .update(sessions)
        .set({ usedAt: new Date() })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.usedAt))),
    )
    if (stamped.size >= STAMPED_MAX) stamped.clear()
    stamped.add(sessionId)
  } catch (err) {
    log.warn({ err, sessionId }, "session first-use stamp failed; continuing")
  }
}

/** Test seam: forget what this process already stamped. */
export function __resetSessionUseMemo(): void {
  stamped.clear()
}
