// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which OAuth client Liaison signs in to an MCP server's authorization server
// as. The MCP authorization spec's priority:
//
//   1. a PRE-REGISTERED client: the client ID (and secret) an operator created
//      at the vendor, with Liaison's exact callback URL (oauth_static);
//   2. a CLIENT ID METADATA DOCUMENT: the client ID is the public HTTPS URL of
//      a JSON document Liaison serves, which the AS fetches. Only offered when
//      BASE_URL is public HTTPS and the AS advertises
//      `client_id_metadata_document_supported`;
//   3. DYNAMIC CLIENT REGISTRATION (RFC 7591, deprecated by 2026-07-28 but
//      still the common case) when the AS has a `registration_endpoint`;
//   4. otherwise the person is asked for client fields.

import { registerClient, selectClientAuthMethod } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  AuthorizationServerMetadata,
  OAuthClientMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type { Context } from "hono"
import { env } from "~/lib/env"
import { isPrivateIp } from "~/lib/ip-classify"
import { requestPublicBaseUrl } from "~/lib/org-public-url"
import { oauthFetch, UnsafeOAuthUrlError } from "~/modules/mcp-client/oauth-fetch"
import type { ClientIdSource } from "~/modules/mcp-client/secrets"
import type { OAuthContext } from "./oauth-discovery"

export const MCP_OAUTH_CALLBACK_PATH = "/api/apps/mcp-manager/oauth/callback"
export const MCP_CLIENT_METADATA_PATH = "/api/apps/mcp-manager/oauth/client-metadata.json"
const CLIENT_NAME = "Liaison"
const GRANT_TYPES = ["authorization_code", "refresh_token"]

/** Test seam: stands in for a public base URL. Inert outside NODE_ENV=test. */
let publicBaseUrlForTest: string | null = null

/**
 * The base of Liaison's MCP OAuth client for a request: the org host it came to
 * (requestPublicBaseUrl), BASE_URL on a deployment without org hosts. Not the
 * central OAuth redirect host: a dynamically registered or metadata-document
 * client needs no single pre-registered URI, and on the org host the callback
 * lands where the flow started without a bounce, and the metadata document is
 * served by the cell itself.
 */
export function mcpOAuthBaseUrl(c: Context): string {
  const override = env.NODE_ENV === "test" ? publicBaseUrlForTest : null
  return (override ?? requestPublicBaseUrl(c)).replace(/\/$/, "")
}

/** The exact redirect URL to register with a vendor (and to show to copy). */
export function callbackUrl(base: string): string {
  return `${base}${MCP_OAUTH_CALLBACK_PATH}`
}

function applicationType(base: string): "web" | "native" {
  return callbackUrl(base).startsWith("https://") ? "web" : "native"
}

function isPublicHttps(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== "https:") return false
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false
  return !isPrivateIp(host)
}

/**
 * The Client ID Metadata Document URL, which is also the client ID; null when
 * the instance is not reachable by an authorization server (a localhost or
 * private BASE_URL), where CIMD cannot work.
 */
export function cimdDocumentUrl(base: string): string | null {
  return isPublicHttps(base) ? `${base}${MCP_CLIENT_METADATA_PATH}` : null
}

/** The document an AS fetches from `cimdDocumentUrl()`. Its client_id IS that URL. */
export function clientMetadataDocument(base: string): Record<string, unknown> {
  return {
    client_id: cimdDocumentUrl(base),
    client_name: CLIENT_NAME,
    client_uri: base,
    redirect_uris: [callbackUrl(base)],
    grant_types: GRANT_TYPES,
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: applicationType(base),
  }
}

/**
 * The RFC 7591 registration request. `application_type` is a 2026-07-28 MUST
 * (`native` for a localhost callback). The auth method is picked from what the
 * AS accepts: a public client (PKCE only) when it can, else a secret.
 */
export function dcrClientMetadata(
  metadata: AuthorizationServerMetadata,
  base: string,
): OAuthClientMetadata & { application_type: "web" | "native" } {
  const methods = metadata.token_endpoint_auth_methods_supported
  let method: string | undefined
  if (methods && methods.length > 0) {
    method = ["none", "client_secret_basic", "client_secret_post"].find((m) => methods.includes(m))
  }
  return {
    client_name: CLIENT_NAME,
    redirect_uris: [callbackUrl(base)],
    grant_types: GRANT_TYPES,
    response_types: ["code"],
    application_type: applicationType(base),
    ...(method ? { token_endpoint_auth_method: method } : {}),
  }
}

export type OAuthRegistrationErrorCode = "client_registration_required" | "registration_failed"

export class OAuthRegistrationError extends Error {
  constructor(
    readonly code: OAuthRegistrationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "OAuthRegistrationError"
  }
}

export interface ExistingClient {
  clientId?: string
  clientSecret?: string
  clientIdSource?: ClientIdSource
  clientIssuer?: string
}

export interface ChosenClient {
  clientId: string
  clientSecret?: string
  source: ClientIdSource
  /** How the token endpoint authenticates this client. */
  tokenEndpointAuthMethod?: string
}

function askForClientFields(base: string): OAuthRegistrationError {
  return new OAuthRegistrationError(
    "client_registration_required",
    `This server's sign-in needs a client registered with it. Create an OAuth client at the vendor with the redirect URL ${callbackUrl(base)}, then enter its client ID (and secret).`,
  )
}

/** The client to sign in as, registering one when that is the way. */
export async function chooseClient(input: {
  authFlavor: string
  existing: ExistingClient
  ctx: Pick<OAuthContext, "issuer" | "authorizationServerUrl" | "metadata">
  scope?: string
  /** The client's base (mcpOAuthBaseUrl). */
  base: string
}): Promise<ChosenClient> {
  const { existing, ctx, base } = input
  const methods = ctx.metadata.token_endpoint_auth_methods_supported ?? []

  // 1. Pre-registered.
  if (input.authFlavor === "oauth_static" || existing.clientIdSource === "preregistered") {
    if (!existing.clientId) throw askForClientFields(base)
    return {
      clientId: existing.clientId,
      ...(existing.clientSecret ? { clientSecret: existing.clientSecret } : {}),
      source: "preregistered",
      tokenEndpointAuthMethod: selectClientAuthMethod(
        { client_id: existing.clientId, client_secret: existing.clientSecret },
        methods,
      ),
    }
  }

  const cimdUrl = cimdDocumentUrl(base)
  const cimdOffered =
    cimdUrl !== null &&
    (ctx.metadata as Record<string, unknown>).client_id_metadata_document_supported === true

  // A client this connection already holds, if it still fits this issuer.
  if (existing.clientId) {
    if (existing.clientIdSource === "cimd" && cimdOffered && existing.clientId === cimdUrl) {
      return { clientId: cimdUrl, source: "cimd", tokenEndpointAuthMethod: "none" }
    }
    // A client registered before the issuer was recorded is kept as it was.
    const sameIssuer = !existing.clientIssuer || existing.clientIssuer === ctx.issuer
    if (existing.clientIdSource !== "cimd" && sameIssuer) {
      return {
        clientId: existing.clientId,
        ...(existing.clientSecret ? { clientSecret: existing.clientSecret } : {}),
        source: "dcr",
        tokenEndpointAuthMethod: selectClientAuthMethod(
          { client_id: existing.clientId, client_secret: existing.clientSecret },
          methods,
        ),
      }
    }
  }

  // 2. Client ID Metadata Document.
  if (cimdOffered && cimdUrl) {
    return { clientId: cimdUrl, source: "cimd", tokenEndpointAuthMethod: "none" }
  }

  // 3. Dynamic Client Registration.
  if (ctx.metadata.registration_endpoint) {
    try {
      const info = await registerClient(ctx.authorizationServerUrl, {
        metadata: ctx.metadata,
        clientMetadata: dcrClientMetadata(ctx.metadata, base),
        ...(input.scope ? { scope: input.scope } : {}),
        fetchFn: oauthFetch,
      })
      return {
        clientId: info.client_id,
        ...(info.client_secret ? { clientSecret: info.client_secret } : {}),
        source: "dcr",
        tokenEndpointAuthMethod:
          info.token_endpoint_auth_method ??
          selectClientAuthMethod(info, ctx.metadata.token_endpoint_auth_methods_supported ?? []),
      }
    } catch (err) {
      const detail =
        err instanceof UnsafeOAuthUrlError
          ? `refusing unsafe URL (${err.message})`
          : (err as Error).message
      throw new OAuthRegistrationError(
        "registration_failed",
        `Dynamic client registration failed at ${ctx.metadata.registration_endpoint}: ${detail}. Register an OAuth client at the vendor with the redirect URL ${callbackUrl(base)} and enter its client ID (and secret) instead.`,
      )
    }
  }

  // 4. Ask.
  throw askForClientFields(base)
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const OAuthRegistrationTestAccess = {
  /** Stand in for a public HTTPS BASE_URL (CIMD). Ignored outside NODE_ENV=test. */
  setPublicBaseUrl(url: string | null): void {
    publicBaseUrlForTest = url
  },
}
