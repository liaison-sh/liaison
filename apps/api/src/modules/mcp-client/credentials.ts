// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The credentials a live MCP transport sends, read PER REQUEST. A transport is
// dialed once and kept in the pool for minutes; a token refreshed in the
// meantime (proactively, or after a 401) must be what its NEXT request carries,
// or the retry after a refresh goes out with the token that was just refused.
// So the transport's fetch asks this store for the current Authorization and
// custom headers on every request, and the refresher updates the store.
//
// The cache is per engine (per process); the database is the truth across
// processes. A process holding an older token learns of a newer one when its
// refresh takes the connection's lock and re-reads the row.

import { createHash } from "node:crypto"
import type { ConnectionRow } from "~/apps/mcp-manager/types"
import { decryptSecretsBlob, metadataOf } from "./secrets"

/** Within this many ms of expiry a call refreshes first (S27). */
export const PROACTIVE_REFRESH_WINDOW_MS = 60_000

export interface ConnectionCredentials {
  isOAuth: boolean
  /** `Bearer <token>`, or null for an unauthenticated connection. */
  authorization: string | null
  /** S28 custom headers. */
  headers: Record<string, string>
  /** Access token expiry (ms since epoch); null when the server gave none. */
  expiresAt: number | null
  /** Fingerprint of the token in `authorization` (never the token itself). */
  tokenFingerprint: string | null
}

/** A short, non-reversible name for a token, safe to log and compare. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16)
}

export function needsProactiveRefresh(
  creds: Pick<ConnectionCredentials, "isOAuth" | "expiresAt">,
  now = Date.now(),
): boolean {
  if (!creds.isOAuth || creds.expiresAt === null) return false
  return creds.expiresAt - now <= PROACTIVE_REFRESH_WINDOW_MS
}

export function credentialsFromRow(row: ConnectionRow): ConnectionCredentials {
  const blob = decryptSecretsBlob(row.secretsEncrypted)
  const isOAuth = row.authFlavor === "oauth_dcr" || row.authFlavor === "oauth_static"
  const token = (isOAuth ? blob.accessToken : blob.bearerToken) ?? null
  const expiry = isOAuth ? Date.parse(metadataOf(row.oauthMetadata).expiresAt ?? "") : Number.NaN
  return {
    isOAuth,
    authorization: token ? `Bearer ${token}` : null,
    headers: { ...(blob.customHeaders ?? {}) },
    expiresAt: Number.isFinite(expiry) ? expiry : null,
    tokenFingerprint: token ? tokenFingerprint(token) : null,
  }
}

export class CredentialStore {
  private readonly cache = new Map<string, ConnectionCredentials>()

  constructor(private readonly load: (connectionId: string) => Promise<ConnectionRow | null>) {}

  async get(connectionId: string): Promise<ConnectionCredentials> {
    const cached = this.cache.get(connectionId)
    if (cached) return cached
    const row = await this.load(connectionId)
    if (!row) throw new Error(`connection ${connectionId} not found`)
    const creds = credentialsFromRow(row)
    this.cache.set(connectionId, creds)
    return creds
  }

  /** Replace from a row just read or written. */
  setFromRow(row: ConnectionRow): void {
    this.cache.set(row.id, credentialsFromRow(row))
  }

  invalidate(connectionId: string): void {
    this.cache.delete(connectionId)
  }
}
