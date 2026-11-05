// SPDX-License-Identifier: FSL-1.1-ALv2
//
// OAuth discovery for a remote MCP server, per the MCP authorization spec
// (2025-11-25 semantics plus the 2026-07-28 client MUSTs):
//
//   1. Protected Resource Metadata (RFC 9728): the URL a 401's
//      `WWW-Authenticate: Bearer resource_metadata=…` names, else the
//      path-aware well-known, else the root one. Its `resource` must BE this
//      server (RFC 9728 §3.3): a server that names another resource is refused
//      with the URL to use (HubSpot's eu1 alias names https://mcp.hubspot.com).
//   2. Authorization server metadata for `authorization_servers[0]`, in the
//      RFC 8414 / OpenID order (`buildDiscoveryUrls`; no root fallback for an
//      issuer with a path). Its `issuer` must equal the issuer it was fetched
//      for (RFC 8414 §3.3), and it must advertise PKCE S256: an AS that omits
//      `code_challenge_methods_supported` is refused, as the spec requires.
//
// Built on the SDK v1 `client/auth` building blocks with Liaison's SSRF-safe
// `oauthFetch` injected; the checks the SDK does not make (resource equality,
// issuer equality, S256 required) are ours.
//
// A pre-2025 server with no PRM keeps working: its origin is taken as the
// authorization server (the SDK's legacy fallback), and the fallback is logged.

import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  AuthorizationServerMetadata,
  OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import { rootLogger } from "~/lib/logger"
import {
  isAllowedOAuthEndpoint,
  oauthFetch,
  UnsafeOAuthUrlError,
} from "~/modules/mcp-client/oauth-fetch"
import type { WwwAuthChallenge } from "~/modules/mcp-client/transports/types"

const log = rootLogger.child({ module: "mcp-manager/oauth-discovery" })

export type { WwwAuthChallenge }

export type OAuthDiscoveryErrorCode =
  | "resource_mismatch"
  | "issuer_mismatch"
  | "pkce_unsupported"
  | "no_authorization_server"
  | "as_metadata_missing"
  | "invalid_metadata"
  | "unsafe_url"
  | "unsafe_endpoint"
  | "discovery_failed"

/** A refusal the person adding the server can act on: `message` says what to do. */
export class OAuthDiscoveryError extends Error {
  constructor(
    readonly code: OAuthDiscoveryErrorCode,
    message: string,
    /** True when the server published no PRM either: it may not use OAuth at all. */
    readonly noOAuthAdvertised = false,
  ) {
    super(message)
    this.name = "OAuthDiscoveryError"
  }
}

export interface OAuthContext {
  serverUrl: string
  /** RFC 8707 resource to send: the PRM `resource` VERBATIM (legacy: the server URI). */
  resource: string
  resourceMetadataUrl?: string
  /** True when the server has no PRM and its origin stood in as the AS. */
  legacy: boolean
  prmScopes?: string[]
  challengeScope?: string
  /** The URL the AS metadata was discovered for. */
  authorizationServerUrl: string
  /** The metadata `issuer`, checked against `authorizationServerUrl`. */
  issuer: string
  metadata: AuthorizationServerMetadata
  /** `authorization_response_iss_parameter_supported` (RFC 9207). */
  issSupported: boolean
}

/** `a` and `b` name the same resource, tolerating one trailing slash only. */
export function resourceMatches(a: string, b: string): boolean {
  const norm = (v: string) => {
    try {
      const u = new URL(v)
      u.hash = ""
      const href = u.href
      return href.endsWith("/") ? href.slice(0, -1) : href
    } catch {
      return v.endsWith("/") ? v.slice(0, -1) : v
    }
  }
  return norm(a) === norm(b)
}

/** The canonical URI of the server: no fragment, no trailing slash. */
export function canonicalServerUri(serverUrl: string): string {
  const u = new URL(serverUrl)
  u.hash = ""
  return u.href.endsWith("/") ? u.href.slice(0, -1) : u.href
}

export function challengeFromResponse(res: Response): WwwAuthChallenge | null {
  if (!res.headers.get("www-authenticate")) return null
  const p = extractWWWAuthenticateParams(res)
  if (!p.resourceMetadataUrl && !p.scope && !p.error) {
    // A bare `Bearer` (or a `Bearer realm=…`) challenge: still a Bearer server.
    return /^\s*bearer\b/i.test(res.headers.get("www-authenticate") ?? "") ? {} : null
  }
  return {
    ...(p.resourceMetadataUrl ? { resourceMetadataUrl: p.resourceMetadataUrl.href } : {}),
    ...(p.scope ? { scope: p.scope } : {}),
    ...(p.error ? { error: p.error } : {}),
  }
}

/**
 * An unauthenticated `initialize`, to read the server's answer: 2xx (open
 * server) or the 401 and its challenge.
 */
export async function probeMcpServer(
  serverUrl: string,
): Promise<{ status: number; challenge: WwwAuthChallenge | null }> {
  let res: Response
  try {
    res = await oauthFetch(serverUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "liaison-mcp-client", version: "0.1.0" },
        },
      }),
    })
  } catch (err) {
    if (err instanceof UnsafeOAuthUrlError) {
      throw new OAuthDiscoveryError("unsafe_url", `Refusing unsafe server URL: ${err.message}`)
    }
    throw new OAuthDiscoveryError(
      "discovery_failed",
      `Could not reach ${serverUrl}: ${(err as Error).message}`,
    )
  }
  const challenge = challengeFromResponse(res)
  await res.body?.cancel().catch(() => {})
  return { status: res.status, challenge }
}

/** The SDK parses metadata with zod: a failed parse is a server-side defect. */
function zodMessage(err: unknown): string | null {
  if (!err || typeof err !== "object" || (err as { name?: string }).name !== "ZodError") return null
  const issues = (err as { issues?: Array<{ message?: string; path?: unknown[] }> }).issues ?? []
  const first = issues[0]
  return first ? `${(first.path ?? []).join(".") || "document"}: ${first.message}` : "invalid"
}

/**
 * RFC 8414 §3.3: the metadata `issuer` must be IDENTICAL to the issuer the
 * metadata was looked up for, compared exactly. The one normalisation is for
 * the URL Liaison built itself in legacy discovery (`new URL("/", server)`,
 * which always gains a slash): there the issuer may be the bare origin.
 */
function issuersMatch(advertised: string, used: string, opts: { built: boolean }): boolean {
  if (advertised === used) return true
  return opts.built && used.endsWith("/") && advertised === used.slice(0, -1)
}

async function loadPrm(
  serverUrl: string,
  challenge: WwwAuthChallenge | null | undefined,
): Promise<OAuthProtectedResourceMetadata | undefined> {
  // The statuses the PRM lookups answered. A 4xx means the server publishes no
  // PRM (a pre-2025 server, legacy discovery): 404 usually, or a 401/403 from a
  // server that guards every path, since PRM is served unauthenticated. A 5xx
  // or a network failure is an outage, never a reason to trust the server's
  // origin as its AS.
  const statuses: number[] = []
  let networkError: unknown = null
  const recordingFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    try {
      const res = await oauthFetch(url, init)
      statuses.push(res.status)
      return res
    } catch (err) {
      networkError = err
      throw err
    }
  }
  try {
    return await discoverOAuthProtectedResourceMetadata(
      serverUrl,
      challenge?.resourceMetadataUrl
        ? { resourceMetadataUrl: new URL(challenge.resourceMetadataUrl) }
        : undefined,
      recordingFetch,
    )
  } catch (err) {
    if (err instanceof UnsafeOAuthUrlError) {
      throw new OAuthDiscoveryError(
        "unsafe_url",
        `Refusing unsafe resource metadata URL: ${err.message}`,
      )
    }
    const invalid = zodMessage(err)
    if (invalid) {
      throw new OAuthDiscoveryError(
        "invalid_metadata",
        `The server's protected resource metadata is invalid (${invalid}).`,
      )
    }
    const last = statuses.at(-1)
    if (last !== undefined && last >= 400 && last < 500 && !networkError) return undefined
    throw new OAuthDiscoveryError(
      "discovery_failed",
      `Could not load the server's protected resource metadata${last ? ` (HTTP ${last})` : ""}: ${((networkError ?? err) as Error).message}`,
    )
  }
}

/** PRM → AS metadata, with every check the spec puts on the client. */
export async function discoverOAuthContext(
  serverUrl: string,
  opts: { challenge?: WwwAuthChallenge | null } = {},
): Promise<OAuthContext> {
  const prm = await loadPrm(serverUrl, opts.challenge)
  let resource: string
  let authorizationServerUrl: string
  // Legacy discovery uses a URL Liaison built, not an issuer someone named.
  const builtIssuer = !prm
  if (prm) {
    if (!resourceMatches(prm.resource, serverUrl)) {
      throw new OAuthDiscoveryError(
        "resource_mismatch",
        `This server identifies itself as ${prm.resource}, not ${serverUrl}. Use ${prm.resource} as the server URL.`,
      )
    }
    const as = prm.authorization_servers?.[0]
    if (!as) {
      throw new OAuthDiscoveryError(
        "no_authorization_server",
        "The server's protected resource metadata names no authorization server.",
      )
    }
    resource = prm.resource
    authorizationServerUrl = as
  } else {
    resource = canonicalServerUri(serverUrl)
    authorizationServerUrl = new URL("/", serverUrl).href
    log.info(
      { serverUrl, authorizationServerUrl },
      "MCP server publishes no protected resource metadata; using its origin as the authorization server (legacy discovery)",
    )
  }

  let metadata: AuthorizationServerMetadata | undefined
  try {
    metadata = await discoverAuthorizationServerMetadata(authorizationServerUrl, {
      fetchFn: oauthFetch,
    })
  } catch (err) {
    if (err instanceof UnsafeOAuthUrlError) {
      throw new OAuthDiscoveryError(
        "unsafe_url",
        `Refusing unsafe authorization server URL: ${err.message}`,
      )
    }
    const invalid = zodMessage(err)
    if (invalid) {
      throw new OAuthDiscoveryError(
        "invalid_metadata",
        `The authorization server metadata at ${authorizationServerUrl} is invalid (${invalid}).`,
      )
    }
    throw new OAuthDiscoveryError(
      "discovery_failed",
      `Could not load the authorization server metadata at ${authorizationServerUrl}: ${(err as Error).message}`,
    )
  }
  if (!metadata) {
    throw new OAuthDiscoveryError(
      "as_metadata_missing",
      `No authorization server metadata at ${authorizationServerUrl}. The server's sign-in cannot be discovered; add its client ID and secret instead.`,
      !prm,
    )
  }
  if (!issuersMatch(metadata.issuer, authorizationServerUrl, { built: builtIssuer })) {
    throw new OAuthDiscoveryError(
      "issuer_mismatch",
      `The authorization server metadata names issuer ${metadata.issuer}, not ${authorizationServerUrl}; it cannot be trusted.`,
    )
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new OAuthDiscoveryError(
      "pkce_unsupported",
      "The authorization server does not advertise PKCE S256 (code_challenge_methods_supported), which MCP sign-in requires.",
    )
  }
  for (const [name, value] of [
    ["authorization_endpoint", metadata.authorization_endpoint],
    ["token_endpoint", metadata.token_endpoint],
    ["registration_endpoint", metadata.registration_endpoint],
  ] as const) {
    if (value !== undefined && !isAllowedOAuthEndpoint(value)) {
      throw new OAuthDiscoveryError(
        "unsafe_endpoint",
        `Refusing unsafe OAuth ${name}: only https URLs are allowed`,
      )
    }
  }

  const issSupported =
    (metadata as Record<string, unknown>).authorization_response_iss_parameter_supported === true
  return {
    serverUrl,
    resource,
    ...(opts.challenge?.resourceMetadataUrl
      ? { resourceMetadataUrl: opts.challenge.resourceMetadataUrl }
      : {}),
    legacy: !prm,
    ...(prm?.scopes_supported ? { prmScopes: prm.scopes_supported } : {}),
    ...(opts.challenge?.scope ? { challengeScope: opts.challenge.scope } : {}),
    authorizationServerUrl,
    issuer: metadata.issuer,
    metadata,
    issSupported,
  }
}

/**
 * The scope to ask for: the challenge's, else PRM `scopes_supported`, plus any
 * scope asked for earlier (step-up after `insufficient_scope`). Never an empty
 * string (the parameter is then omitted), and `offline_access` only when the
 * AS lists it.
 */
export function selectScope(
  ctx: {
    challengeScope?: string
    prmScopes?: string[]
    metadata: { scopes_supported?: string[] }
  },
  extra: string[] = [],
): string | undefined {
  const fromChallenge = (ctx.challengeScope ?? "").split(/\s+/).filter(Boolean)
  const base = fromChallenge.length > 0 ? fromChallenge : (ctx.prmScopes ?? [])
  const offlineAllowed = ctx.metadata.scopes_supported?.includes("offline_access") === true
  const out: string[] = []
  for (const s of [...base, ...extra]) {
    if (!s || out.includes(s)) continue
    if (s === "offline_access" && !offlineAllowed) continue
    out.push(s)
  }
  return out.length > 0 ? out.join(" ") : undefined
}
