// SPDX-License-Identifier: FSL-1.1-ALv2
import { type SQL, type SQLWrapper, sql } from "drizzle-orm"
import { OrgMovingError, withOrgWrite } from "~/modules/org/transfer-state/gate"
import { beginOrgSweep, movingOrgIds } from "~/modules/org/transfer-state/state"

/** Builds the WHERE fragment that leaves the moving orgs alone (`TRUE` when none is). */
export type NotMoving = (orgIdColumn: SQLWrapper) => SQL

/**
 * Run a cross-org sweep (`orgless-jobs.ts`) that leaves the orgs being moved
 * alone. `fn` gets `notMoving(column)`, a WHERE fragment over the org id column
 * (or SQL expression) of the rows it reads or writes. The moving set is read
 * once, and from that read until `fn` settles the sweep counts as a write in
 * flight for every other org: a freeze that lands meanwhile waits for it in the
 * quiesce, so nothing it writes escapes the move.
 *
 * Keep `fn` short (a statement or a page). A sweep that then acts per org over
 * time (mail, reminders) runs each org's action in `writeUnlessMoving`.
 * An unreadable move state throws: the sweep fails and its schedule retries,
 * rather than writing into a moved org.
 */
export async function sweepSkippingMoving<T>(fn: (notMoving: NotMoving) => Promise<T>): Promise<T> {
  const moving = await movingOrgIds()
  const end = beginOrgSweep(moving)
  try {
    return await fn((column) =>
      moving.length === 0
        ? sql`TRUE`
        : sql`${column} NOT IN (${sql.join(
            moving.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
    )
  } finally {
    end()
  }
}

/** What `writeUnlessMoving` returns when the org was moving. */
export const SKIPPED_MOVING = Symbol("skipped: the org is moving")

/**
 * One org's write from a cross-org sweep: counted, then checked again (the
 * sweep's moving set may be stale by now). An org that is frozen, incoming or
 * moved is skipped (`SKIPPED_MOVING`); the next run of the sweep picks it up
 * where it lives then.
 */
export async function writeUnlessMoving<T>(
  orgId: string,
  fn: () => Promise<T>,
): Promise<T | typeof SKIPPED_MOVING> {
  try {
    return await withOrgWrite(orgId, fn)
  } catch (err) {
    if (err instanceof OrgMovingError) return SKIPPED_MOVING
    throw err
  }
}
