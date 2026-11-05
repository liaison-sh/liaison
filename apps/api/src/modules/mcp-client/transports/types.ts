// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared transport contract for inbound MCP connections.
//
// Each transport adapter (`http`, `sse`) returns a `LiveConnection`.
// The connection wraps the MCP SDK `Client` so call-site code interacts with a
// single, consistent shape regardless of transport.

import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { tokenFingerprint } from "../credentials"
import type { SafeFetch } from "./safe-fetch"

export interface LiveConnection {
  client: Client
  /** Close the underlying transport / socket. Idempotent. */
  close(): Promise<void>
}

/** What a transport sends on each request: Authorization and custom headers. */
export interface DialCredentials {
  authorization: string | null
  headers: Record<string, string>
}

/**
 * HTTP/SSE dial inputs. `credentials` is read on EVERY request (a refreshed
 * token reaches the next request of a pooled transport); `bearerToken` is the
 * fixed alternative for callers without a credential store.
 */
export interface HttpDialOptions {
  url: string
  bearerToken: string | null
  credentials?: () => Promise<DialCredentials>
  /** Optional handshake timeout; defaults to 30s. */
  timeoutMs?: number
  /**
   * Test-only escape hatch: allow dialing private/loopback hosts (e.g. an
   * in-process fixture on 127.0.0.1). Off in production — the dial path
   * validates the URL through the SSRF guard and re-validates every redirect.
   */
  allowPrivate?: boolean
}

/** Thrown when the server replies HTTP 401 — callers trigger OAuth refresh. */
export class UnauthorizedError extends Error {
  readonly httpStatus: number
  constructor(message = "MCP server returned 401 Unauthorized", httpStatus = 401) {
    super(message)
    this.name = "UnauthorizedError"
    this.httpStatus = httpStatus
  }
}

/** What a 401 / 403 `WWW-Authenticate: Bearer …` challenge says. */
export interface WwwAuthChallenge {
  resourceMetadataUrl?: string
  scope?: string
  error?: string
}

/**
 * The server refused the request's credentials: a 401, or a 403
 * `insufficient_scope`. It carries the parsed challenge (RFC 9728 / RFC 6750)
 * and the fingerprint of the token that was refused, so the refresh can tell
 * whether another process already replaced it.
 */
export class McpAuthChallengeError extends UnauthorizedError {
  constructor(
    httpStatus: 401 | 403,
    readonly challenge: WwwAuthChallenge,
    readonly tokenFingerprint: string | null,
  ) {
    super(
      httpStatus === 401
        ? "MCP server returned 401 Unauthorized"
        : `MCP server returned 403 ${challenge.error ?? "Forbidden"}`,
      httpStatus,
    )
    this.name = "McpAuthChallengeError"
  }
}

export function parseChallenge(res: Response): WwwAuthChallenge {
  const p = extractWWWAuthenticateParams(res)
  return {
    ...(p.resourceMetadataUrl ? { resourceMetadataUrl: p.resourceMetadataUrl.href } : {}),
    ...(p.scope ? { scope: p.scope } : {}),
    ...(p.error ? { error: p.error } : {}),
  }
}

/**
 * Wrap a transport's fetch so every request carries the CURRENT credentials,
 * and a refusal surfaces as `McpAuthChallengeError` with its challenge (the
 * SDK's own errors drop the `WWW-Authenticate` header).
 */
export function makeCredentialedFetch(
  base: SafeFetch,
  credentials: () => Promise<DialCredentials>,
): SafeFetch {
  return async (url, init = {}) => {
    const creds = await credentials()
    const headers = new Headers(init.headers)
    for (const [name, value] of Object.entries(creds.headers)) headers.set(name, value)
    if (creds.authorization) headers.set("authorization", creds.authorization)
    const res = await base(url, { ...init, headers })
    if (res.status === 401 || res.status === 403) {
      const challenge = parseChallenge(res)
      if (res.status === 401 || challenge.error === "insufficient_scope") {
        await res.body?.cancel().catch(() => {})
        const sent = creds.authorization?.replace(/^Bearer\s+/i, "") ?? null
        throw new McpAuthChallengeError(res.status, challenge, sent ? tokenFingerprint(sent) : null)
      }
    }
    return res
  }
}

/** Thrown when the handshake / dial exceeds the timeout budget. */
export class DialTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`MCP transport handshake exceeded ${timeoutMs}ms`)
    this.name = "DialTimeoutError"
  }
}

/** SDK 401 detector shared by HTTP and SSE transports — the SDK throws
 *  variants with `code === 401`, `httpStatus === 401`, or a "401 Unauthorized"
 *  message depending on which low-level path produced the error. */
export function isUnauthorizedError(err: unknown): boolean {
  if (!err) return false
  const e = err as { code?: number; message?: string; httpStatus?: number }
  if (e.code === 401 || e.httpStatus === 401) return true
  const msg = String(e.message ?? "")
  return /\b401\b|unauthor/i.test(msg)
}

/** Race a dial Promise against a timer; on timer-fire, invoke `onTimeout`
 *  (typically `transport.close()`) and reject with `DialTimeoutError`. Shared
 *  by the transport adapters (HTTP, SSE). */
export async function withDialTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout()
            .catch(() => {})
            .finally(() => reject(new DialTimeoutError(ms)))
        }, ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
