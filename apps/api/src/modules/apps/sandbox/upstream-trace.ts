// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What a sandboxed handler run last asked of the outside world: the connection
 * whose credentials it read and the answer of its last `ctx.fetch` (host and
 * HTTP status only: never a path, a query or a body, which can carry ids or
 * secrets). The host fills it from the bridge while the handler runs.
 *
 * Why: an untrusted handler's crash is redacted to "Tool execution failed" in
 * production. When the crash follows an upstream error answer (a connection
 * whose base URL went stale gets a 404 HTML page, and the handler's JSON parse
 * throws), the admin reading the tool error or the log had nothing pointing at
 * the connection. The redacted error now names the connection and the host it
 * called, which is configuration the admin wrote, not handler internals.
 */

import { scrubText } from "~/lib/scrub"

export interface UpstreamTrace {
  /** The last connection whose credentials or token the handler read. */
  connection?: { name: string; identifier?: string }
  /** The last `ctx.fetch` answer. */
  last?: { host: string; status: number }
}

/** An upstream error answer that preceded a handler failure. */
export interface UpstreamFailure {
  host: string
  status: number
  connection?: { name: string; identifier?: string }
}

const traces = new WeakMap<object, UpstreamTrace>()

/** Remember, on a handler's thrown error, the run's trace (kept by identity, never on the error). */
export function attachUpstreamTrace(err: unknown, trace: UpstreamTrace): void {
  if (typeof err === "object" && err !== null) traces.set(err, trace)
}

/** The upstream error answer recorded for this error, when its run's last call failed. */
export function upstreamFailureOf(err: unknown): UpstreamFailure | null {
  if (typeof err !== "object" || err === null) return null
  const trace = traces.get(err)
  const last = trace?.last
  if (!last || last.status < 400) return null
  return {
    host: last.host,
    status: last.status,
    ...(trace?.connection ? { connection: trace.connection } : {}),
  }
}

/** The caller-facing sentence for a redacted failure that followed an upstream error answer. */
export function describeUpstreamFailure(appName: string, f: UpstreamFailure): string {
  const conn = f.connection
    ? `connection '${appName}/${f.connection.name}'${f.connection.identifier ? ` (${f.connection.identifier})` : ""}`
    : `app '${appName}'`
  return (
    `Tool execution failed after the ${conn} called ${f.host}, which answered HTTP ${f.status}. ` +
    "If that host or its base URL is no longer right, an admin should update the connection's settings."
  )
}

/**
 * Runtime crash classes: a handler that died on one of these after an upstream
 * error answer (a JSON parse of an HTML 404 page, a property read on an error
 * body) said nothing of its own, so the caller gets the bridge's sentence. The
 * host-side sandbox failures (`Sandbox*`) count as crashes too.
 */
const CRASH_ERROR_NAMES = new Set([
  "TypeError",
  "SyntaxError",
  "ReferenceError",
  "RangeError",
  "InternalError",
  "EvalError",
  "URIError",
  "AggregateError",
])

/** Longest app message the caller gets: enough for Google's error plus a fix hint. */
export const APP_UPSTREAM_MESSAGE_MAX = 800

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>]+/gi
const SECRET_PARAM =
  /\b(access_token|refresh_token|id_token|token|api[_-]?key|key|secret|client_secret|password|passwd|signature|sig|code)=([^&\s"'<>]+)/gi

/** An app message made safe to hand to the caller: no credentials, no query strings, bounded. */
export function sanitizeAppUpstreamMessage(message: string): string {
  let out = scrubText(message)
  // A URL keeps its scheme, host and path; its userinfo and query go.
  out = out.replace(URL_IN_TEXT, (url) => {
    try {
      const u = new URL(url)
      return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`
    } catch {
      return "[url]"
    }
  })
  out = out.replace(SECRET_PARAM, (_m, k: string) => `${k}=[redacted]`)
  out = out.replace(/\s+/g, " ").trim()
  if (out.length > APP_UPSTREAM_MESSAGE_MAX) {
    out = `${out.slice(0, APP_UPSTREAM_MESSAGE_MAX - 1).trimEnd()}…`
  }
  return out
}

/**
 * The caller-facing message of a sandboxed handler that failed after an
 * upstream error answer. When the handler threw its OWN error (a connector
 * client's `GoogleAdsApiError` naming Google's reason and the fix, a plain
 * `Error` with a sentence), that message is what the agent needs: it gets it,
 * sanitized and bounded. Only a runtime crash, or an empty message, falls back
 * to the bridge's generic sentence naming the connection and the host.
 */
export function upstreamFailureMessage(
  appName: string,
  f: UpstreamFailure,
  err: unknown,
  message: string,
): string {
  const name = typeof (err as { name?: unknown })?.name === "string" ? (err as Error).name : ""
  const crashed = CRASH_ERROR_NAMES.has(name) || name.startsWith("Sandbox")
  const own = crashed ? "" : sanitizeAppUpstreamMessage(message)
  return own ? own : describeUpstreamFailure(appName, f)
}
