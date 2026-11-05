// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"

/** The two members of a transaction handle the helper below needs. */
export interface SavepointHost<H> {
  execute(query: ReturnType<typeof sql.raw>): Promise<unknown>
  transaction<T>(fn: (savepoint: H) => Promise<T>): Promise<T>
}

const ANCHOR = "liaison_released_sp"

/**
 * Run `fn` in a savepoint of the transaction `tx` and release that savepoint
 * when `fn` ends, whether it returned or threw.
 *
 * The savepoint must be the driver's (`tx.transaction`): postgres.js keeps the
 * first failed query of a transaction scope and throws it again when the scope
 * ends, even after the caller caught it, so a raw `SAVEPOINT` statement around
 * a failing query still fails the whole transaction. The driver's savepoint
 * gives the failing query its own scope and rolls back to it on a throw.
 *
 * But postgres.js never RELEASEs a savepoint that succeeded, and a later
 * savepoint nests inside it: a job making hundreds of calls would stack
 * hundreds of open subtransactions. Released here through an anchor savepoint
 * set just before the driver's: releasing the anchor releases every savepoint
 * established after it, the driver's included. The anchor statements run in
 * the outer scope and cannot fail on a healthy transaction; the failing work
 * stays inside the driver's scope.
 *
 * Calls on one transaction must not interleave (the caller serializes them):
 * the anchor name is reused, and RELEASE names the latest one.
 */
export async function withReleasedSavepoint<H, T>(
  tx: SavepointHost<H>,
  fn: (savepoint: H) => Promise<T>,
): Promise<T> {
  await tx.execute(sql.raw(`SAVEPOINT ${ANCHOR}`))
  let result: T
  try {
    result = await tx.transaction(fn)
  } catch (err) {
    // The driver already rolled back to its own savepoint: the transaction is
    // healthy again, and the anchor goes like on success.
    await tx.execute(sql.raw(`RELEASE SAVEPOINT ${ANCHOR}`))
    throw err
  }
  await tx.execute(sql.raw(`RELEASE SAVEPOINT ${ANCHOR}`))
  return result
}
