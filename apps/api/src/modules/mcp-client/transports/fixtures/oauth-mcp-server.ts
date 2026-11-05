// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A spec-compliant OAuth-protected MCP server pair for tests, on loopback:
//
//   - a RESOURCE SERVER: the official SDK `McpServer` behind
//     `WebStandardStreamableHTTPServerTransport` (one transport per session),
//     at `<rs>/mcp`, with a hand-rolled bearer check that answers 401 with
//     `WWW-Authenticate: Bearer resource_metadata="…", scope="…"` (or without
//     `resource_metadata`, so the client has to probe the well-known itself),
//     and Protected Resource Metadata (RFC 9728) at the PATH-AWARE location
//     only (`/.well-known/oauth-protected-resource/mcp`; the root 404s);
//   - a separate AUTHORIZATION SERVER: RFC 8414 metadata, DCR (RFC 7591),
//     Client ID Metadata Documents, PKCE S256 enforced, `resource` (RFC 8707)
//     enforced on authorize and token, RFC 9207 `iss` on the authorization
//     response, short-lived access tokens, rotating refresh tokens and
//     revocation.
//
// Every misbehaviour a client must refuse is a knob (`setOptions`), so one
// fixture drives the happy paths and the refusals. The authorize endpoint is a
// programmatic consent: `authorize(url)` returns the redirect a browser would
// follow.

import { createHash, randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"

export interface PreregisteredClient {
  clientId: string
  clientSecret?: string
  authMethod: "none" | "client_secret_post" | "client_secret_basic"
  /** The redirect URLs the operator registered with the client. */
  redirectUris?: string[]
}

export interface OAuthFixtureOptions {
  /** Advertise `registration_endpoint` (DCR). Default true. */
  registration: boolean
  /** Advertise `client_id_metadata_document_supported`. Default false. */
  cimd: boolean
  /** `code_challenge_methods_supported`; `null` omits the field. Default ["S256"]. */
  codeChallengeMethods: string[] | null
  /** Metadata `issuer` that differs from the URL it is served for (a refusal case). */
  issuerOverride: string | null
  /** What `iss` the authorization response carries. Default "correct". */
  issPolicy: "correct" | "missing" | "wrong"
  /** Advertise `authorization_response_iss_parameter_supported`. Default true. */
  issSupported: boolean
  /** PRM `resource` other than the server's own URI (a refusal case). */
  prmResourceOverride: string | null
  /** Include `resource_metadata` in the 401 challenge. Default true. */
  challengeWithResourceMetadata: boolean
  /** `scope` in the 401 challenge; `null` omits it. Default "mcp:tools". */
  challengeScope: string | null
  /** Access token lifetime. Default 2 s. */
  accessTokenTtlSec: number
  /** AS `scopes_supported`. */
  scopesSupported: string[]
  /** PRM `scopes_supported`. */
  prmScopesSupported: string[]
  /** AS `token_endpoint_auth_methods_supported`. */
  tokenEndpointAuthMethods: string[]
  /**
   * How the AS fetches a Client ID Metadata Document (the test routes it to
   * the Liaison app under test). Required when `cimd` is on.
   */
  fetchClientMetadata: ((url: string) => Promise<Response>) | null
  /** Hold every token request this long before answering (widens races). */
  tokenDelayMs: number
  /** Answer every token request with a 307 to this URL (a cross-origin redirect case). */
  tokenRedirectTo: string | null
}

export interface OAuthFixtureStats {
  registerCalls: number
  authorizationCodeGrants: number
  /** Every refresh_token POST, including the refused ones. */
  refreshPosts: number
  /** Refresh POSTs answered with a new token pair. */
  refreshSuccesses: number
  rs401: number
  rs403: number
  /** Query of the last authorization request. */
  lastAuthorize: Record<string, string> | null
  /** Form bodies of every token request, in order. */
  tokenRequests: Array<Record<string, string>>
  /** Access tokens the resource server accepted, in order. */
  acceptedTokens: string[]
  /** CIMD documents the AS fetched. */
  cimdFetches: string[]
}

export interface OAuthFixtureHandle {
  /** The MCP endpoint, `http://127.0.0.1:<rs>/mcp`. */
  mcpUrl: string
  /** The issuer the AS identifies as (its origin, or origin + `asPath`). */
  issuer: string
  stats: OAuthFixtureStats
  setOptions(patch: Partial<OAuthFixtureOptions>): void
  /** Pre-register a client (no DCR), e.g. a confidential client. */
  addClient(client: PreregisteredClient): void
  /** Follow an authorization URL as a consenting user: the redirect back. */
  authorize(authorizationUrl: string): Promise<URL>
  /** Revoke every access token issued so far (early revocation). */
  revokeAccessTokens(): void
  /** Revoke every refresh token issued so far. */
  revokeRefreshTokens(): void
  /** Answer the next `n` token requests with `status` (default 503). */
  failNextTokenRequests(n: number, status?: number): void
  close(): Promise<void>
}

interface IssuedAccess {
  clientId: string
  scope: string
  resource: string
  expiresAt: number
  revoked: boolean
}

interface IssuedRefresh {
  clientId: string
  scope: string
  resource: string
  active: boolean
}

interface PendingCode {
  clientId: string
  redirectUri: string
  codeChallenge: string
  scope: string
  resource: string
}

interface RegisteredClient extends PreregisteredClient {
  redirectUris: string[]
}

const DEFAULTS: OAuthFixtureOptions = {
  registration: true,
  cimd: false,
  codeChallengeMethods: ["S256"],
  issuerOverride: null,
  issPolicy: "correct",
  issSupported: true,
  prmResourceOverride: null,
  challengeWithResourceMetadata: true,
  challengeScope: "mcp:tools",
  accessTokenTtlSec: 2,
  scopesSupported: ["mcp:tools", "mcp:admin"],
  prmScopesSupported: ["mcp:tools"],
  tokenEndpointAuthMethods: ["none", "client_secret_post"],
  fetchClientMetadata: null,
  tokenDelayMs: 0,
  tokenRedirectTo: null,
}

/** The one tool that needs `mcp:admin`: calling it without that scope is a 403 step-up. */
export const ADMIN_TOOL = "admin_report"

function b64url(buf: Buffer): string {
  return buf.toString("base64url")
}

function formOf(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(text).entries()) out[k] = v
  return out
}

function oauthError(error: string, status = 400, description?: string): Response {
  return Response.json(
    { error, ...(description ? { error_description: description } : {}) },
    { status },
  )
}

export async function startOAuthMcpFixture(
  initial: Partial<OAuthFixtureOptions> & { asPath?: string } = {},
): Promise<OAuthFixtureHandle> {
  const { asPath = "", ...rest } = initial
  const opts: OAuthFixtureOptions = { ...DEFAULTS, ...rest }
  const stats: OAuthFixtureStats = {
    registerCalls: 0,
    authorizationCodeGrants: 0,
    refreshPosts: 0,
    refreshSuccesses: 0,
    rs401: 0,
    rs403: 0,
    lastAuthorize: null,
    tokenRequests: [],
    acceptedTokens: [],
    cimdFetches: [],
  }
  const clients = new Map<string, RegisteredClient>()
  const codes = new Map<string, PendingCode>()
  const accessTokens = new Map<string, IssuedAccess>()
  const refreshTokens = new Map<string, IssuedRefresh>()
  let failTokens = { remaining: 0, status: 503 }

  // ── Authorization server ────────────────────────────────────────────────
  let asOrigin = ""
  const issuerOf = () => `${asOrigin}${asPath}`

  function asMetadata(): Record<string, unknown> {
    const issuer = issuerOf()
    return {
      issuer: opts.issuerOverride ?? issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      ...(opts.registration ? { registration_endpoint: `${issuer}/register` } : {}),
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      ...(opts.codeChallengeMethods
        ? { code_challenge_methods_supported: opts.codeChallengeMethods }
        : {}),
      token_endpoint_auth_methods_supported: opts.tokenEndpointAuthMethods,
      scopes_supported: opts.scopesSupported,
      ...(opts.issSupported ? { authorization_response_iss_parameter_supported: true } : {}),
      ...(opts.cimd ? { client_id_metadata_document_supported: true } : {}),
    }
  }

  async function resolveClient(clientId: string): Promise<RegisteredClient | null> {
    const known = clients.get(clientId)
    if (known) return known
    if (!opts.cimd || !/^https?:\/\//.test(clientId) || !opts.fetchClientMetadata) return null
    stats.cimdFetches.push(clientId)
    const res = await opts.fetchClientMetadata(clientId)
    if (!res.ok) return null
    const doc = (await res.json()) as Record<string, unknown>
    // CIMD: the document's client_id MUST equal the URL it was fetched from.
    if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) return null
    return {
      clientId,
      authMethod: "none",
      redirectUris: doc.redirect_uris.filter((u): u is string => typeof u === "string"),
    }
  }

  function issueTokens(clientId: string, scope: string, resource: string) {
    const access = `at-${randomUUID()}`
    const refresh = `rt-${randomUUID()}`
    accessTokens.set(access, {
      clientId,
      scope,
      resource,
      expiresAt: Date.now() + opts.accessTokenTtlSec * 1000,
      revoked: false,
    })
    refreshTokens.set(refresh, { clientId, scope, resource, active: true })
    return Response.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: opts.accessTokenTtlSec,
      refresh_token: refresh,
      scope,
    })
  }

  /** Client authentication at the token endpoint (RFC 6749 §2.3.1). */
  function authenticateClient(
    client: RegisteredClient,
    form: Record<string, string>,
    authz: string | null,
  ): boolean {
    if (client.authMethod === "none") return true
    if (client.authMethod === "client_secret_post") {
      return form.client_secret === client.clientSecret
    }
    if (!authz?.startsWith("Basic ")) return false
    const [id, secret] = Buffer.from(authz.slice(6), "base64").toString().split(":")
    return id === client.clientId && secret === client.clientSecret
  }

  async function handleAs(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    const wellKnown = `/.well-known/oauth-authorization-server${asPath}`
    if (path === wellKnown) return Response.json(asMetadata())
    if (!path.startsWith(asPath)) return new Response("not found", { status: 404 })
    const local = path.slice(asPath.length)

    if (local === "/register" && req.method === "POST" && opts.registration) {
      stats.registerCalls++
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      const method = (body.token_endpoint_auth_method as string | undefined) ?? "none"
      const authMethod =
        method === "client_secret_post" || method === "client_secret_basic" ? method : "none"
      const client: RegisteredClient = {
        clientId: `dcr-${randomUUID()}`,
        ...(authMethod === "none" ? {} : { clientSecret: `secret-${randomUUID()}` }),
        authMethod,
        redirectUris: (body.redirect_uris as string[] | undefined) ?? [],
      }
      clients.set(client.clientId, client)
      return Response.json(
        {
          ...body,
          client_id: client.clientId,
          ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
          token_endpoint_auth_method: authMethod,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        },
        { status: 201 },
      )
    }

    if (local === "/authorize" && req.method === "GET") {
      const q = Object.fromEntries(url.searchParams.entries())
      stats.lastAuthorize = q
      const client = await resolveClient(q.client_id ?? "")
      if (!client) return oauthError("invalid_client", 400, "unknown client")
      if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
        return oauthError("invalid_request", 400, "redirect_uri not registered")
      }
      const back = new URL(q.redirect_uri)
      if (q.state) back.searchParams.set("state", q.state)
      const refuse = (error: string) => {
        back.searchParams.set("error", error)
        return Response.redirect(back.toString(), 302)
      }
      if (q.response_type !== "code") return refuse("unsupported_response_type")
      if (q.code_challenge_method !== "S256" || !q.code_challenge) return refuse("invalid_request")
      // RFC 8707: the resource is required here and must name this server.
      if (q.resource !== rsResource()) return refuse("invalid_target")
      const code = `code-${randomUUID()}`
      codes.set(code, {
        clientId: client.clientId,
        redirectUri: q.redirect_uri,
        codeChallenge: q.code_challenge,
        scope: q.scope ?? "",
        resource: q.resource,
      })
      back.searchParams.set("code", code)
      if (opts.issPolicy === "correct") back.searchParams.set("iss", issuerOf())
      if (opts.issPolicy === "wrong") back.searchParams.set("iss", "https://attacker.example")
      return Response.redirect(back.toString(), 302)
    }

    if (local === "/token" && req.method === "POST") {
      const form = formOf(await req.text())
      stats.tokenRequests.push(form)
      if (opts.tokenDelayMs > 0) await new Promise((r) => setTimeout(r, opts.tokenDelayMs))
      if (form.grant_type === "refresh_token") stats.refreshPosts++
      if (opts.tokenRedirectTo) {
        return new Response(null, { status: 307, headers: { location: opts.tokenRedirectTo } })
      }
      if (failTokens.remaining > 0) {
        failTokens.remaining--
        return new Response("temporarily unavailable", { status: failTokens.status })
      }
      const authz = req.headers.get("authorization")
      const basicId = authz?.startsWith("Basic ")
        ? Buffer.from(authz.slice(6), "base64").toString().split(":")[0]
        : undefined
      const client = await resolveClient(form.client_id ?? basicId ?? "")
      if (!client || !authenticateClient(client, form, authz)) {
        return oauthError("invalid_client", 401)
      }
      if (form.resource !== rsResource()) return oauthError("invalid_target")
      if (form.grant_type === "authorization_code") {
        const pending = codes.get(form.code ?? "")
        if (!pending || pending.clientId !== client.clientId) return oauthError("invalid_grant")
        codes.delete(form.code ?? "")
        if (pending.redirectUri !== form.redirect_uri) return oauthError("invalid_grant")
        const challenge = b64url(
          createHash("sha256")
            .update(form.code_verifier ?? "")
            .digest(),
        )
        if (challenge !== pending.codeChallenge) return oauthError("invalid_grant")
        if (pending.resource !== form.resource) return oauthError("invalid_target")
        stats.authorizationCodeGrants++
        return issueTokens(client.clientId, pending.scope, pending.resource)
      }
      if (form.grant_type === "refresh_token") {
        const rt = refreshTokens.get(form.refresh_token ?? "")
        if (!rt?.active || rt.clientId !== client.clientId) {
          return oauthError("invalid_grant", 400, "refresh token is not active")
        }
        // Rotation: a refresh token is good for one use.
        rt.active = false
        stats.refreshSuccesses++
        return issueTokens(client.clientId, rt.scope, rt.resource)
      }
      return oauthError("unsupported_grant_type")
    }

    if (local === "/revoke" && req.method === "POST") {
      const form = formOf(await req.text())
      const at = accessTokens.get(form.token ?? "")
      if (at) at.revoked = true
      const rt = refreshTokens.get(form.token ?? "")
      if (rt) rt.active = false
      return new Response(null, { status: 200 })
    }
    return new Response("not found", { status: 404 })
  }

  const asServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handleAs })
  asOrigin = `http://127.0.0.1:${asServer.port}`

  // ── Resource server ─────────────────────────────────────────────────────
  let rsOrigin = ""
  const rsResource = () => opts.prmResourceOverride ?? `${rsOrigin}/mcp`
  const prmPath = "/.well-known/oauth-protected-resource/mcp"

  function challenge(status: 401 | 403, extra: { error?: string; scope?: string } = {}) {
    const parts: string[] = []
    if (extra.error) parts.push(`error="${extra.error}"`)
    if (opts.challengeWithResourceMetadata) {
      parts.push(`resource_metadata="${rsOrigin}${prmPath}"`)
    }
    const scope = extra.scope ?? opts.challengeScope
    if (scope) parts.push(`scope="${scope}"`)
    if (status === 401) stats.rs401++
    else stats.rs403++
    return new Response(JSON.stringify({ error: extra.error ?? "invalid_token" }), {
      status,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer ${parts.join(", ")}`,
      },
    })
  }

  type Session = { server: McpServer; transport: WebStandardStreamableHTTPServerTransport }
  const sessions = new Map<string, Session>()

  function buildSession(): Session {
    const server = new McpServer({ name: "oauth-fixture", version: "0.0.1" })
    server.tool("echo", "Echo the input message", { message: z.string() }, async ({ message }) => ({
      content: [{ type: "text", text: message }],
    }))
    server.tool(ADMIN_TOOL, "Needs the mcp:admin scope", {}, async () => ({
      content: [{ type: "text", text: "admin report" }],
    }))
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    })
    return { server, transport }
  }

  async function handleRs(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === prmPath) {
      return Response.json({
        resource: rsResource(),
        authorization_servers: [issuerOf()],
        scopes_supported: opts.prmScopesSupported,
        bearer_methods_supported: ["header"],
      })
    }
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 })

    const authz = req.headers.get("authorization")
    const token = authz?.startsWith("Bearer ") ? authz.slice(7) : null
    const issued = token ? accessTokens.get(token) : undefined
    if (
      !token ||
      !issued ||
      issued.revoked ||
      issued.expiresAt <= Date.now() ||
      // Audience: a token minted for another resource is not good here.
      issued.resource !== `${rsOrigin}/mcp`
    ) {
      return challenge(401)
    }
    if (req.method === "POST") {
      const body = (await req
        .clone()
        .json()
        .catch(() => null)) as { method?: string; params?: { name?: string } } | null
      const granted = issued.scope.split(" ")
      if (
        body?.method === "tools/call" &&
        body.params?.name === ADMIN_TOOL &&
        !granted.includes("mcp:admin")
      ) {
        return challenge(403, { error: "insufficient_scope", scope: "mcp:tools mcp:admin" })
      }
    }
    stats.acceptedTokens.push(token)

    const sessionId = req.headers.get("mcp-session-id")
    let session = sessionId ? sessions.get(sessionId) : undefined
    if (!session) {
      const fresh = buildSession()
      await fresh.server.connect(fresh.transport)
      fresh.transport.onclose = () => {
        if (fresh.transport.sessionId) sessions.delete(fresh.transport.sessionId)
      }
      session = fresh
    }
    const response = await session.transport.handleRequest(req)
    const sid = session.transport.sessionId
    if (sid && !sessions.has(sid)) sessions.set(sid, session)
    return response
  }

  const rsServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handleRs })
  rsOrigin = `http://127.0.0.1:${rsServer.port}`

  return {
    mcpUrl: `${rsOrigin}/mcp`,
    get issuer() {
      return issuerOf()
    },
    stats,
    setOptions(patch) {
      Object.assign(opts, patch)
    },
    addClient(client) {
      clients.set(client.clientId, { ...client, redirectUris: client.redirectUris ?? [] })
    },
    async authorize(authorizationUrl) {
      const res = await handleAs(new Request(authorizationUrl))
      const location = res.headers.get("location")
      if (res.status !== 302 || !location) {
        throw new Error(`authorize refused: HTTP ${res.status} ${await res.text()}`)
      }
      return new URL(location)
    },
    revokeAccessTokens() {
      for (const t of accessTokens.values()) t.revoked = true
    },
    revokeRefreshTokens() {
      for (const t of refreshTokens.values()) t.active = false
    },
    failNextTokenRequests(n, status = 503) {
      failTokens = { remaining: n, status }
    },
    async close() {
      await Promise.allSettled(Array.from(sessions.values()).map((s) => s.transport.close()))
      sessions.clear()
      rsServer.stop(true)
      asServer.stop(true)
    },
  }
}

/**
 * Sign in against the fixture directly (DCR public client, PKCE), without
 * Liaison: for tests that need a real token pair to seed a connection with.
 */
export async function signInDirectly(
  fixture: OAuthFixtureHandle,
  redirectUri = "http://localhost/cb",
): Promise<{ clientId: string; accessToken: string; refreshToken: string; expiresIn: number }> {
  const reg = (await (
    await fetch(`${fixture.issuer}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
    })
  ).json()) as { client_id: string }
  const verifier = b64url(Buffer.from(randomUUID() + randomUUID()))
  const auth = new URL(`${fixture.issuer}/authorize`)
  auth.searchParams.set("response_type", "code")
  auth.searchParams.set("client_id", reg.client_id)
  auth.searchParams.set("redirect_uri", redirectUri)
  auth.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()))
  auth.searchParams.set("code_challenge_method", "S256")
  auth.searchParams.set("resource", fixture.mcpUrl)
  auth.searchParams.set("scope", "mcp:tools")
  const back = await fixture.authorize(auth.toString())
  const tokenRes = await fetch(`${fixture.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: reg.client_id,
      resource: fixture.mcpUrl,
    }).toString(),
  })
  const tokens = (await tokenRes.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }
  return {
    clientId: reg.client_id,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
  }
}
