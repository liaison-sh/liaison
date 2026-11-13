// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Meta credentials connection resolver. Reads the NON-SECRET settings of the
// `meta` connection (`adAccountId`, `defaultPageId`; both `ctx.connections`
// shapes) and checks that an access token is stored without reading it: the host
// adds the token to every Graph call (`ctx.fetch` auth, META_AUTH), so it never
// enters the app.
//
// IMPORTANT: all ads handlers are authored natively as (params, ctx) —
// do NOT mirror boxtal/invoicing's internal (ctx, input) arg order.

import { ToolError } from "@liaison/app-sdk"
import { readConnectionSettings } from "@liaison/app-sdk/connection-credentials"
import {
  AuthError,
  META_AUTH,
  MetaApiError,
  type MetaAuth,
  ParamError,
  PermissionError,
  RateLimitError,
} from "./meta-client"

const CONNECTION = "meta"
const REQUIRED_KEYS = ["accessToken", "adAccountId"] as const

export interface MetaCredentials {
  auth: MetaAuth
  adAccountId: string // always in act_<id> form
  defaultPageId?: string
}

interface MetaCtx {
  connections: unknown
}

/**
 * Meta is not connected, or its stored credentials are unusable. It is an
 * app-sdk ToolError so its code and message survive the sandbox boundary: the
 * ads app runs untrusted, and only a ToolError (detected by `name === "ToolError"`,
 * so the name must not be overridden here) escapes the kernel's no-leak
 * redaction. A plain Error reaches the caller as an opaque "Tool execution
 * failed", which the dashboard cannot tell apart from a Meta outage and which
 * gives an agent no reason. Messages are therefore surfaced verbatim: keep them
 * free of credential values and of inner exception text.
 */
export class MetaConnectionError extends ToolError {
  readonly status = 424
  constructor(message: string) {
    super(message, { code: "meta_not_connected" })
  }
}

/** Normalize act_<id> — accept bare numeric id and prefix act_ */
function normalizeAdAccountId(raw: string): string {
  const s = raw.trim()
  if (s.startsWith("act_")) return s
  // Bare numeric or non-prefixed
  return `act_${s}`
}

/** Resolve the Meta credentials from ctx.connections. */
export async function getMetaClient(ctx: MetaCtx): Promise<MetaCredentials> {
  const read = await readConnectionSettings(ctx.connections, CONNECTION, REQUIRED_KEYS)
  if (!read.ok) {
    switch (read.reason) {
      case "not_connected":
        throw new MetaConnectionError(
          "Meta not connected: configure the Meta connection in app settings",
        )
      case "unreadable":
        // The inner exception text is not vetted for callers: keep it out.
        throw new MetaConnectionError(
          "Meta credentials could not be read: reconnect Meta in app settings",
        )
      case "empty":
        throw new MetaConnectionError("Meta not connected: credentials are empty")
      case "incomplete":
        throw new MetaConnectionError(
          `Meta credentials incomplete, missing: ${read.missing.join(", ")}`,
        )
    }
  }
  const map = read.values

  return {
    auth: META_AUTH,
    adAccountId: normalizeAdAccountId(map.adAccountId!),
    defaultPageId: map.defaultPageId,
  }
}

/**
 * Tool-dispatch-level normalization: not connected is an EXPECTED state, not a
 * crash. A handler that throws leaves the tool route answering HTTP 500, which
 * the dashboard and an agent can only read as an outage. Wrapping each exported
 * meta tool handler ONCE at the barrel (handlers.ts) turns that throw into the
 * same `{ error: { code, message } }` envelope the google and merchant reads
 * already return, and the same contract the shopify app ships. Any other throw
 * (a real bug, a Meta API failure) still propagates.
 */
export function withMetaConnectionEnvelope<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R | { error: { code: string; message: string } }> {
  return async (...args: Args) => {
    try {
      return await fn(...args)
    } catch (err) {
      if (err instanceof MetaConnectionError) {
        return { error: { code: "meta_not_connected", message: err.message } }
      }
      const upstream = metaUpstreamToolError(err)
      if (upstream) throw upstream
      throw err
    }
  }
}

/**
 * Meta answered with a client-class rejection (HTTP 4xx): a throttle, a missing
 * permission, a bad parameter, an expired token. These are expected upstream
 * answers the caller can act on, not faults in this app, so they cross the
 * sandbox as a ToolError: the caller gets Meta's own message and a stable code,
 * and the kernel logs them at warn instead of paging. Meta's message text and
 * fbtrace id carry no credential. A 5xx or unclassified throw is returned as
 * null and propagates unchanged.
 */
export class MetaUpstreamError extends ToolError {
  readonly status: number
  constructor(message: string, code: string, retryable: boolean, status: number) {
    super(message, { code, retryable })
    this.status = status
  }
}

/** The line the agent reads after the user facing sentence. UIs cut here. */
export const META_NEXT_STEP_MARKER = " Next step:"

/** Meta's own reason, without the trace id and the trailing period. */
function metaReason(err: MetaApiError): string {
  return err.message
    .replace(/\s*\[fbtrace_id:[^\]]*\]\s*$/, "")
    .trim()
    .replace(/[.\s]+$/, "")
}

function traceSuffix(err: MetaApiError): string {
  return err.fbtrace_id ? ` Meta trace id: ${err.fbtrace_id}.` : ""
}

/**
 * Map a Meta 4xx to the ToolError both readers get. The message is one plain
 * sentence a person can act on (with Meta's own reason where it matters),
 * then `Next step:` for the agent. Throttling answers 429 so every caller
 * reads it as "try later"; a refused call answers 403 or 400.
 */
export function metaUpstreamToolError(err: unknown): MetaUpstreamError | null {
  if (!(err instanceof MetaApiError)) return null
  const status = err.httpStatus
  if (typeof status !== "number" || status < 400 || status >= 500) return null
  const reason = metaReason(err)
  const trace = traceSuffix(err)
  if (err instanceof RateLimitError) {
    return new MetaUpstreamError(
      `Meta is limiting requests right now. Try again in a few minutes.${META_NEXT_STEP_MARKER} ` +
        `wait a few minutes, then retry the same call. Meta said: ${reason}.${trace}`,
      "meta_rate_limited",
      true,
      429,
    )
  }
  if (err instanceof PermissionError) {
    return new MetaUpstreamError(
      `Meta did not allow this request: ${reason}. The Meta app may be missing a permission.` +
        `${META_NEXT_STEP_MARKER} do not retry; use a named ads tool instead, or ask an admin to grant ` +
        `the permission to the Meta app.${trace}`,
      "meta_permission_denied",
      false,
      403,
    )
  }
  if (err instanceof AuthError) {
    return new MetaUpstreamError(
      `Meta no longer accepts the saved access token: ${reason}. Reconnect Meta in the Ads settings.` +
        `${META_NEXT_STEP_MARKER} do not retry until Meta is reconnected.${trace}`,
      "meta_auth_invalid",
      false,
      424,
    )
  }
  if (err instanceof ParamError) {
    return new MetaUpstreamError(
      `Meta rejected this request: ${reason}.${META_NEXT_STEP_MARKER} do not retry as is; change the ` +
        `path, fields or parameters.${trace}`,
      "meta_invalid_request",
      false,
      400,
    )
  }
  return new MetaUpstreamError(
    `Meta rejected this request: ${reason}.${META_NEXT_STEP_MARKER} do not retry as is.${trace}`,
    "meta_rejected",
    false,
    status,
  )
}
