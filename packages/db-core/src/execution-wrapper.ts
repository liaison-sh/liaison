// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared execution-wrapper primitives used by both PostgresDirect
// (`apps/api/src/apps/database/transports/postgres-direct.ts`) and the
// `apps/db-gate` sidecar, so both drive the same READ ONLY / statement-timeout
// / row-cap / column-projection / pool-concurrency-bound behavior from one
// implementation (Task 3 + Task 4). This module holds the PURE, easily
// unit-testable pieces:
//
//   - `classifyDsnHost` — TLS-by-resolved-IP classifier (a DNS-resolution seam
//     so tests don't hit real DNS).
//   - `ConcurrencyBound` — a pool-level concurrency semaphore, independent of
//     `statement_timeout` (C2): bounds how many in-flight executions may run
//     concurrently regardless of how long any one of them takes.
//   - `projectColumns` — enforces a read's declared column allow-list on a
//     result-row set even if the underlying query happened to return more
//     (defense in depth against a catalog author writing `SELECT *`).
//   - `capRows` — truncates a row array to a max and flags truncation.
//   - `redactDbError` — strips DSN/connection-param/raw-driver-payload text
//     from an error, preserving SQLSTATE + a sanitized message (gitlab
//     `mapError` pattern).

const LOOPBACK_RE = /^127\./
const RFC1918_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/
const IPV6_LOOPBACK = "::1"
const IPV6_ULA_RE = /^f[cd][0-9a-f]{2}:/i // fc00::/7 (unique local)
const IPV6_LINK_LOCAL_RE = /^fe80:/i

export type ResolvedIpKind = "loopback" | "private" | "public"

/** Classifies a single resolved IP address (v4 or v6). Pure — no I/O. */
export function classifyIp(ip: string): ResolvedIpKind {
  if (ip === IPV6_LOOPBACK || LOOPBACK_RE.test(ip)) return "loopback"
  if (RFC1918_RE.test(ip) || IPV6_ULA_RE.test(ip) || IPV6_LINK_LOCAL_RE.test(ip)) return "private"
  return "public"
}

export interface DsnHostClassification {
  host: string
  resolvedIps: string[]
  kind: ResolvedIpKind
  /** True when TLS is required for a DSN to this host (kind === "public"). */
  tlsRequired: boolean
}

/** DNS-resolution seam — a function `host -> ip[]`. Production uses real DNS
 *  (Bun's `dns.lookup` equivalent); tests inject a stub so no real DNS is hit. */
export type DnsResolver = (host: string) => Promise<string[]>

/**
 * Classifies a DSN host by its RESOLVED IP (never by hostname shape) — a bare
 * name or a `.internal`-suffixed name that resolves to a public IP is
 * classified `public` (TLS required), not trusted because of its name.
 *
 * The most-public-wins rule applies when a host resolves to multiple IPs of
 * mixed kinds (loopback/private + public): if ANY resolved IP is public, TLS
 * is required — a partially-public-resolving name is not a safe local
 * exception.
 */
export async function classifyDsnHost(
  host: string,
  resolve: DnsResolver,
): Promise<DsnHostClassification> {
  const resolvedIps = await resolve(host)
  if (resolvedIps.length === 0) {
    // Could not resolve at all — fail closed (treat as public/untrusted).
    return { host, resolvedIps, kind: "public", tlsRequired: true }
  }
  const kinds = resolvedIps.map(classifyIp)
  const kind: ResolvedIpKind = kinds.includes("public")
    ? "public"
    : kinds.includes("private")
      ? "private"
      : "loopback"
  return { host, resolvedIps, kind, tlsRequired: kind === "public" }
}

export class TlsRequiredError extends Error {
  constructor(host: string) {
    super(
      `TLS is required to connect to "${host}" (resolves to a non-local IP). ` +
        `Use sslmode=require (or verify-full), or set LIAISON_DB_ALLOW_PLAINTEXT_LOCAL=true ` +
        `only for a genuinely local-only exception.`,
    )
    this.name = "TlsRequiredError"
  }
}

// -------------------------------------------------------------- concurrency

/**
 * A pool-level concurrency bound, independent of `statement_timeout` (C2):
 * blunts a pg_sleep-shaped pool-exhaustion DoS even if a dangerous-function
 * call somehow slips past sql-guard and the role-layer EXECUTE revocation —
 * only `limit` executions may be in-flight at once; further callers queue.
 */
export class ConcurrencyBound {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error("ConcurrencyBound limit must be >= 1")
  }

  get activeCount(): number {
    return this.active
  }
  get queuedCount(): number {
    return this.queue.length
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++
        resolve()
      })
    })
  }

  private release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }

  /** Runs `fn` under the concurrency bound, queuing if the limit is reached. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

// ------------------------------------------------------------ row shaping

export interface CapRowsResult<T> {
  rows: T[]
  truncated: boolean
}

/** Truncates `rows` to `maxRows`, flagging truncation. Pure. Callers should
 *  prefer `wrapWithRowCap` (appending `LIMIT maxRows+1` to the executed SQL)
 *  so the driver never fetches more than `maxRows+1` rows in the first
 *  place; this function then only needs to trim that one extra row and flip
 *  `truncated` — no full-result-set-then-slice memory hazard. */
export function capRows<T>(rows: T[], maxRows: number): CapRowsResult<T> {
  if (rows.length <= maxRows) return { rows, truncated: false }
  return { rows: rows.slice(0, maxRows), truncated: true }
}

/** `sql` without the semicolons that end it. A backward scan, linear in their
 *  number; the caller has already trimmed the text. */
function stripTrailingSemicolons(sql: string): string {
  let end = sql.length
  while (end > 0 && sql.charCodeAt(end - 1) === 0x3b) end--
  return sql.slice(0, end)
}

/**
 * Wraps an arbitrary single-statement SQL string in an outer
 * `SELECT * FROM (<sql>) AS __liaison_row_cap LIMIT <maxRows + 1>` so the
 * driver fetches at most `maxRows + 1` rows regardless of how large the
 * underlying result would otherwise be (spec §3.1: "LIMIT/cursor", not
 * fetch-all-then-slice in JS). The `+1` lets the caller distinguish "exactly
 * maxRows rows" from "more than maxRows rows" via `capRows` without a second
 * COUNT query. Subquery-wrapping (rather than appending a bare `LIMIT`
 * clause) is used because the input SQL may already end in `ORDER BY`,
 * `LIMIT`, or a CTE — appending text blindly risks producing invalid SQL or
 * silently overriding an inner LIMIT the query already needed for its own
 * semantics; wrapping is always syntactically valid for any single SELECT/
 * WITH statement. Pure — string transform, no I/O.
 */
export function wrapWithRowCap(sql: string, maxRows: number): string {
  const trimmed = stripTrailingSemicolons(sql.trim())
  // The statement sits on its own lines so a trailing `-- comment` ends at the
  // newline instead of swallowing the wrapper's `)` and LIMIT.
  return `SELECT * FROM (\n${trimmed}\n) AS __liaison_row_cap LIMIT ${maxRows + 1}`
}

/**
 * Projects each row down to exactly `columns` (the read's declared allow-list)
 * even if the underlying row has more keys — defense in depth against a
 * catalog author writing `SELECT *`. Non-vacuous by construction: any key not
 * in `columns` is dropped, regardless of what the query actually returned.
 */
export function projectColumns<T extends Record<string, unknown>>(
  rows: T[],
  columns: readonly string[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const projected: Record<string, unknown> = {}
    for (const col of columns) {
      if (col in row) projected[col] = row[col]
    }
    return projected
  })
}

// --------------------------------------------------------------- probe SQL

/**
 * SQL for the connect-time probe's write-grant check (layer 8). Broader than
 * `information_schema.role_table_grants WHERE grantee = current_user`, which
 * only sees grants made DIRECTLY to the connected role and misses (a) grants
 * to PUBLIC (every role implicitly has these) and (b) grants inherited via
 * role membership (`pg_auth_members` — e.g. `current_user` is a member of a
 * role that itself holds a write grant). `has_table_privilege(...)` evaluates
 * the EFFECTIVE privilege — PUBLIC + inheritance included — for the given
 * role, which is what actually determines whether a write would succeed.
 * Scoped to ordinary tables/views in non-system schemas that `current_user`
 * can see at all (via `has_table_privilege(..., 'SELECT')`), so it doesn't
 * spuriously flag privileges on tables the role can't even read.
 */
export const WRITE_GRANT_PROBE_SQL = `
  SELECT n.nspname AS table_schema, c.relname AS table_name, priv.privilege_type
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('TRIGGER')) AS priv(privilege_type)
  WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND has_table_privilege(current_user, c.oid, priv.privilege_type)
`

/**
 * SQL for the connect-time probe's dangerous-EXECUTE-grant check (layer 8),
 * same broadening rationale as `WRITE_GRANT_PROBE_SQL` —
 * `has_function_privilege` evaluates the EFFECTIVE EXECUTE privilege
 * (PUBLIC + inherited role membership included), not just direct grants to
 * `current_user`.
 */
export const EXECUTE_GRANT_PROBE_SQL = `
  SELECT n.nspname AS routine_schema, p.proname AS routine_name
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND has_function_privilege(current_user, p.oid, 'EXECUTE')
`

// ------------------------------------------------------------- redaction

const DSN_RE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"']*/g
const PASSWORD_KV_RE = /\b(password|pwd|pass|token|secret)\s*[=:]\s*[^\s,;"']+/gi
/** A message longer than this is cut before redaction: the text comes from the
 *  connected database (values echoed back, or a hostile server), and DSN_RE
 *  rescans from every letter of a long run, quadratic in the length. */
const MAX_ERROR_MESSAGE_CHARS = 4_096

/**
 * Redacts DSN/connection-string fragments, `password=`/`token=`-shaped
 * key-value pairs, and raw driver payloads from an error's message + stack,
 * preserving the SQLSTATE code (if present as `.code`) and a sanitized
 * message. Mirrors the gitlab `mapError` pattern — never let a raw pg error
 * reach a tool result or log line.
 */
export function redactDbError(err: unknown): { message: string; code?: string } {
  const full = err instanceof Error ? err.message : String(err)
  const raw =
    full.length > MAX_ERROR_MESSAGE_CHARS ? `${full.slice(0, MAX_ERROR_MESSAGE_CHARS)}…` : full
  const code =
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : undefined
  const redacted = raw
    .replace(DSN_RE, "[redacted-dsn]")
    .replace(PASSWORD_KV_RE, "[redacted-credential]")
  return { message: redacted, code }
}
