// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Mock MCP HTTP server for E2E tests.
//
// Wraps the SDK's `McpServer` + `WebStandardStreamableHTTPServerTransport` —
// same pattern as the unit-test fixture in
// `apps/api/src/modules/mcp-client/transports/fixtures/http-mcp-server.ts`,
// but with a stable `port` argument (so the per-worker test fixture can
// allocate a deterministic port via `deterministicPorts`) and a Hono-shaped
// handle (`url`, `port`, `kill`) to match `mock-drive.ts`.
//
// Exposes a single tool: `echo({ message }) → { text: message }`.
// Used by every `mcp-manager-*` E2E spec — the wizard, disable, OAuth, and
// env-bootstrap flows all dial this server and assert tool discovery /
// invocation round-trips end-to-end.
//
// Bound to `127.0.0.1` (per project memory `feedback_vite_ipv4_host`) — Bun
// binds IPv6-only by default on macOS, which makes fetches to `127.0.0.1`
// fail instantly without this hostname override.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"

export interface MockMcpHandle {
  url: string
  port: number
  /** Call counter for assertions across spec steps. */
  callCount: () => number
  /**
   * Configure RFC 8414 discovery to point at an external OAuth issuer (e.g.
   * the `mock-mcp-oauth.ts` fixture). Used by the MCP OAuth E2E spec — the
   * kernel calls `<mcpUrl>/.well-known/oauth-authorization-server` during the
   * `oauth_dcr` flow; setting this redirect makes that lookup succeed against
   * the fixture issuer.
   */
  setOauthDiscovery: (config: {
    issuer: string
    authorizationEndpoint: string
    tokenEndpoint: string
    registrationEndpoint?: string
    /**
     * Answer an MCP request without `Authorization` with 401 and an RFC 9728
     * `WWW-Authenticate` challenge, as an authenticated server does: what the
     * add flow's probe reads to offer a sign-in. Off by default.
     */
    requireBearer?: boolean
  }) => void
  /** Back to an open server: no discovery, no challenge. */
  clearOauthDiscovery: () => void
  /**
   * Force every JSON-RPC request to fail with HTTP 503, simulating an upstream
   * MCP outage. Used by the `mcp_aggregator_flap` chaos scenario to exercise
   * the kernel's lazy-pool teardown + exponential-backoff reconnect path.
   * Toggleable at runtime via `POST /__control/failure` with `{ on: boolean }`
   * — the chaos persona uses the POST endpoint, in-process tests can call the
   * helper directly.
   */
  setForceFailure: (on: boolean) => void
  kill: () => Promise<void>
}

interface OauthDiscoveryConfig {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  requireBearer?: boolean
}

// Build a fresh McpServer + transport pair per MCP session. The SDK's
// `WebStandardStreamableHTTPServerTransport` is single-session by design —
// once initialized, subsequent `initialize` requests against the same
// transport return "Server already initialized" (-32600). For an E2E
// fixture we need to support many sequential client connections (each test
// dials fresh), so we route on `mcp-session-id`:
//   - request with a known session id → forward to the matching transport
//   - request without a session id (an `initialize`) → mint a new transport
//     + McpServer pair, generate a session id, add to the map, handle the
//     request against that fresh pair.
function buildSessionInstance(callCounter: { value: number }): {
  server: McpServer
  transport: WebStandardStreamableHTTPServerTransport
} {
  const server = new McpServer({ name: "liaison-e2e-fixture", version: "0.0.1" })
  server.tool(
    "echo",
    "Echo the input message back to the caller — used by Liaison E2E specs",
    { message: z.string() },
    async ({ message }) => {
      callCounter.value += 1
      return { content: [{ type: "text", text: message }] }
    },
  )
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  })
  return { server, transport }
}

export async function startMockMcp(port = 0): Promise<MockMcpHandle> {
  const callCounter = { value: 0 }
  // sessionId → live transport pair. Per-session state lives in the
  // transport; the McpServer instance binds tool handlers once and is
  // captured in the closure for `echo`.
  const sessions = new Map<
    string,
    { server: McpServer; transport: WebStandardStreamableHTTPServerTransport }
  >()

  let oauthDiscovery: OauthDiscoveryConfig | null = null
  let forceFailure = false

  const bun = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      // Chaos control plane — flip the in-process failure switch so the next
      // JSON-RPC request returns 503. Body: `{ on: boolean }`.
      if (url.pathname === "/__control/failure" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { on?: unknown }
        forceFailure = body.on === true
        return new Response(JSON.stringify({ forceFailure }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      // RFC 9728 Protected Resource Metadata, path-aware or root: it names the
      // fixture issuer as this server's authorization server, so the client
      // discovers it the spec way and the issuer it fetches matches.
      const PRM_PREFIX = "/.well-known/oauth-protected-resource"
      if (oauthDiscovery && url.pathname.startsWith(PRM_PREFIX)) {
        const suffix = url.pathname.slice(PRM_PREFIX.length)
        return new Response(
          JSON.stringify({
            resource: `${url.origin}${suffix}`,
            authorization_servers: [oauthDiscovery.issuer],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      // RFC 8414 discovery proxy — the kernel's `discoverIssuer` walks
      // `<mcpUrl>/.well-known/oauth-authorization-server`. When configured,
      // surface the fixture issuer's endpoints here so oauth_dcr completes.
      if (oauthDiscovery && url.pathname === "/.well-known/oauth-authorization-server") {
        return new Response(
          JSON.stringify({
            issuer: oauthDiscovery.issuer,
            authorization_endpoint: oauthDiscovery.authorizationEndpoint,
            token_endpoint: oauthDiscovery.tokenEndpoint,
            registration_endpoint: oauthDiscovery.registrationEndpoint,
            grant_types_supported: ["authorization_code"],
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (forceFailure) {
        return new Response("upstream MCP simulated outage", { status: 503 })
      }
      if (oauthDiscovery?.requireBearer && !req.headers.get("authorization")) {
        const prm = `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`
        return new Response("unauthorized", {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="${prm}"` },
        })
      }
      // Session routing: request with an existing session header → forward
      // to the matching transport. Request without one (initialize) → mint
      // a fresh transport+McpServer pair so each new client connection gets
      // its own session, bypassing the SDK's single-session-per-transport
      // limitation.
      const sessionId = req.headers.get("mcp-session-id")
      let instance:
        | { server: McpServer; transport: WebStandardStreamableHTTPServerTransport }
        | undefined
      if (sessionId) {
        instance = sessions.get(sessionId)
      }
      if (!instance) {
        instance = buildSessionInstance(callCounter)
        await instance.server.connect(instance.transport)
        // After the transport handles the initialize, capture the generated
        // session id and add to the map for subsequent requests on this
        // session. Pre-bind onclose so a client.close() evicts the session.
        instance.transport.onclose = () => {
          if (instance!.transport.sessionId) sessions.delete(instance!.transport.sessionId)
        }
      }
      const response = await instance.transport.handleRequest(req)
      // Persist the session AFTER the initialize handler runs (sessionId is
      // populated by the SDK at that point).
      if (instance.transport.sessionId && !sessions.has(instance.transport.sessionId)) {
        sessions.set(instance.transport.sessionId, instance)
      }
      return response
    },
  })

  const boundPort = Number(bun.port)

  return {
    url: `http://127.0.0.1:${boundPort}/`,
    port: boundPort,
    callCount: () => callCounter.value,
    setOauthDiscovery: (config) => {
      oauthDiscovery = config
    },
    clearOauthDiscovery: () => {
      oauthDiscovery = null
    },
    setForceFailure: (on) => {
      forceFailure = on
    },
    kill: async () => {
      // Close every live session's transport, then stop the listener.
      await Promise.allSettled(Array.from(sessions.values()).map((s) => s.transport.close()))
      sessions.clear()
      bun.stop(true)
    },
  }
}
