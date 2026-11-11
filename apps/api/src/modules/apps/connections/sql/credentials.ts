// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The credentials of a SQL connection and the transport built from them. A SQL
// connection (a manifest connection with an `sql` block, see sql/service.ts)
// stores exactly one of two credential modes:
//   - direct: `connectionString`, a Postgres (or Redshift) DSN the host dials
//     with postgres.js (`PostgresDirect`);
//   - gate:   `gateUrl` + `gateToken`, an HTTP db-gate sidecar next to the
//     database (`HttpGate`).
// The credentials are resolved and used on the host only: app code never sees
// them, only the rows a query returns.

import type { DbTransport } from "./transport"
import { HttpGate } from "./transports/http-gate"
import { PostgresDirect } from "./transports/postgres-direct"

const MAX_STATEMENT_TIMEOUT_MS = 300_000

// ------------------------------------------------------------ credential mode

export type CredentialMode = "direct" | "gate"

export class DatabaseConfigError extends Error {
  /** `agentSafe` marks a message fit for the agent verbatim (it names a field,
   *  never a path, a DSN or a parser's output). Anything else is logged and
   *  replaced by a generic hint. */
  constructor(
    message: string,
    public readonly agentSafe = false,
  ) {
    super(message)
    this.name = "DatabaseConfigError"
  }
}

export interface DatabaseCredentials {
  connectionString?: string
  gateUrl?: string
  gateToken?: string
  /**
   * NEVER read from a stored connection: it is set only by the host, after
   * credential resolution, for the public demo box's analytics warehouse
   * (`modules/demo/warehouse`). It marks a transport built on the warehouse's
   * OWN dedicated login (a separate DSN, a role that is a member of no
   * Liaison role), so every demo org shares one pool and the privileged-role
   * opt-out never applies to it.
   */
  sharedPool?: string
  /** Direct mode only: "postgres" (default) or "redshift". */
  dialect?: string
  /** Direct mode only: per-statement timeout, 1 s to 300 s (transport default 10 s). */
  statementTimeoutMs?: string
}

/**
 * Exactly-one-mode validation: DSN-only -> direct mode (gate fields
 * untouched); gate-only -> gate mode (connectionString untouched); both or
 * neither -> typed config error.
 */
export function resolveCredentialMode(creds: DatabaseCredentials): CredentialMode {
  const hasDsn = Boolean(creds.connectionString)
  const hasGate = Boolean(creds.gateUrl) || Boolean(creds.gateToken)
  if (hasDsn && hasGate) {
    throw new DatabaseConfigError(
      "database connection has both connectionString and gateUrl/gateToken set — exactly one credential mode is required",
      true,
    )
  }
  if (!hasDsn && !hasGate) {
    throw new DatabaseConfigError(
      "database connection is missing credentials — set either connectionString (direct mode) or gateUrl+gateToken (gate mode)",
      true,
    )
  }
  if (hasGate && (!creds.gateUrl || !creds.gateToken)) {
    throw new DatabaseConfigError("gate mode requires BOTH gateUrl and gateToken", true)
  }
  return hasDsn ? "direct" : "gate"
}

/**
 * `host:port` of this instance's own redis, search and object storage. A
 * connector DSN naming one is refused (see PostgresDirect `blockedEndpoints`).
 * Postgres is not listed: the liaison-self connection legitimately reaches the
 * instance's own database with a read-only login.
 */
export function instanceServiceEndpoints(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = []
  const defaults: Record<string, string> = {
    REDIS_URL: "redis://localhost:6379",
    MEILISEARCH_HOST: "http://localhost:7700",
    OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
  }
  for (const [name, fallback] of Object.entries(defaults)) {
    try {
      const url = new URL(env[name] || fallback)
      const port =
        url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "6379")
      out.push(`${url.hostname.toLowerCase().replace(/^\[|\]$/g, "")}:${port}`)
    } catch {
      // An unparseable service URL cannot be matched; the server would not boot on it.
    }
  }
  return out
}

/** LIAISON_DATABASE_ALLOWED_HOSTS: the operator's host allow-list, both modes. */
function operatorAllowedHosts(): string[] {
  return (process.env.LIAISON_DATABASE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
}

export function buildTransport(creds: DatabaseCredentials): DbTransport {
  const mode = resolveCredentialMode(creds)
  if (mode === "direct") {
    if (!creds.connectionString) {
      throw new DatabaseConfigError("connectionString is required in direct mode", true)
    }
    const dialect = creds.dialect || "postgres"
    if (dialect !== "postgres" && dialect !== "redshift") {
      throw new DatabaseConfigError(
        `dialect must be "postgres" or "redshift", got "${dialect}"`,
        true,
      )
    }
    let statementTimeoutMs: number | undefined
    if (creds.statementTimeoutMs) {
      statementTimeoutMs = Number(creds.statementTimeoutMs)
      if (
        !Number.isInteger(statementTimeoutMs) ||
        statementTimeoutMs < 1000 ||
        statementTimeoutMs > MAX_STATEMENT_TIMEOUT_MS
      ) {
        throw new DatabaseConfigError(
          `statementTimeoutMs must be an integer between 1000 and ${MAX_STATEMENT_TIMEOUT_MS}`,
          true,
        )
      }
    }
    return new PostgresDirect({
      dsn: creds.connectionString,
      dialect,
      allowPlaintextLocal: process.env.LIAISON_DB_ALLOW_PLAINTEXT_LOCAL === "true",
      ...(statementTimeoutMs ? { statementTimeoutMs } : {}),
      allowedHosts: operatorAllowedHosts(),
      blockedEndpoints: instanceServiceEndpoints(),
      // The demo warehouse host comes from deployment config, not from the org.
      ...(creds.sharedPool ? { trustedHost: true } : {}),
      // The opt-out is for an operator's own single-tenant database; the demo
      // warehouse (a host-built shared pool) can never use it.
      allowPrivilegedSession:
        !creds.sharedPool && process.env.LIAISON_DB_ALLOW_PRIVILEGED_SESSION === "true",
    })
  }
  if (!creds.gateUrl || !creds.gateToken) {
    throw new DatabaseConfigError("gateUrl and gateToken are required in gate mode", true)
  }
  return new HttpGate({
    gateUrl: creds.gateUrl,
    gateToken: creds.gateToken,
    // A private or loopback gate (a sidecar next to the database) is the
    // operator's choice: an allow-list entry, or the local-plaintext opt-in.
    allowPrivate: process.env.LIAISON_DB_ALLOW_PLAINTEXT_LOCAL === "true",
    allowedHosts: operatorAllowedHosts(),
    blockedEndpoints: instanceServiceEndpoints(),
  })
}
