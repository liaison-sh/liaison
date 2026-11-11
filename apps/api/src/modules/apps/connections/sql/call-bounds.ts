// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One SQL call inside its bounds: a statement timeout set on the database, and
// a deadline at which the statement is cancelled ON the database (not merely
// abandoned) and the call answers.

import type { ExecOptions } from "./transport"
import { DbTransportError } from "./transport"

/** After the deadline, how long the call waits for the cancelled statement to
 *  actually stop before answering anyway. */
export const CANCEL_GRACE_MS = 1_500

export interface SqlCallBudget {
  /** Upper bound on the call's statement timeout (a connection's own lower
   *  setting still applies). */
  statementTimeoutMs: number
  /** When the call gives up and cancels its statement. */
  deadlineMs: number
}

/**
 * Runs one database call inside its budget: the statement timeout is
 * capped below it, and at the deadline (or on the caller's abort) the
 * transport cancels the statement on the server and the bridge answers once
 * the call has settled, that is once the server has stopped the statement
 * (bounded by CANCEL_GRACE_MS). Answering at the abort itself left the
 * statement running after the call had already said it was cancelled. The
 * call's own promise is always observed, so its late rejection is never an
 * unhandled one.
 */
export async function withCallBounds<T>(
  deps: { signal?: AbortSignal; budget: SqlCallBudget },
  fn: (opts: ExecOptions) => Promise<T>,
): Promise<T> {
  const budget = deps.budget
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), budget.deadlineMs)
  const signal = deps.signal ? AbortSignal.any([deadline.signal, deps.signal]) : deadline.signal
  const abortError = () =>
    new DbTransportError(
      deadline.signal.aborted
        ? `The database did not answer within ${budget.deadlineMs} ms; the statement was cancelled on the database`
        : "The tool call was cancelled; the statement was cancelled on the database",
      "timeout",
    )
  try {
    if (signal.aborted) throw abortError()
    return await new Promise<T>((resolve, reject) => {
      const call = fn({ statementTimeoutMs: budget.statementTimeoutMs, signal })
      const settled = call.then(
        () => undefined,
        () => undefined,
      )
      const onAbort = () => {
        const err = abortError()
        const grace = setTimeout(() => reject(err), CANCEL_GRACE_MS)
        void settled.then(() => {
          clearTimeout(grace)
          reject(err)
        })
      }
      signal.addEventListener("abort", onAbort, { once: true })
      call
        .then(
          (value) => {
            if (!signal.aborted) resolve(value)
          },
          (err) => {
            if (!signal.aborted) reject(err)
          },
        )
        .finally(() => signal.removeEventListener("abort", onAbort))
    })
  } finally {
    clearTimeout(timer)
  }
}
