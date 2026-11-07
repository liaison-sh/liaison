// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * Run `fn(tx)` inside an open transaction until it settles or `signal` aborts.
 *
 * On abort the transaction callback rejects at once, so the driver rolls the
 * transaction back and returns its connection to the pool, even when `fn` is
 * still running (a hung provider, a loop that never yields its result). From
 * that moment the handle `fn` holds is closed: any statement it issues next
 * throws instead of reaching the connection, which by then may belong to
 * another caller. A statement already sent finishes first (the rollback runs
 * after it on the same connection), so the caller bounds it with a
 * `statement_timeout`.
 */
export async function runUntilAborted<Tx, T>(
  tx: Tx,
  fn: (tx: Tx) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortError(signal)
  const session = (tx as { session?: { client?: unknown } }).session
  if (!session || typeof session.client !== "function") {
    throw new Error("runUntilAborted: the transaction handle has no driver client to close")
  }
  const state = { closed: false }
  session.client = guardClient(session.client as DriverFn, state)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      state.closed = true
      reject(abortError(signal))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([fn(tx), aborted])
  } finally {
    // Closed whichever way it ended: work `fn` left running after it settled
    // must not reach the connection once the transaction is gone either.
    state.closed = true
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

type DriverFn = ((...args: unknown[]) => unknown) & Record<PropertyKey, unknown>

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error("transaction aborted")
}

function closedError(): Error {
  return new Error("the transaction was aborted: this statement was not run")
}

/**
 * The driver's transaction client (postgres.js `TransactionSql`), refusing every
 * call once `state.closed`. A savepoint's own client is guarded the same way.
 */
function guardClient(client: DriverFn, state: { closed: boolean }): DriverFn {
  return new Proxy(client, {
    apply(target, thisArg, args) {
      if (state.closed) throw closedError()
      return Reflect.apply(target, thisArg, args)
    },
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        if (state.closed) throw closedError()
        const wrapped =
          prop === "savepoint"
            ? args.map((a) =>
                typeof a === "function"
                  ? (inner: DriverFn) => (a as (c: DriverFn) => unknown)(guardClient(inner, state))
                  : a,
              )
            : args
        return (value as (...a: unknown[]) => unknown).apply(target, wrapped)
      }
    },
  }) as DriverFn
}
