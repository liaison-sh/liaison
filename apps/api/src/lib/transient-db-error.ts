// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Detect a TRANSIENT postgres error that is SAFE to retry — a write that aborted
// before commit (serialization_failure / deadlock_detected / a connection blip),
// so the transaction rolled back ATOMICALLY and re-issuing the identical call (a
// fresh transaction) is correct, never a duplicate. postgres.js wraps the driver
// error as `Failed query: <sql>` and hangs the real PostgresError off `.cause`,
// whose `.code` is the 5-char SQL state.
//
// Deliberately EXCLUDES connection-POOL exhaustion (53300 too_many_connections /
// "db pool acquire timed out" / "remaining connection slots"): that is a CAPACITY
// bug to FIX, not to mask by retrying (the BL-131 lesson: the QA harness makes
// the same exclusion at the run level). Retrying a starved
// pool just deepens the starvation.

/** Postgres SQL states that are inherently transient + safe to retry (the txn rolled back). */
const TRANSIENT_SQLSTATES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "57P01", // admin_shutdown (server closed the connection)
])

/** Message signatures (lowercased) for the same conditions when no SQL state is present
 *  (postgres.js connection-layer errors carry a message but no PG SQL state). */
const TRANSIENT_MESSAGE_SIGNATURES = [
  "deadlock detected",
  "could not serialize",
  "connection ended",
  "connection terminated",
  "connection closed",
  "write cannot be made on a closed connection",
  "write after end",
  "connection_ended",
]

/** Pool-exhaustion signatures we must NOT treat as retryable (fix the capacity, don't mask it). */
const POOL_EXHAUSTION_SIGNATURES = [
  "too many clients",
  "remaining connection slots",
  "db pool acquire timed out",
  "pool acquire timed out",
]

/**
 * True iff `err` (or any error in its `.cause` chain) is a transient, retry-safe
 * postgres write-contention / connection error — NOT pool exhaustion.
 */
export function isTransientDbError(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; cur != null && depth < 6; depth++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown }
    const msg = typeof e.message === "string" ? e.message.toLowerCase() : ""
    // Pool exhaustion is explicitly NOT transient-retryable — bail out the moment we see it.
    if (POOL_EXHAUSTION_SIGNATURES.some((s) => msg.includes(s))) return false
    if (typeof e.code === "string" && TRANSIENT_SQLSTATES.has(e.code)) return true
    if (TRANSIENT_MESSAGE_SIGNATURES.some((s) => msg.includes(s))) return true
    cur = e.cause
  }
  return false
}

/** What `retryOnTransientDbError` reports before each retry. */
export interface TransientDbRetryInfo {
  /** 1 for the first retry. */
  attempt: number
  delayMs: number
  code: string | null
  message: string | null
}

/**
 * Run `op` and, when it throws a transient error (`isTransientDbError`: a
 * deadlock, a serialization failure, a connection blip), run it again, up to
 * `retries` more times, waiting `delayMs(attempt)` before each retry. Only for
 * an `op` that opens its OWN transaction: the failed one rolled back whole, so
 * a re-run is a fresh attempt, never a duplicate. Any other error, and the last
 * transient one once the retries are spent, is rethrown unchanged.
 */
export async function retryOnTransientDbError<T>(
  op: () => Promise<T>,
  opts: {
    retries: number
    delayMs: (attempt: number) => number
    onRetry?: (info: TransientDbRetryInfo) => void
  },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op()
    } catch (err) {
      if (attempt > opts.retries || !isTransientDbError(err)) throw err
      const delayMs = Math.max(0, opts.delayMs(attempt))
      const cause = describeDbError(err)
      opts.onRetry?.({ attempt, delayMs, code: cause.code, message: cause.message })
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

/** Extract the underlying PostgresError `{ code, message, constraintName }` from a
 *  postgres.js "Failed query" wrapper for diagnostic logging (the wrapper's own
 *  message is just the SQL text). Returns the deepest cause that carries a SQL-state
 *  `code`. `constraintName` comes straight off postgres.js's PostgresError (error
 *  field code 110 / `n`, `connection.js`'s errorFields table assigns it as
 *  `constraint_name` via `Object.assign(this, x)`), so a unique-violation check can
 *  match the STRUCTURED constraint name instead of substring-matching the message. */
export function describeDbError(err: unknown): {
  code: string | null
  message: string | null
  constraintName: string | null
} {
  let cur: unknown = err
  let best: { code: string | null; message: string | null; constraintName: string | null } = {
    code: null,
    message: null,
    constraintName: null,
  }
  for (let depth = 0; cur != null && depth < 6; depth++) {
    const e = cur as {
      code?: unknown
      message?: unknown
      constraint_name?: unknown
      cause?: unknown
    }
    if (typeof e.message === "string" && !best.message) best = { ...best, message: e.message }
    if (typeof e.constraint_name === "string" && !best.constraintName)
      best = { ...best, constraintName: e.constraint_name }
    if (typeof e.code === "string")
      best = {
        code: e.code,
        message: typeof e.message === "string" ? e.message : best.message,
        constraintName:
          typeof e.constraint_name === "string" ? e.constraint_name : best.constraintName,
      }
    cur = e.cause
  }
  return best
}

const SQLSTATE = /^[0-9A-Z]{5}$/
/** `withPgCause` (sandbox/bridge/shared.ts) rewrap: "<Failed query …> — pg: <pg message> (<SQLSTATE>)"
 *  (a plain hyphen is accepted too, as some hand-built rewraps use one).
 *  Only `message` survives the sandbox IPC, so this text is all a host sees. */
const PG_REWRAP = /\s[—-]\spg:\s([\s\S]*?)(?:\s\(([0-9A-Z]{5})\))?\s*$/

/**
 * The postgres-side facts of a DB error with the query text and bound params
 * removed: the SQLSTATE, the server's own message (e.g. `invalid input syntax
 * for type uuid: "none"`), and the constraint name. Returns null when `err` is
 * not a database error. Works on a live DrizzleQueryError/PostgresError chain
 * AND on the message-only rewrap that crosses the sandbox boundary.
 *
 * Never hand `err.message` of a DB error to a caller: Drizzle's message is
 * `Failed query: <sql>\nparams: <values>`, which leaks schema, tenant ids and
 * whatever the other bound values were.
 */
export function pgErrorFacts(
  err: unknown,
): { code: string | null; message: string | null; constraintName: string | null } | null {
  const described = describeDbError(err)
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : ""
  const rewrap = PG_REWRAP.exec(raw)
  if (described.code && SQLSTATE.test(described.code)) {
    // The chain carried a real PostgresError: its message is the server's text.
    const pgMessage =
      described.message && !described.message.startsWith("Failed query")
        ? described.message
        : (rewrap?.[1] ?? null)
    return {
      code: described.code,
      message: pgMessage,
      constraintName: described.constraintName,
    }
  }
  if (rewrap) {
    return { code: rewrap[2] ?? null, message: rewrap[1] ?? null, constraintName: null }
  }
  if (raw.startsWith("Failed query")) {
    return { code: null, message: null, constraintName: null }
  }
  return null
}

/**
 * Map a DB error thrown out of a tool handler to a typed, caller-safe error.
 * The agent gets a code it can act on and a message with no SQL, no params;
 * the caller logs the full error server-side. Null when `err` is not a DB error.
 */
export function callerSafeDbError(err: unknown): {
  code: string
  message: string
  retryable: boolean
  status: number
  facts: { code: string | null; message: string | null; constraintName: string | null }
} | null {
  const facts = pgErrorFacts(err)
  if (!facts) return null
  const on = facts.constraintName ? ` (${facts.constraintName})` : ""
  switch (facts.code) {
    case "23505":
      return {
        code: "conflict",
        message: `An item with the same unique value already exists${on}. Look it up and update it instead of creating a duplicate.`,
        retryable: false,
        status: 409,
        facts,
      }
    case "23503":
      return {
        code: "invalid_reference",
        message: `A referenced item does not exist or is not accessible${on}. Check the ids you passed.`,
        retryable: false,
        status: 422,
        facts,
      }
    case "23502":
      return {
        code: "invalid_params",
        message: "A required value is missing. Check the tool's required parameters and retry.",
        retryable: false,
        status: 422,
        facts,
      }
    case "23514":
      return {
        code: "invalid_params",
        message: `A value breaks a data rule${on}. Check the parameter values and retry.`,
        retryable: false,
        status: 422,
        facts,
      }
    case "22P02":
      // invalid_text_representation: a value of the wrong shape for its column, most often a
      // name, number or external reference passed where a UUID id is expected. The caller's
      // error to correct, not a server fault.
      return {
        code: "invalid_params",
        message:
          "A value has the wrong format for its field (for example a name or an external reference passed where an id is expected). Check the ids you passed.",
        retryable: false,
        status: 422,
        facts,
      }
    case "42501":
      return {
        code: "forbidden",
        message: "You do not have permission to write this item.",
        retryable: false,
        status: 403,
        facts,
      }
    default:
      return {
        code: "db_error",
        message: "The operation failed on a database error and did not take effect.",
        retryable: false,
        status: 500,
        facts,
      }
  }
}
