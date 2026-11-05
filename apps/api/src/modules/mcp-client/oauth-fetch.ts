// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one fetch every MCP OAuth request goes through: the unauthenticated
// probe, Protected Resource Metadata, authorization server metadata, client
// registration, the code exchange and every refresh.
//
// Every URL here is attacker-influenced (an MCP server's challenge names its
// metadata, the metadata names the endpoints), so each request is HTTPS-only,
// refuses private targets, pins DNS and re-validates every redirect
// (`fetchWithRedirectValidation`). The loopback allowance that lets tests reach
// an in-process authorization server lives HERE and nowhere else: it only takes
// effect when NODE_ENV is "test" (outbound-fetch.ts), so production code can
// carry it safely.

import { env } from "~/lib/env"
import { fetchWithRedirectValidation, UnsafeOutboundUrlError } from "~/lib/outbound-fetch"

/** An OAuth URL the SSRF guard refused (scheme, private target, bad redirect). */
export class UnsafeOAuthUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeOAuthUrlError"
  }
}

const DEFAULT_TIMEOUT_MS = 15_000

/** FetchLike, as the MCP SDK's `client/auth` building blocks take it. */
export async function oauthFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetchWithRedirectValidation(
      url,
      { ...init, signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS) },
      { requireHttps: true, allowPrivateHostsInTest: true },
    )
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) throw new UnsafeOAuthUrlError(err.message)
    throw err
  }
}

/**
 * An endpoint handed to the browser (authorize) or used for tokens must be
 * https, never `javascript:`/`data:` or plain http. Tests may use the
 * in-process http issuer, mirroring oauthFetch's test allowance.
 */
export function isAllowedOAuthEndpoint(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return parsed.protocol === "https:" || (env.NODE_ENV === "test" && parsed.protocol === "http:")
}
