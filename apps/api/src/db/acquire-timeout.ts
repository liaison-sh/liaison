// SPDX-License-Identifier: FSL-1.1-ALv2
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "db-acquire-timeout" })

/**
 * Thrown when a DB transaction cannot acquire a pool connection within the
 * configured timeout. postgres.js queues pool-slot acquisition with NO timeout
 * (connect_timeout only bounds NEW-socket establishment), so under pool
 * saturation an unbounded acquire would hang to the caller's outer deadline --
 * for a sandboxed tool call that is the executeInSandbox ceiling (a genuine
 * multi-second-to-300s hang, observed live as cascading "App execution timed
 * out" across every app-tickets tool/job once the pool wedged). Failing fast
 * instead converts that hang into a loud, retryable, /diag-countable error.
 *
 * Shared by withPrivilegedDb (the dedicated privileged pool) and withRlsContext
 * (the main RLS/request pool) -- same failure shape, same fix, two call sites.
 */
export class DbAcquireTimeoutError extends Error {
  code = "db_pool_acquire_timeout"
  constructor(reason: string, timeoutMs: number) {
    super(`db pool acquire timed out after ${timeoutMs}ms (${reason}) -- connection pool exhausted`)
    this.name = "DbAcquireTimeoutError"
  }
}

/**
 * Run `work` (a `db.transaction(...)` promise) but reject fast if it has not
 * settled within `timeoutMs`. The dominant cause of an unsettled transaction
 * here is waiting for a free pool slot (the query has not even begun). On
 * timeout we reject with `DbAcquireTimeoutError`; the orphaned transaction, if
 * it later acquires a slot, runs and self-releases its connection, so no slot
 * is leaked BY THIS GUARD -- it only fails the caller fast, it does not cancel
 * the query. (Killing an already-running query is `statement_timeout`'s job,
 * applied inside the transaction body itself -- see withRlsContext.)
 *
 * `onTimeout` is an optional side-effect hook (e.g. incrementing a /diag
 * counter) invoked exactly once, synchronously, when the timeout wins the race
 * -- kept separate from the rejection so callers that don't care about metrics
 * (existing withPrivilegedDb behavior) are unaffected.
 */
export async function withAcquireTimeout<T>(
  reason: string,
  timeoutMs: number,
  work: Promise<T>,
  onTimeout?: () => void,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return work
  let timer: ReturnType<typeof setTimeout> | undefined
  // Don't let the orphaned `work` surface as an unhandled rejection if the
  // timeout wins the race.
  work.catch(() => {})
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          log.error({ reason, timeoutMs }, "db pool-slot acquire timed out -- pool exhausted")
          onTimeout?.()
          reject(new DbAcquireTimeoutError(reason, timeoutMs))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
