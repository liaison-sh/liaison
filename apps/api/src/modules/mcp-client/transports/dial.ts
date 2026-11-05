// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dial both HTTP-flavoured transports share: the URL re-check, the
// SSRF-safe credentialed fetch, the connect under a timeout and the auth error
// mapping. Each adapter only says which SDK transport to build.

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { validateOutboundUrl } from "~/lib/outbound-fetch"
import { ownOption } from "~/lib/safe-path"
import { makeSafeMcpFetch, mcpAllowsPrivateTargets, type SafeFetch } from "./safe-fetch"
import {
  type DialCredentials,
  type HttpDialOptions,
  isUnauthorizedError,
  type LiveConnection,
  McpAuthChallengeError,
  makeCredentialedFetch,
  UnauthorizedError,
  withDialTimeout,
} from "./types"

const DEFAULT_TIMEOUT_MS = 30_000
const CLIENT_IDENTITY = { name: "liaison-mcp-client", version: "0.1.0" } as const

/** The per-request credential supplier: the store's, or the fixed bearer token. */
export function credentialsOf(opts: HttpDialOptions): () => Promise<DialCredentials> {
  if (opts.credentials) return opts.credentials
  const fixed: DialCredentials = {
    authorization: opts.bearerToken ? `Bearer ${opts.bearerToken}` : null,
    headers: {},
  }
  return async () => fixed
}

/** Dial `opts.url` over the transport `makeTransport` builds around the safe fetch. */
export async function dialOver(
  opts: HttpDialOptions,
  makeTransport: (url: URL, fetch: SafeFetch) => Transport,
): Promise<LiveConnection> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // Loopback/private MCP targets are blocked by default (SSRF). The e2e server
  // (index.e2e.ts) opts in via LIAISON_E2E_ALLOW_PRIVATE_MCP so its in-process
  // mock MCP server (http://127.0.0.1:<port>) is reachable. The flag
  // is inert in production (NODE_ENV !== "test" disables the allowance anyway)
  // and unset under unit tests, so their SSRF assertions stay genuine.
  const allowPrivate = ownOption(opts, "allowPrivate") ?? mcpAllowsPrivateTargets()
  // Re-validate the (attacker-influenced, persisted) URL at dial time even
  // though create/patch already validated — the stored value could have been
  // written before this guard existed, and DNS may now resolve elsewhere.
  await validateOutboundUrl(opts.url, {
    requireHttps: true,
    allowPrivateHostsInTest: allowPrivate,
  })
  // Pin DNS + re-validate every redirect on all transport requests, and read
  // the credentials per request (a refreshed token reaches the next request).
  const transport = makeTransport(
    new URL(opts.url),
    makeCredentialedFetch(makeSafeMcpFetch({ allowPrivate }), credentialsOf(opts)),
  )
  const client = new Client(CLIENT_IDENTITY, { capabilities: {} })

  try {
    await withDialTimeout(client.connect(transport), timeoutMs, async () => {
      await transport.close().catch(() => {})
    })
  } catch (err) {
    await transport.close().catch(() => {})
    if (err instanceof McpAuthChallengeError) throw err
    if (isUnauthorizedError(err)) {
      throw new UnauthorizedError(`${opts.url}: ${(err as Error).message}`)
    }
    throw err
  }
  return {
    client,
    async close() {
      await client.close().catch(() => {})
    },
  }
}
