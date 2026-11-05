// SPDX-License-Identifier: FSL-1.1-ALv2
// Cross-package SDK shim for the Phase 12 MCP E2E scenarios.
//
// `@modelcontextprotocol/sdk` resolves only inside `apps/api`'s node_modules
// (it is a server-only dependency — never added to `apps/web`). The web-side
// E2E helpers therefore lazy-import THIS module via the proven cross-package
// pattern the repo already uses for `mock-drive`
// (`apps/web/src/tests/e2e/fixtures/test.ts`), keeping the bare SDK specifier
// off every `apps/web` file.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export { Client, StreamableHTTPClientTransport }

/**
 * Build a connected MCP SDK client over the live Streamable-HTTP transport.
 *
 * The access token is carried as a static `Authorization: Bearer` header via
 * `requestInit` (we already hold it from the OAuth dance — no `authProvider`,
 * which keeps the handshake deterministic). `client.connect()` runs the real
 * `initialize` handshake end-to-end and only resolves once it completes.
 */
export async function connectMcpClient(
  serverUrl: string,
  accessToken: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${serverUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
  const client = new Client({ name: "e2e", version: "1" })
  await client.connect(transport)
  return { client, transport }
}
