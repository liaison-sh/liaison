// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Request timeout middleware with real cancellation.
 *
 * Replaces `hono/timeout` on /api/*. `hono/timeout` races the handler against a
 * timer and throws a 504 — but it never tells the work it abandoned to stop, and
 * the incoming `Request.signal` only aborts when the CLIENT socket goes away, not
 * when we ourselves give up. So a sandboxed tool call that blew the budget kept
 * its worker for the rest of its own kill timer (`timeoutMs + 2000`, i.e. ~62s in
 * prod) after the operator already saw "Request failed" at 30s. Operator
 * re-clicks then compounded into a rolling outage: every retry queued behind
 * workers still held for a response nobody was waiting for.
 *
 * This version owns an AbortController per request, aborts it when the budget
 * expires (and when the client disconnects), and publishes the signal on the
 * context as `requestSignal`. Routes hand that to `executeTool`, so the sandbox
 * worker pool learns the caller is gone and releases its worker immediately.
 */
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"

/** Reason attached to the AbortSignal when WE gave up (vs the client leaving). */
export const REQUEST_TIMEOUT_ABORT_REASON = "request_timeout"

/**
 * Read the cancellation signal for this request: the timeout-owned controller
 * when the timeout middleware ran, else the raw client-disconnect signal.
 * Every route that dispatches cancellable work should use this rather than
 * `c.req.raw.signal` directly.
 */
export function getRequestSignal(c: {
  get: (k: "requestSignal") => AbortSignal | undefined
  req: { raw: Request }
}): AbortSignal {
  return c.get("requestSignal") ?? c.req.raw.signal
}

export function requestTimeout(timeoutMs: number) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const controller = new AbortController()
    c.set("requestSignal", controller.signal)

    // A client that hangs up is also a caller that is gone: chain it so
    // downstream work is cancelled in that case too.
    const clientSignal = c.req.raw.signal
    const onClientAbort = () => controller.abort(clientSignal.reason)
    if (clientSignal.aborted) controller.abort(clientSignal.reason)
    else clientSignal.addEventListener("abort", onClientAbort, { once: true })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // Abort FIRST, then reject: downstream holders (the sandbox worker pool)
      // must see the cancellation, not just the client.
      controller.abort(REQUEST_TIMEOUT_ABORT_REASON)
    }, timeoutMs)

    try {
      await Promise.race([
        next(),
        new Promise<never>((_, reject) => {
          const settle = () => {
            if (timedOut)
              reject(
                new HTTPException(504, {
                  message: `Gateway Timeout: request exceeded ${timeoutMs}ms`,
                }),
              )
          }
          // Resolve the race the moment the controller aborts for OUR reason.
          controller.signal.addEventListener("abort", settle, { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
      clientSignal.removeEventListener("abort", onClientAbort)
    }
  })
}
