// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * A `ToolError` is a handler's explicit, auditable opt-in that its `.message`
 * is SAFE to surface to the caller (the agent / tool result) even when the
 * app runs untrusted in production.
 *
 * WHY THIS EXISTS
 * ---------------
 * Sandboxed (untrusted) app handlers run inside QuickJS in a separate worker
 * process. Only a thrown error's serialized shape crosses that boundary, and
 * the host cannot tell a safe, caller-actionable domain message ("no invoice
 * for this order") from a leaky one that might carry secrets or internals. To
 * stay safe by default, the host REDACTS every bare `throw new Error(...)`
 * from an untrusted app in production to an opaque "Tool execution failed".
 *
 * A weak model that only sees "Tool execution failed" cannot correct the call,
 * so it blindly retries the same doomed request for dozens of full-context
 * steps (the token-runaway class). `ToolError` is the escape hatch: it marks a
 * message the handler author has DELIBERATELY vetted as safe, so the host
 * surfaces the real message + a machine-readable `code` instead of redacting.
 *
 * WHEN TO USE
 * -----------
 * Throw a `ToolError` ONLY for expected, caller-actionable failures whose
 * message you have verified contains no secrets, credentials, internal ids,
 * stack traces, or implementation detail. Typical uses: a required upstream
 * record is missing, a precondition the agent can fix is unmet, a validation
 * the agent can correct failed.
 *
 * WHEN NOT TO USE
 * ---------------
 * Do NOT use it for unexpected crashes, programming errors, or any message
 * that might embed internals. A bare `throw new Error(...)` stays REDACTED in
 * untrusted production on purpose. That no-leak default is the safe path;
 * `ToolError` is a narrow, per-message opt-out of it.
 *
 * SANDBOX BOUNDARY
 * ----------------
 * `name`, `safe`, `code`, and `retryable` are own-enumerable, so the QuickJS
 * `ctx.dump` of a thrown `ToolError` preserves them and the host can detect a
 * safe error by `name === "ToolError"` after the dump. `message` always
 * survives. See `apps/api/src/modules/apps/sandbox/sandbox-worker.ts` and
 * `worker-pool.ts` for the host-side reconstruction.
 */
export class ToolError extends Error {
  /** Marks the message as vetted-safe to surface even in untrusted production. */
  readonly safe = true
  /** Machine-readable failure code (e.g. "no_anchor_document"). */
  readonly code: string
  /** Whether the caller may retry the same call and expect a different result. */
  readonly retryable: boolean

  constructor(message: string, opts: { code: string; retryable?: boolean }) {
    super(message)
    this.name = "ToolError"
    this.code = opts.code
    this.retryable = opts.retryable ?? false
  }
}

/**
 * What `refuseTool` returns: the error envelope a handler (or a preflight)
 * RETURNS when it deliberately declines a call and tells the caller how to fix
 * it. `refusal: true` is what the host recognises.
 */
export interface ToolRefusal {
  status: "error"
  error: {
    code: string
    message: string
    retryable: boolean
    refusal: true
    body?: unknown
  }
}

/**
 * A deliberate refusal: a guard declined the call on purpose (nothing was
 * written) and its message tells the caller what to change. Return it from a
 * handler or a preflight:
 *
 *   if (!vatId) return refuseTool("buyer_vat_id_required", "… Nothing was created. Next step: …")
 *
 * The host treats it as a normal outcome, not a fault: the message reaches the
 * agent intact, the HTTP status is a 4xx (the code's own 4xx when the host maps
 * one, otherwise 422), and it is logged at warn, never at error, so it does not
 * page. An unexpected failure is still thrown (or returned without
 * `refusal`), and an unclassified one stays a 500 at error level.
 */
export function refuseTool(
  code: string,
  message: string,
  opts: { retryable?: boolean; body?: unknown } = {},
): ToolRefusal {
  return {
    status: "error",
    error: {
      code,
      message,
      retryable: opts.retryable ?? false,
      refusal: true,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    },
  }
}
