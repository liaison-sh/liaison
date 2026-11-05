// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Mock OAuth 2.1 + DCR (Dynamic Client Registration) server for MCP E2E tests.
//
// Implements the minimum set of endpoints needed by the kernel MCP OAuth flow:
//   - GET  /.well-known/oauth-authorization-server   — RFC 8414 discovery
//   - POST /register                                  — RFC 7591 DCR
//   - GET  /authorize                                 — auto-approves, redirects to callback with code
//   - POST /token                                     — exchanges code for access token
//
// Bound to `127.0.0.1` per memory `feedback_vite_ipv4_host`. Lifecycle mirrors
// `mock-drive.ts` / `mock-mcp.ts`: one server per worker, killed in teardown.
//
// Used by `mcp-manager-oauth.spec.ts` (Task 38).

import { Hono } from "hono"

export interface MockMcpOauthHandle {
  url: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
  port: number
  /** Test hook: most recent code-exchange grant payload (for assertions). */
  lastTokenRequest: () => Record<string, string> | null
  /**
   * Whether discovery advertises the registration endpoint (default on). Off,
   * a client must come with its own pre-registered client id (static clients
   * are accepted as they are).
   */
  setRegistration: (on: boolean) => void
  kill: () => Promise<void>
}

export async function startMockMcpOauth(port = 0): Promise<MockMcpOauthHandle> {
  // In-memory state — single-issuer fixture; no persistence.
  const clients = new Map<string, { clientId: string; clientSecret?: string }>()
  const codes = new Map<string, { clientId: string; redirectUri: string; codeChallenge?: string }>()
  let lastTokenRequest: Record<string, string> | null = null
  let registration = true

  const app = new Hono()

  // — Discovery — RFC 8414 + DCR + PKCE bits
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const base = new URL(c.req.url).origin
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      ...(registration ? { registration_endpoint: `${base}/register` } : {}),
      grant_types_supported: ["authorization_code"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
    })
  })

  // — RFC 7591 — Dynamic Client Registration
  app.post("/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const clientId = `client-${crypto.randomUUID()}`
    const clientSecret = `secret-${crypto.randomUUID()}`
    clients.set(clientId, { clientId, clientSecret })
    return c.json(
      {
        client_id: clientId,
        client_secret: clientSecret,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: (body.redirect_uris as string[] | undefined) ?? [],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
      },
      201,
    )
  })

  // — Authorization endpoint — auto-approve, redirect back to callback with code
  app.get("/authorize", (c) => {
    const clientId = c.req.query("client_id") ?? ""
    const redirectUri = c.req.query("redirect_uri") ?? ""
    const state = c.req.query("state") ?? ""
    const codeChallenge = c.req.query("code_challenge")
    if (!clients.has(clientId)) {
      // Static-client mode (no DCR pre-registration) — accept anyway.
      clients.set(clientId, { clientId })
    }
    if (!redirectUri) return c.json({ error: "missing redirect_uri" }, 400)
    const code = `code-${crypto.randomUUID()}`
    codes.set(code, { clientId, redirectUri, codeChallenge })
    const target = new URL(redirectUri)
    target.searchParams.set("code", code)
    if (state) target.searchParams.set("state", state)
    return c.redirect(target.toString(), 302)
  })

  // — Token endpoint — exchanges authorization_code for access_token
  app.post("/token", async (c) => {
    const ct = c.req.header("content-type") ?? ""
    let params: Record<string, string> = {}
    if (ct.includes("application/x-www-form-urlencoded")) {
      const text = await c.req.text()
      for (const [k, v] of new URLSearchParams(text).entries()) params[k] = v
    } else {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, string>
      params = body
    }
    lastTokenRequest = { ...params }
    const grant = params.grant_type
    if (grant !== "authorization_code") {
      return c.json({ error: "unsupported_grant_type" }, 400)
    }
    const code = params.code
    if (!code || !codes.has(code)) {
      return c.json({ error: "invalid_grant" }, 400)
    }
    codes.delete(code)
    return c.json({
      access_token: `at-${crypto.randomUUID()}`,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: `rt-${crypto.randomUUID()}`,
    })
  })

  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch })
  const boundPort = Number(server.port)
  const base = `http://127.0.0.1:${boundPort}`

  return {
    url: base,
    issuer: base,
    authorizationEndpoint: `${base}/authorize`,
    tokenEndpoint: `${base}/token`,
    registrationEndpoint: `${base}/register`,
    port: boundPort,
    lastTokenRequest: () => lastTokenRequest,
    setRegistration: (on) => {
      registration = on
    },
    kill: async () => {
      server.stop(true)
    },
  }
}
