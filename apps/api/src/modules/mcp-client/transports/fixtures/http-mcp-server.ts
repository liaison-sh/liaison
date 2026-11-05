// SPDX-License-Identifier: FSL-1.1-ALv2
//
// In-process Streamable HTTP MCP server fixture for transport tests.
//
// Spins up a real `McpServer` behind `WebStandardStreamableHTTPServerTransport`
// on a localhost port; tests dial it via `dialHttp({ url })` and assert
// initialize + tools/list completes. Optional knobs simulate adversarial
// servers (always-401, capture-auth-header) so the http transport adapter's
// `UnauthorizedError` mapping is exercised end-to-end.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"

export interface HttpFixtureOptions {
  /** When true, every request returns HTTP 401 — exercises UnauthorizedError. */
  alwaysReturn401?: boolean
  /** Captures the value of the `Authorization` header on every request. */
  onAuthHeader?: (header: string | null) => void
  /** Captures every request's headers. */
  onRequestHeaders?: (headers: Headers) => void
  /** `WWW-Authenticate` sent with the 401s of `alwaysReturn401`. */
  challenge?: string
  /**
   * More tools beside `echo`, each with no arguments and the given `tools/list`
   * annotations (e.g. `readOnlyHint`), answering with its own name.
   */
  extraTools?: Array<{
    name: string
    description: string
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
  }>
}

export interface HttpFixtureHandle {
  url: string
  close: () => Promise<void>
}

export async function startFixtureHttpMcpServer(
  opts: HttpFixtureOptions = {},
): Promise<HttpFixtureHandle> {
  const server = new McpServer({ name: "echo-http-fixture", version: "0.0.1" })
  server.tool("echo", "Echo the input message", { message: z.string() }, async ({ message }) => ({
    content: [{ type: "text", text: message }],
  }))
  for (const t of opts.extraTools ?? []) {
    server.registerTool(
      t.name,
      { description: t.description, annotations: t.annotations ?? {} },
      async () => ({ content: [{ type: "text", text: t.name }] }),
    )
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  })
  await server.connect(transport)

  const bun = Bun.serve({
    port: 0, // ephemeral
    hostname: "127.0.0.1",
    async fetch(req) {
      opts.onAuthHeader?.(req.headers.get("authorization"))
      opts.onRequestHeaders?.(req.headers)
      if (opts.alwaysReturn401) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            ...(opts.challenge ? { "www-authenticate": opts.challenge } : {}),
          },
        })
      }
      return transport.handleRequest(req)
    },
  })

  return {
    url: `http://127.0.0.1:${bun.port}/`,
    async close() {
      await transport.close().catch(() => {})
      bun.stop(true)
    },
  }
}
