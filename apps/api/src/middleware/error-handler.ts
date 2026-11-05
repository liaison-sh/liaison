// SPDX-License-Identifier: FSL-1.1-ALv2
import { redactSecretShapes } from "@liaison/shared"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { QueueBackpressureError } from "~/infra/jobs/backpressure"
import { env } from "~/lib/env"
import { trackError } from "~/lib/error-tracker"
import { rootLogger } from "~/lib/logger"
import { pgErrorFacts } from "~/lib/transient-db-error"

const STATUS_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  402: "CREDITS_EXHAUSTED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  422: "INVALID_ARGUMENT",
  429: "RATE_LIMITED",
}

// Provider SDK errors (OpenAI, Anthropic, Google) carry a numeric `status` and a string
// `code`, which is exactly the shape our own typed errors use, so they take the branch
// below and their message reaches the client. Those messages can quote the credential
// ("Incorrect API key provided: sk-proj-****abcd"), so every secret-shaped token is
// masked before the message leaves, whoever threw it (`redactSecretShapes`, shared with the
// agent's failure notices).

/** How long a client should wait before retrying an action the job queues refused. */
const BACKPRESSURE_RETRY_AFTER_SEC = 30

/** The QueueBackpressureError behind `err`, directly or as its `cause` (a wrapper may rethrow). */
function backpressureCause(err: unknown): QueueBackpressureError | null {
  for (let e = err, depth = 0; e && depth < 5; depth++) {
    if (e instanceof QueueBackpressureError) return e
    e = (e as { cause?: unknown }).cause
  }
  return null
}

export function errorHandler(err: Error, c: Context) {
  // The job queues refused new work (Redis memory or a queue backlog past its
  // bound, infra/jobs/backpressure.ts). This is overload, not a bug: answer
  // 503 with Retry-After so the client retries, never a 500. Writes a handler
  // made inside a transaction around the enqueue rolled back with it. The
  // queue and the reason are logged; the client gets no internals.
  const busy = backpressureCause(err)
  if (busy) {
    rootLogger.warn(
      {
        err: busy,
        queue: busy.queueName,
        reason: busy.reason,
        path: c.req.path,
        method: c.req.method,
      },
      "Request refused by job queue backpressure",
    )
    c.header("Retry-After", String(BACKPRESSURE_RETRY_AFTER_SEC))
    return c.json(
      {
        error: {
          message: "The server is busy and could not accept this right now. Please retry shortly.",
          code: "SERVER_BUSY",
        },
      },
      503,
    )
  }

  if (err instanceof HTTPException) {
    rootLogger.warn({ err, path: c.req.path, method: c.req.method }, err.message)
    // A subclass that names its refusal (`readonly code`) keeps that code, so a
    // client can tell it apart from any other answer with the same status.
    const own = "code" in err && typeof err.code === "string" ? err.code : undefined
    const code = own ?? STATUS_CODES[err.status]
    return c.json({ error: { message: err.message, ...(code && { code }) } }, err.status)
  }

  const typedErr = err as Error & { status?: number; code?: string; details?: unknown }
  if (typeof typedErr.status === "number" && typeof typedErr.code === "string") {
    rootLogger.warn({ err, path: c.req.path, method: c.req.method }, err.message)
    // A provider refusing ITS credentials (Gmail, a model API: 401) is not this
    // session expiring: passed through, the web client read it as one and
    // signed the person out. Our own auth answers through HTTPException above.
    const status = typedErr.status === 401 ? 502 : typedErr.status
    return c.json(
      {
        error: {
          message: redactSecretShapes(err.message),
          code: typedErr.code,
          ...(typedErr.details !== undefined ? { details: typedErr.details } : {}),
        },
      },
      status as any,
    )
  }

  // Every unhandled failure gets a short reference, logged beside the error and
  // returned to the client, so the person who hit it can quote something that
  // finds the exact log line instead of "it said something went wrong".
  const ref = crypto.randomUUID().slice(0, 8)
  const sqlState = pgErrorFacts(err)?.code ?? null
  rootLogger.error(
    { err, path: c.req.path, method: c.req.method, errorRef: ref, sqlState },
    sqlState === "25P02"
      ? "Unhandled error: transaction aborted by an EARLIER statement whose error was caught without a savepoint (use onConflictDoNothing or tx.transaction)"
      : "Unhandled error",
  )
  trackError(err, { path: c.req.path, method: c.req.method })
  const detail = env.EXPOSE_ERROR_DETAIL ? err.message : undefined
  return c.json(
    {
      error: {
        message: "Internal server error",
        code: "INTERNAL_ERROR",
        ref,
        ...(detail && { detail }),
      },
    },
    500,
  )
}
