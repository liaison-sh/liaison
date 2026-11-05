// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The two halves of what an MCP connection knows about its credentials:
//
//   - `secrets_encrypted`: one AES-256-GCM envelope (the existing
//     `CryptoContext.mcpConnectionSecrets`) holding every secret — the bearer
//     token, the OAuth client secret, the access and refresh tokens and the
//     custom header values;
//   - `oauth_metadata`: plaintext JSONB holding only what is NOT secret — where
//     the tokens come from, what they are for, when they expire.
//
// Every writer of the blob reads it, merges into it and writes it back whole,
// so a token rotation keeps the client secret and a header edit keeps the
// tokens.

import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { encryptionKey } from "~/lib/env"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "mcp-client/secrets" })

/** Decrypted shape of `mcp_connections.secrets_encrypted`. */
export interface McpSecretsBlob {
  bearerToken?: string
  oauthClientId?: string
  oauthClientSecret?: string
  accessToken?: string
  refreshToken?: string | null
  /** S28: header name → value, sent on every request to the server. */
  customHeaders?: Record<string, string>
}

/** Where an OAuth connection's client id came from (registration priority). */
export type ClientIdSource = "preregistered" | "cimd" | "dcr"

/** `mcp_connections.oauth_metadata`: non-secret, returned to the client as is. */
export interface McpOAuthMetadata {
  clientId?: string
  clientIdSource?: ClientIdSource
  /** The issuer a dynamically registered client id belongs to. */
  clientIssuer?: string
  /** The AS metadata `issuer`, validated at discovery. */
  issuer?: string
  /** The URL the AS metadata was discovered from (PRM `authorization_servers[0]`). */
  authorizationServerUrl?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  registrationEndpoint?: string
  /** The method the token endpoint authenticates this client with. */
  tokenEndpointAuthMethod?: string
  /** RFC 8707 resource, the PRM `resource` string verbatim. */
  resource?: string
  /** The scope granted (or last asked for). */
  scope?: string
  /** Scopes a 403 insufficient_scope asked for: the next sign-in requests them too. */
  requiredScope?: string
  /** Access token expiry, ISO 8601. */
  expiresAt?: string
  subject?: string
  serverCapabilities?: Record<string, unknown>
  /** oauth_static, admin-configured at create. */
  scopes?: string[]
}

/** What a stored secrets blob holds, or that it exists but cannot be decrypted. */
export type SecretsBlobRead = { ok: true; blob: McpSecretsBlob } | { ok: false }

export function readSecretsBlob(secretsEncrypted: string | null | undefined): SecretsBlobRead {
  if (!secretsEncrypted) return { ok: true, blob: {} }
  try {
    return {
      ok: true,
      blob: JSON.parse(
        decryptSecret(secretsEncrypted, encryptionKey, CryptoContext.mcpConnectionSecrets),
      ) as McpSecretsBlob,
    }
  } catch (err) {
    log.warn({ err }, "failed to decrypt mcp connection secrets blob")
    return { ok: false }
  }
}

/**
 * For readers: an unreadable blob reads as empty (no usable token). A writer
 * never uses this to build the blob it writes back; it uses
 * `decryptSecretsBlobForWrite`, so a key mix-up never destroys secrets that
 * restoring the key would recover.
 */
export function decryptSecretsBlob(secretsEncrypted: string | null | undefined): McpSecretsBlob {
  const read = readSecretsBlob(secretsEncrypted)
  return read.ok ? read.blob : {}
}

export const SECRETS_UNREADABLE_MESSAGE =
  "The connection's stored secrets cannot be decrypted (the server's ENCRYPTION_KEY changed?). Restore the key, or delete and re-add the connection."

/** The stored blob exists but cannot be decrypted; a writer must not overwrite it. */
export class SecretsUnreadableError extends Error {
  readonly code = "secrets_unreadable"
  constructor() {
    super(SECRETS_UNREADABLE_MESSAGE)
    this.name = "SecretsUnreadableError"
  }
}

/** The blob a writer merges into; throws `SecretsUnreadableError` rather than returning `{}`. */
export function decryptSecretsBlobForWrite(
  secretsEncrypted: string | null | undefined,
): McpSecretsBlob {
  const read = readSecretsBlob(secretsEncrypted)
  if (!read.ok) throw new SecretsUnreadableError()
  return read.blob
}

export function encryptSecretsBlob(blob: McpSecretsBlob): string {
  return encryptSecret(JSON.stringify(blob), encryptionKey, CryptoContext.mcpConnectionSecrets)
}

export function metadataOf(raw: unknown): McpOAuthMetadata {
  return raw && typeof raw === "object" ? (raw as McpOAuthMetadata) : {}
}

// ── S28 custom headers ─────────────────────────────────────────────────────

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/
const MAX_HEADERS = 20
const MAX_VALUE_LENGTH = 4096
/** Headers the transport owns, or that would let a value smuggle a request. */
const RESERVED = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "upgrade",
  "accept",
  "cookie",
  "proxy-authorization",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
])

/** Why a header set is refused, or null when it is acceptable. */
export function customHeadersProblem(
  headers: Record<string, string | null>,
  opts: { authFlavor: string },
): string | null {
  const names = Object.keys(headers)
  if (names.length > MAX_HEADERS) return `at most ${MAX_HEADERS} custom headers`
  for (const name of names) {
    if (!HEADER_NAME.test(name)) return `"${name}" is not a valid header name`
    const lower = name.toLowerCase()
    if (RESERVED.has(lower)) return `"${name}" is set by Liaison and cannot be a custom header`
    // Every flavour: a bearer or OAuth token owns it, and a no-auth connection
    // that needs one is a bearer connection.
    if (lower === "authorization") {
      return opts.authFlavor === "none"
        ? "Authorization is a credential; use a bearer connection for it"
        : "Authorization comes from the connection's token; set the token instead"
    }
    const value = headers[name]
    if (value === null) continue
    if (value.length > MAX_VALUE_LENGTH) return `"${name}" is longer than ${MAX_VALUE_LENGTH}`
    // CR, LF and NUL would split or truncate the request.
    if (/[\r\n\0]/.test(value)) return `"${name}" contains a line break`
  }
  return null
}

/** Apply a header patch: a string sets a header, null removes it. */
export function applyHeaderPatch(
  current: Record<string, string> | undefined,
  patch: Record<string, string | null>,
): Record<string, string> {
  const next: Record<string, string> = { ...(current ?? {}) }
  for (const [name, value] of Object.entries(patch)) {
    // Header names are case-insensitive: a patch replaces any spelling of it.
    for (const existing of Object.keys(next)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete next[existing]
    }
    if (value !== null) next[name] = value
  }
  return next
}

/** The names, never the values, for the API (sorted, stable). */
export function customHeaderNames(blob: McpSecretsBlob): string[] {
  return Object.keys(blob.customHeaders ?? {}).sort()
}
