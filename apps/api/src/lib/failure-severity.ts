// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One answer to "is this failure a fault?", for every seam that logs one.
//
// An error-level line (pino level 50) means something in this server is broken:
// the production watchdog pages on every new error-level signature. Many failures
// are not that. A caller passed a bad argument, named something that does not
// exist or lacks a permission; a guard held a tool call; an upstream answered 429
// or 503; the caller hung up before the answer; a job found its lock held and asked
// to run later. Those are outcomes the caller (often the agent) is told about and
// acts on, so they log at warn with a stable `reason` field a dashboard can count.
//
// What stays at error: a 5xx we produced (500, 502, 504), a 503 because one of OUR
// own dependencies is down (database, Redis, search, maintenance: `ownDependencyDown`),
// and anything unclassified. An unknown throw is a fault until proven otherwise.
// Our own components' timeouts (a Postgres statement timeout, 57014) do not take the
// timeout shapes below and stay at error; the abort timers that guard outside calls
// (web fetch, the database gate) turn their abort into a typed error before any
// classifier sees it.

/** Why a failure logged at warn is an expected outcome, not a fault. */
export type ExpectedFailureReason =
  /** 400, 413, 422 and every other 4xx without a closer reason: the request must change. */
  | "invalid_request"
  /** 401, 403: a permission or a scope is missing. */
  | "forbidden"
  /** 404, 410: names nothing that exists (or nothing the caller may see). */
  | "not_found"
  /** 409, 412: the state does not allow it right now. */
  | "conflict"
  /** 429, or an upstream that said "too many calls". */
  | "rate_limited"
  /** 501: a deliberate "not supported for this input", never a crash. */
  | "unsupported"
  /** 503, or an upstream that dropped the connection after its retry. */
  | "upstream_unavailable"
  /** The caller (a closed tab, a cancelled turn, a timed out parent) went away. */
  | "caller_cancelled"
  /** An outside remote did not answer in time (a TimeoutError, a socket timeout). */
  | "timeout"
  /** Work stopped by an abort that does not say why (not known to be the caller, nor a timeout). */
  | "aborted"
  /** A platform guard (scope taint, approval policy) held the call on purpose. */
  | "guard_held"
  /** A job asked to run again later (a lock held by another run). */
  | "retry_later"

export type FailureSeverity =
  | { level: "warn"; reason: ExpectedFailureReason }
  | { level: "error"; reason?: undefined }

/**
 * A host-side ctx.fetch whose upstream dropped the connection, after the one
 * retry an idempotent read gets (sandbox/bridge/egress.ts). A 503 by class, but
 * an upstream outage the caller retries later, not a fault of ours.
 */
export const UPSTREAM_CONNECTION_CLOSED = "upstream_connection_closed"

/** The `name` of the error the sandbox raises when its caller went away. */
export const CALLER_CANCELLED_ERROR_NAME = "SandboxRequestCancelled"

export interface FailureFacts {
  /** HTTP class of the failure, when it has one. */
  status?: number
  /** The failure's own code, when it has one. */
  code?: unknown
  /** The thrown value, read for its name (cancellation) and nothing else. */
  err?: unknown
  /** A platform guard held the call (the caller knows; the error shape does not say). */
  guardHeld?: boolean
  /**
   * The failure is a 503 because one of our own dependencies is down (database, Redis,
   * search, maintenance), not an outside upstream: a fault, logged at error.
   */
  ownDependencyDown?: boolean
}

function statusReason(status: number): ExpectedFailureReason | undefined {
  if (status === 401 || status === 403) return "forbidden"
  if (status === 404 || status === 410) return "not_found"
  if (status === 409 || status === 412) return "conflict"
  if (status === 429) return "rate_limited"
  if (status >= 400 && status < 500) return "invalid_request"
  if (status === 501) return "unsupported"
  if (status === 503) return "upstream_unavailable"
  return undefined
}

const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
])

/**
 * True when a failure (or a cause it wraps) is a timeout: a TimeoutError (what
 * `AbortSignal.timeout()` rejects with), a socket timeout code, or an abort whose
 * reason was the string "timeout" (a fetch aborted with a reason rejects with it).
 */
export function isTimeoutFailure(err: unknown, depth = 0): boolean {
  if (depth > 3 || err == null) return false
  if (err === "timeout") return true
  if (typeof err !== "object") return false
  const e = err as { name?: unknown; code?: unknown; cause?: unknown }
  if (e.name === "TimeoutError") return true
  if (typeof e.code === "string" && TIMEOUT_CODES.has(e.code)) return true
  return isTimeoutFailure(e.cause, depth + 1)
}

/**
 * Why work stopped on an abort: the caller went away (the sandbox's own cancellation
 * error, or an abort caused by one), a timeout, or an abort that does not say.
 */
function abortReason(err: unknown): ExpectedFailureReason | undefined {
  if (typeof err !== "object" || err === null) return undefined
  const e = err as { name?: unknown; cause?: unknown }
  if (e.name === CALLER_CANCELLED_ERROR_NAME) return "caller_cancelled"
  if (e.name !== "AbortError") return undefined
  const cause = e.cause as { name?: unknown } | undefined
  if (cause?.name === CALLER_CANCELLED_ERROR_NAME) return "caller_cancelled"
  if (isTimeoutFailure(e.cause)) return "timeout"
  return "aborted"
}

/** Classify one failure: warn with its reason when it is an expected outcome, else error. */
export function classifyFailure(facts: FailureFacts): FailureSeverity {
  if (facts.ownDependencyDown) return { level: "error" }
  if (facts.guardHeld) return { level: "warn", reason: "guard_held" }
  const aborted = abortReason(facts.err)
  if (aborted) return { level: "warn", reason: aborted }
  if (isTimeoutFailure(facts.err)) return { level: "warn", reason: "timeout" }
  if (facts.code === UPSTREAM_CONNECTION_CLOSED) {
    return { level: "warn", reason: "upstream_unavailable" }
  }
  if (facts.err instanceof JobRetryLaterError) return { level: "warn", reason: "retry_later" }
  const reason = facts.status === undefined ? undefined : statusReason(facts.status)
  return reason ? { level: "warn", reason } : { level: "error" }
}

/** The pino-like surface `logFailure` writes to. */
export interface FailureLogger {
  warn(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

/**
 * Log one failure at the level `classifyFailure` gives it; a warn line carries
 * `reason`. Returns the classification so the caller can branch on it too.
 */
export function logFailure(
  logger: FailureLogger,
  facts: FailureFacts,
  fields: Record<string, unknown>,
  msg: string,
): FailureSeverity {
  const severity = classifyFailure(facts)
  if (severity.level === "warn") logger.warn({ ...fields, reason: severity.reason }, msg)
  else logger.error(fields, msg)
  return severity
}

/**
 * Thrown by a job handler that must run again later and has done nothing wrong
 * (a lock held by another run). The queue retries it as any failure; the worker
 * logs it at warn. Exhausting every retry still logs at error: by then the wait
 * itself is the fault.
 */
export class JobRetryLaterError extends Error {
  constructor(
    message: string,
    /** What the job waits on, for the log line ("lock_held"). */
    readonly waitingOn: string,
  ) {
    super(message)
    this.name = "JobRetryLaterError"
  }
}

/** The error a sandbox run rejects with when its caller went away before the answer. */
export function sandboxCancelledError(): Error {
  const err = new Error("Sandbox request cancelled by caller")
  err.name = CALLER_CANCELLED_ERROR_NAME
  return err
}

/**
 * A sandboxed run that never started: no process or slot became free before
 * its queue bound (a background run's own, else its deadline). Thrown by the
 * executors themselves (the QuickJS worker pool, the Workers admission, the
 * sandbox service's `queue_timeout` answer), never by app code, so a caller
 * may treat it as "nothing ran": a job is put back for later
 * (infra/jobs/jobs.ts) instead of failing. The message keeps the worker
 * pool's wording, which the error-kind readers match (run-settled.ts).
 */
export class SandboxQueueTimeoutError extends Error {
  readonly code = "queue_timeout"
  constructor(message = "Queued sandbox request timed out waiting for a free worker") {
    super(message)
    this.name = "SandboxQueueTimeoutError"
  }
}
