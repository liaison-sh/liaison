// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SSRF-safe fetch for inbound MCP transports. The MCP SDK's HTTP/SSE
// transports accept a custom `fetch` (FetchLike); we hand them a fetch that
// runs every request URL — including each redirect hop — through
// validateOutboundUrl + DNS-pinning so an attacker-influenced `httpUrl` (or a
// 3xx into internal infra) cannot dial loopback / link-local / RFC1918 hosts
// while carrying the connection's decrypted bearer/OAuth token.

import { fetchWithPinnedHost } from "~/lib/outbound-fetch"
import { ownOption } from "~/lib/safe-path"

/** FetchLike — matches the MCP SDK's transport `fetch` option signature. */
export type SafeFetch = (url: string | URL, init?: RequestInit) => Promise<Response>

/**
 * True when MCP connection targets may point at private/loopback hosts. This is
 * the e2e opt-in (`LIAISON_E2E_ALLOW_PRIVATE_MCP`, set by index.e2e.ts) so the
 * in-process mock MCP server (http://127.0.0.1:<port>) is reachable. It is inert
 * in production — `allowPrivateHostsInTest` only relaxes when NODE_ENV is
 * "test" — and unset under unit tests, keeping their SSRF assertions genuine.
 *
 * NOTE: the flag deliberately avoids the `LIAISON_MCP_` prefix, which the env
 * bootstrap parser (env-bootstrap.ts) reserves for connection definitions.
 */
export function mcpAllowsPrivateTargets(): boolean {
  return process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP === "1"
}

/**
 * Build a redirect-pinning fetch for an MCP transport. Requires HTTPS and
 * blocks private targets by default. `allowPrivate` (test only) opts into
 * dialing localhost fixtures.
 */
export function makeSafeMcpFetch(opts: { allowPrivate?: boolean } = {}): SafeFetch {
  const allowPrivate = ownOption(opts, "allowPrivate") ?? mcpAllowsPrivateTargets()
  return (url, init = {}) =>
    fetchWithPinnedHost(url, init, {
      requireHttps: true,
      allowPrivateHostsInTest: allowPrivate,
    })
}
