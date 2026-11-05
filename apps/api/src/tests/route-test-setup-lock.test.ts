// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Regression test for the route-test-setup advisory-lock hang.
 *
 * `acquireDbLock` (route-test-setup.ts) runs `SELECT pg_advisory_lock(...)`
 * on a bare reserved connection to serialise file-level TRUNCATE/bootstrap
 * across the whole bun:test process. A session-level advisory lock held by a
 * crashed/killed run is never released automatically, so a fresh acquire on
 * the same key used to hang FOREVER with no timeout and no log line -- none
 * of withPrivilegedDb's / withRlsContext's DbAcquireTimeoutError protection
 * applies to a bare query like this. `acquireAdvisoryLock` bounds that wait.
 *
 * This test deliberately talks to the DB directly with its OWN lock id,
 * never touching route-test-setup's shared module-level mutex/lock id, so it
 * cannot interfere with other files' beforeAll/afterAll serialisation.
 */
import { afterAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { DbAcquireTimeoutError } from "~/db/acquire-timeout"
import { acquireAdvisoryLock } from "~/tests/route-test-setup"

// Distinct from ROUTE_TEST_LOCK_ID in route-test-setup.ts and from any other
// lock id used elsewhere in the suite. Each test below uses its own id: once
// a `waiter` connection is abandoned mid pg_advisory_lock (the poisoned-
// connection case under test), releasing the holder's lock hands the lock to
// that zombied waiter's still in-flight query, not to whoever asks next on
// the same id -- so tests sharing an id would deadlock each other.
const TEST_LOCK_ID_HELD = 9_381_274_999
const TEST_LOCK_ID_FREE = 9_381_275_000

describe("acquireAdvisoryLock", () => {
  const reserved: Array<Awaited<ReturnType<typeof sql.reserve>>> = []

  afterAll(async () => {
    // Best-effort cleanup: unlock + release every connection we reserved
    // that is still usable (the one that timed out is deliberately never
    // queried again, per acquireAdvisoryLock's contract, so skip it here by
    // only cleaning up the holder connection explicitly in each test).
    for (const conn of reserved) {
      conn.release()
    }
  })

  it("rejects with DbAcquireTimeoutError instead of hanging when another session already holds the lock", async () => {
    // Deliberately NOT pushed to `reserved`: it holds the lock for the rest
    // of the test run and must never be released back to the pool for
    // reuse while still holding it (see the no-unlock rationale below).
    const holder = await sql.reserve()
    await holder`SELECT pg_advisory_lock(${TEST_LOCK_ID_HELD})`

    const waiter = await sql.reserve()
    const start = Date.now()
    await expect(acquireAdvisoryLock(waiter, TEST_LOCK_ID_HELD, 300)).rejects.toThrow(
      DbAcquireTimeoutError,
    )
    const elapsed = Date.now() - start
    // Without the fix, pg_advisory_lock blocks until the holder releases --
    // here that is forever (the holder never unlocks during this test), so
    // any bound well under bun's 60s test timeout proves the fix is live.
    expect(elapsed).toBeLessThan(5_000)

    // `waiter` is poisoned per acquireAdvisoryLock's contract: never query or
    // release it again -- its pg_advisory_lock call may still be in flight
    // server-side. Deliberately do NOT unlock `holder` here: doing so would
    // hand TEST_LOCK_ID_HELD to that still-pending, abandoned waiter query
    // (exactly the pathology this fix defends against), wedging the id for
    // the rest of the process. Leave it locked; Postgres releases session
    // locks automatically when `holder`'s connection eventually closes.
  })

  it("resolves normally when the lock is free", async () => {
    const conn = await sql.reserve()
    reserved.push(conn)
    await expect(acquireAdvisoryLock(conn, TEST_LOCK_ID_FREE, 5_000)).resolves.toBeUndefined()
    await conn`SELECT pg_advisory_unlock(${TEST_LOCK_ID_FREE})`
  })
})
