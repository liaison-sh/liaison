// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PostgresDirect — DbTransport over a raw Postgres DSN via postgres.js (the
// driver liaison already uses elsewhere). Every execution runs inside
// `BEGIN TRANSACTION READ ONLY` + `SET LOCAL statement_timeout` + a row cap,
// under a pool-level concurrency bound independent of the timeout (C2).
// Column projection re-applies the read's allow-list to the actual result
// even if the underlying SQL returned more. TLS is enforced by resolved IP,
// never by hostname shape (M10).
//
// `dialect: "redshift"` keeps every one of those walls and changes only what
// Amazon Redshift (PG wire protocol, Postgres 8.0.2 catalog) cannot do:
// postgres.js's connect-time array-type fetch reads pg_type columns Redshift
// lacks (42703), so it is switched off; `describe` reads `svv_columns`
// (information_schema misses late-binding views and external tables) and the
// write-grant probe avoids a VALUES list (a Redshift syntax error). Measured
// against a live Redshift cluster, 2026-09-22.

import * as dns from "node:dns/promises"
import type { ReadCatalog, ReadDefinition } from "@liaison/db-core"
import {
  ConcurrencyBound,
  capRows,
  classifyDsnHost,
  classifyIp,
  type DnsResolver,
  EXECUTE_GRANT_PROBE_SQL,
  projectColumns,
  redactDbError,
  TlsRequiredError,
  toOrdinalSql,
  WRITE_GRANT_PROBE_SQL,
  wrapWithRowCap,
} from "@liaison/db-core"
import postgres from "postgres"
import { PRIVILEGED_ROLE_REACH_SQL } from "~/db/role-reach"
import { rootLogger } from "~/lib/logger"
import { ownOption } from "~/lib/safe-path"
import type {
  DbTransport,
  ExecOptions,
  ProbeReport,
  RunQueryResult,
  RunReadResult,
  SchemaInfo,
} from "../transport"
import { DbTransportError } from "../transport"

const log = rootLogger.child({ module: "database-postgres-direct" })

const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000
const DEFAULT_ROW_CAP = 500
const HARD_ROW_CAP = 2000
const DEFAULT_POOL_MAX = 4
const DEFAULT_CONCURRENCY_BOUND = 4
/** How long a passed privileged-role pre-flight is trusted before it is asked again. */
const SESSION_CONFINED_TTL_MS = 60_000

export type SqlDialect = "postgres" | "redshift"

export interface PostgresDirectOptions {
  dsn: string
  /** Defaults to "postgres". See the header for what "redshift" changes. */
  dialect?: SqlDialect
  statementTimeoutMs?: number
  poolMax?: number
  concurrencyLimit?: number
  /** DNS resolver seam — defaults to real DNS; tests inject a stub. */
  resolveDns?: DnsResolver
  /** Off-by-default local-only TLS exception opt-in. */
  allowPlaintextLocal?: boolean
  /**
   * Skip the pre-flight that refuses a login able to `SET ROLE` to a superuser
   * or BYPASSRLS role. OFF by default. It exists for one legitimate shape: an
   * operator connecting the connector to a database that is theirs alone, with
   * a deliberately privileged login, where there is no other tenant to cross
   * into. The bridge sets it only from `LIAISON_DB_ALLOW_PRIVILEGED_SESSION`,
   * and never for the demo warehouse.
   */
  allowPrivilegedSession?: boolean
  /**
   * Operator allow-list of DSN hosts (`host`, `*.suffix`, or an IP literal).
   * Empty or unset: any host passes the allow-list step, and only the fixed
   * denials below apply. Set: the DSN host must match one entry.
   */
  allowedHosts?: readonly string[]
  /**
   * `host:port` pairs of the instance's own services (redis, search, object
   * storage) that a DSN must never name, so the connector cannot be pointed at
   * them to probe or to read their error replies.
   */
  blockedEndpoints?: readonly string[]
  /** Skip the allow-list and blocked-endpoint steps for a host that deployment
   *  config (never user input) chose, such as the demo warehouse. Link-local
   *  and metadata addresses stay refused. */
  trustedHost?: boolean
  /** postgres.js factory seam — defaults to the real driver; unit tests inject a fake. */
  connect?: (
    dsn: string,
    options: postgres.Options<Record<string, postgres.PostgresType>>,
  ) => postgres.Sql
}

/**
 * Redshift's readable surface. `svv_columns` covers late-binding views and
 * external tables, but lists every object whose metadata the user can see, so
 * readability is re-checked per table. `has_table_privilege` RAISES (rather
 * than returning false) on a schema without USAGE, hence the CASE guard, which
 * Redshift evaluates in order. A view over a schema the role cannot use is
 * absent from `svv_columns` altogether, which is right: it cannot be selected.
 */
const REDSHIFT_DESCRIBE_SQL = `SELECT c.table_schema, c.table_name, c.column_name, c.data_type
   FROM svv_columns c
   WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_internal')
     AND ($1::text IS NULL OR c.table_schema = $1)
     AND ($2::text IS NULL OR c.table_name = $2)
     AND CASE WHEN has_schema_privilege(current_user, c.table_schema, 'USAGE')
       THEN has_table_privilege(
         current_user,
         quote_ident(c.table_schema) || '.' || quote_ident(c.table_name),
         'SELECT'
       )
       ELSE false END
   ORDER BY c.table_schema, c.table_name, c.ordinal_position`

/** WRITE_GRANT_PROBE_SQL's Redshift twin: no VALUES list, the same USAGE guard. */
const REDSHIFT_WRITE_GRANT_PROBE_SQL = `SELECT t.table_schema, t.table_name, p.privilege_type
   FROM svv_tables t
   CROSS JOIN (SELECT 'INSERT'::varchar AS privilege_type
     UNION ALL SELECT 'UPDATE' UNION ALL SELECT 'DELETE' UNION ALL SELECT 'REFERENCES') p
   WHERE t.table_type IN ('BASE TABLE', 'VIEW')
     AND t.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_internal')
     AND CASE WHEN has_schema_privilege(current_user, t.table_schema, 'USAGE')
       THEN has_table_privilege(
         current_user,
         quote_ident(t.table_schema) || '.' || quote_ident(t.table_name),
         p.privilege_type
       )
       ELSE false END`

const defaultDnsResolver: DnsResolver = async (host: string): Promise<string[]> => {
  try {
    const results = await dns.lookup(host, { all: true })
    return results.map((r) => r.address)
  } catch {
    return []
  }
}

function parseDsnHost(dsn: string): string {
  try {
    const url = new URL(dsn.replace(/^postgres(ql)?:\/\//, "http://"))
    // Unbracketed: `[::1]` is not something DNS resolves, and an unresolved
    // host must never be what decides the policy.
    return url.hostname.replace(/^\[|\]$/g, "")
  } catch {
    throw new DbTransportError("Malformed DSN — could not parse host", "config")
  }
}

/**
 * Sends the protocol-level CancelRequest for a running postgres.js query (a
 * fresh socket carrying the backend's pid + secret key, the same request psql's
 * Ctrl-C sends; Redshift honours it too).
 *
 * `query.cancel()` is not called: postgres.js 3.x drops the promise its
 * canceller returns, so a cancel that cannot connect becomes an unhandled
 * rejection, which is fatal in this process (lib/process-handlers.ts). Calling
 * the canceller directly keeps that promise and its failure, which is only
 * logged: the statement timeout still bounds the query.
 */
function cancelOnServer(query: unknown, context: string): void {
  const q = query as { canceller?: ((q: unknown) => Promise<void>) | null }
  const canceller = q.canceller
  if (typeof canceller !== "function") return
  q.canceller = null
  Promise.resolve()
    .then(() => canceller(query))
    .catch((err) => {
      log.warn(
        { err: redactDbError(err), context },
        "database: cancel request failed, the statement timeout still bounds the query",
      )
    })
}

/** Link-local, unspecified and cloud-metadata addresses: never a database. */
export function isForbiddenResolvedIp(ip: string): boolean {
  const v = normaliseIp(ip)
  return (
    /^169\.254\./.test(v) ||
    /^0\./.test(v) ||
    v === "::" ||
    v === "0:0:0:0:0:0:0:0" ||
    /^fe[89ab][0-9a-f]:/.test(v) ||
    v === "fd00:ec2::254"
  )
}

/**
 * Lower-case and unbracketed, with an IPv4-mapped IPv6 address (dotted, or the
 * hex form `new URL` produces: `::ffff:a9fe:a9fe`) reduced to its IPv4 form, so
 * every check sees the address the socket will actually reach.
 */
export function normaliseIp(ip: string): string {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "")
  const dotted = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)
  if (dotted?.[1]) return dotted[1]
  const hex = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v)
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16)
    const lo = Number.parseInt(hex[2], 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return v
}

function parseDsnHostPort(dsn: string): { host: string; port: string } {
  try {
    const url = new URL(dsn.replace(/^postgres(ql)?:\/\//, "http://"))
    return { host: url.hostname.toLowerCase().replace(/^\[|\]$/g, ""), port: url.port || "5432" }
  } catch {
    throw new DbTransportError("Malformed DSN — could not parse host", "config")
  }
}

/** Does `host` match an allow-list entry: exact, or `*.suffix` for subdomains? */
export function hostMatchesAllowList(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase()
  return allowed.some((entry) => {
    const e = entry.trim().toLowerCase()
    if (!e) return false
    if (e.startsWith("*.")) return h.endsWith(e.slice(1)) && h.length > e.length - 1
    return h === e
  })
}

/** Network-level failures: all one message, so the connector is not a port-scan oracle. */
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
])

function isNetworkFailure(err: unknown, code: string | undefined): boolean {
  if (code && NETWORK_ERROR_CODES.has(code)) return true
  if (code) return false
  const raw = err instanceof Error ? err.message : String(err)
  return /ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|getaddrinfo|socket|connect(ion)? (closed|timeout|refused)/i.test(
    raw,
  )
}

function isIpLiteral(host: string): boolean {
  return /^[0-9.]+$/.test(host) || /^[0-9a-fA-F:]+$/.test(host)
}

/**
 * Whether `port` on any of `ips` (normalised resolved addresses) is one of the
 * instance's own services in `blockedEndpoints` (`host:port`, lower-case),
 * compared by RESOLVED address, so another spelling of the same endpoint (an
 * IP literal, another name, `localhost` for `127.0.0.1`) matches too. Shared by
 * the direct and the gate transport.
 */
export async function namesInstanceService(
  port: string,
  ips: readonly string[],
  blockedEndpoints: readonly string[],
  resolveDns: DnsResolver,
): Promise<boolean> {
  if (blockedEndpoints.length === 0) return false
  const mine = new Set(ips)
  const mineLoopback = ips.some((ip) => classifyIp(ip) === "loopback")
  for (const endpoint of blockedEndpoints) {
    const cut = endpoint.lastIndexOf(":")
    const bHost = endpoint.slice(0, cut).replace(/^\[|\]$/g, "")
    const bPort = endpoint.slice(cut + 1)
    if (bPort !== port) continue
    const theirs = isIpLiteral(bHost) ? [bHost] : await resolveDns(bHost)
    const hit = theirs.some(
      (ip) =>
        mine.has(normaliseIp(ip)) || (mineLoopback && classifyIp(normaliseIp(ip)) === "loopback"),
    )
    if (hit) return true
  }
  return false
}

export { PRIVILEGED_ROLE_REACH_SQL }

export class PostgresDirect implements DbTransport {
  private readonly sql: ReturnType<typeof postgres>
  private readonly statementTimeoutMs: number
  private readonly concurrency: ConcurrencyBound
  private readonly resolveDns: DnsResolver
  private readonly allowPlaintextLocal: boolean
  private readonly dsn: string
  private readonly dialect: SqlDialect
  private readonly allowPrivilegedSession: boolean
  private readonly allowedHosts: readonly string[]
  private readonly blockedEndpoints: readonly string[]
  private readonly trustedHost: boolean
  private tlsChecked = false
  /** Until when the last privileged-role pre-flight verdict holds. */
  private confinedUntil = 0

  constructor(opts: PostgresDirectOptions) {
    this.dsn = opts.dsn
    this.statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS
    this.concurrency = new ConcurrencyBound(opts.concurrencyLimit ?? DEFAULT_CONCURRENCY_BOUND)
    this.resolveDns = opts.resolveDns ?? defaultDnsResolver
    this.allowPlaintextLocal = ownOption(opts, "allowPlaintextLocal") ?? false
    this.dialect = opts.dialect ?? "postgres"
    this.allowPrivilegedSession = ownOption(opts, "allowPrivilegedSession") ?? false
    this.allowedHosts = opts.allowedHosts ?? []
    this.blockedEndpoints = (opts.blockedEndpoints ?? []).map((e) => e.toLowerCase())
    this.trustedHost = ownOption(opts, "trustedHost") ?? false
    try {
      this.sql = (opts.connect ?? postgres)(opts.dsn, {
        max: opts.poolMax ?? DEFAULT_POOL_MAX,
        idle_timeout: 20,
        connect_timeout: 10,
        onnotice: () => {},
        ...(this.dialect === "redshift" ? { fetch_types: false } : {}),
      })
    } catch {
      // The driver's parse error quotes the whole connection string, password
      // included. It never leaves this constructor.
      throw new DbTransportError(
        "Malformed connection string: expected postgres://user:password@host:port/database (URL-encode reserved characters in the password)",
        "config",
      )
    }
  }

  /**
   * The operator allow-list, by DSN host name (or IP literal). Refusals name the
   * rule, never what the host is or where it points.
   */
  private assertAllowList(host: string): void {
    if (this.trustedHost) return
    if (this.allowedHosts.length > 0 && !hostMatchesAllowList(host, this.allowedHosts)) {
      throw new DbTransportError(
        "This database host is not on the allow-list set by the operator (LIAISON_DATABASE_ALLOWED_HOSTS)",
        "config",
      )
    }
  }

  /**
   * The instance's own non-database services, compared by RESOLVED address and
   * port, so a different spelling of the same endpoint (an IP literal, another
   * name, `localhost` for `127.0.0.1`) is refused as well.
   */
  private async assertNotInstanceService(port: string, dsnIps: readonly string[]): Promise<void> {
    if (this.trustedHost) return
    if (await namesInstanceService(port, dsnIps, this.blockedEndpoints, this.resolveDns)) {
      throw new DbTransportError(
        "This address belongs to a service of this Liaison instance and cannot be used as a database",
        "config",
      )
    }
  }

  /** Enforces the host policy and TLS-by-resolved-IP (M10) before any
   *  connection is attempted: the operator allow-list, no link-local or
   *  metadata address, none of this instance's own services, and TLS for a
   *  non-local resolved IP (refused, not warned). A DNS answer that changes
   *  between this check and the driver's own lookup is not covered here; the
   *  generic connection-failure message keeps such a probe blind. */
  async assertTlsPolicy(): Promise<void> {
    if (this.tlsChecked) return
    const host = parseDsnHost(this.dsn)
    const { port } = parseDsnHostPort(this.dsn)
    this.assertAllowList(host.toLowerCase().replace(/^\[|\]$/g, ""))
    const hasSslParam = /[?&]sslmode=(require|verify-ca|verify-full)/i.test(this.dsn)
    // Classified on the normalised addresses: an IPv4-mapped IPv6 answer is the
    // IPv4 address it maps to, for the TLS rule as much as for the denials.
    const classification = await classifyDsnHost(host, async (h) =>
      (await this.resolveDns(h)).map(normaliseIp),
    )
    if (classification.resolvedIps.length === 0) {
      // Nothing to check the policy against: refuse, with the same answer as
      // any other failed connection.
      throw new DbTransportError("Could not connect to the database", "unreachable")
    }
    if (classification.resolvedIps.some(isForbiddenResolvedIp)) {
      throw new DbTransportError(
        "This database host is not allowed: link-local and metadata addresses cannot be connected",
        "config",
      )
    }
    await this.assertNotInstanceService(port, classification.resolvedIps)
    if (classification.tlsRequired && !hasSslParam) {
      // Typed here, not only in mapError: this runs before any try/catch in
      // the callers, and an untyped throw reached the agent as not_connected.
      throw new DbTransportError(new TlsRequiredError(host).message, "tls_required")
    }
    // Private and loopback hosts may run without TLS (connectivity ladder rung
    // 0/1); LIAISON_DB_ALLOW_PLAINTEXT_LOCAL only makes the loopback exception
    // explicit.
    this.tlsChecked = true
  }

  /**
   * Every execution's transaction preamble: READ ONLY and a statement timeout,
   * then the privileged-role pre-flight. `SET`/`SET LOCAL` throughout, so both
   * are gone again the moment the transaction ends.
   */
  private async begin<T>(
    fn: (tx: postgres.TransactionSql) => Promise<T>,
    opts?: ExecOptions,
  ): Promise<T> {
    // A call already out of time never takes a connection.
    if (opts?.signal?.aborted) throw this.abortedError()
    const timeoutMs = this.effectiveTimeoutMs(opts)
    return this.sql.begin(async (tx) => {
      await tx.unsafe("SET TRANSACTION READ ONLY")
      await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`)
      await this.assertSessionConfined(tx)
      return fn(tx)
    }) as Promise<T>
  }

  /**
   * Pre-flight, BEFORE any caller SQL: refuses a login that is a superuser or
   * can reach a superuser or BYPASSRLS role (`SET ROLE`, or a
   * `set_config('role', ...)` that slipped past the SQL guard). The READ ONLY
   * transaction and the SQL guard both run inside the session the login
   * opened, so a login that can step into a privileged role leaves every
   * tenant one missed guard rule away. Fails closed: a check that cannot run
   * refuses too. The verdict is cached for a minute, then asked again, so a
   * membership granted to the login after the pool opened is seen.
   * Redshift has no BYPASSRLS roles to reach (its superuser flag is on the
   * user, with no role membership), so the check is Postgres only.
   */
  private async assertSessionConfined(tx: postgres.TransactionSql): Promise<void> {
    if (this.allowPrivilegedSession || this.dialect === "redshift") return
    if (this.confinedUntil > Date.now()) return
    let rows: Record<string, unknown>[]
    try {
      rows = (await this.exec(tx, PRIVILEGED_ROLE_REACH_SQL)) as unknown as Record<
        string,
        unknown
      >[]
    } catch (err) {
      log.warn({ err: redactDbError(err) }, "database: privileged-role pre-flight could not run")
      throw new DbTransportError(
        "Could not verify that the database login is confined to its own role: refusing to run",
        "config",
      )
    }
    if (rows.length > 0) {
      throw new DbTransportError(
        "The database login is a superuser or can assume a superuser or BYPASSRLS role (or a role that reaches the server's files or programs). Connect with a dedicated read-only login that is a member of no such role.",
        "config",
      )
    }
    this.confinedUntil = Date.now() + SESSION_CONFINED_TTL_MS
  }

  /** The configured timeout, shortened (never lengthened) by the call's bound. */
  private effectiveTimeoutMs(opts?: ExecOptions): number {
    const bound = opts?.statementTimeoutMs
    if (typeof bound !== "number" || !Number.isFinite(bound)) return this.statementTimeoutMs
    return Math.max(1, Math.min(this.statementTimeoutMs, Math.floor(bound)))
  }

  private abortedError(): DbTransportError {
    return new DbTransportError(
      "The query was cancelled before it ran: the tool call ran out of time",
      "timeout",
    )
  }

  /**
   * Runs caller-supplied or catalog SQL on the EXTENDED protocol, always.
   * postgres.js sends a parameterless `unsafe` over the simple protocol,
   * which executes every statement in the string: one lexer desync in the
   * SQL guard was then enough to `COMMIT` the READ ONLY transaction and run
   * anything after it. A Parse message holds exactly one statement, so the
   * server itself refuses a second one (Postgres and Redshift alike).
   */
  private exec(
    tx: postgres.TransactionSql,
    text: string,
    values: unknown[] = [],
    signal?: AbortSignal,
  ) {
    const query = tx.unsafe(text, values as never[], { prepare: false, simple: false } as never)
    if (!signal) return query
    // An abort cancels the statement on the server: postgres.js rejects the
    // query with 57014 once the server stops it, and `begin` rolls back.
    const onAbort = () => cancelOnServer(query, "exec")
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
    return query.finally(() => signal.removeEventListener("abort", onAbort))
  }

  async probe(opts?: ExecOptions): Promise<ProbeReport> {
    await this.assertTlsPolicy()
    const warnings: string[] = []
    let writeGrantsDetected = false
    let dangerousExecuteGrantsDetected = false
    try {
      // Effective-privilege check (has_table_privilege) — broader than
      // information_schema.role_table_grants WHERE grantee=current_user,
      // which misses grants to PUBLIC and grants inherited via role
      // membership (pg_auth_members). See WRITE_GRANT_PROBE_SQL's doc.
      const writeGrantRows = await this.begin(
        (tx) =>
          this.exec(
            tx,
            this.dialect === "redshift" ? REDSHIFT_WRITE_GRANT_PROBE_SQL : WRITE_GRANT_PROBE_SQL,
            [],
            opts?.signal,
          ),
        opts,
      )
      if (writeGrantRows.length > 0) {
        writeGrantsDetected = true
        warnings.push(
          `Role "${await this.currentUser()}" has ${writeGrantRows.length} effective non-SELECT privilege(s) (direct, PUBLIC, or inherited) — expected a read-only role`,
        )
      }
    } catch (err) {
      warnings.push(`Could not check write grants: ${redactDbError(err).message}`)
    }
    try {
      // Same broadening for EXECUTE — has_function_privilege includes
      // PUBLIC + inherited grants, not just direct grants to current_user.
      const executeRows = await this.begin(
        (tx) => this.exec(tx, EXECUTE_GRANT_PROBE_SQL, [], opts?.signal),
        opts,
      )
      if (executeRows.length > 0) {
        dangerousExecuteGrantsDetected = true
        warnings.push(
          `Role "${await this.currentUser()}" has ${executeRows.length} effective EXECUTE privilege(s) (direct, PUBLIC, or inherited) beyond built-ins — verify against the curated allow-list`,
        )
      }
    } catch (err) {
      warnings.push(`Could not check EXECUTE grants: ${redactDbError(err).message}`)
    }
    return {
      ok: warnings.length === 0,
      mode: "direct",
      writeGrantsDetected,
      dangerousExecuteGrantsDetected,
      warnings,
    }
  }

  private async currentUser(): Promise<string> {
    const rows = await this.begin((tx) => tx.unsafe("SELECT current_user"))
    return String((rows as unknown as Record<string, unknown>[])[0]?.current_user ?? "unknown")
  }

  async runRead(
    read: ReadDefinition,
    readName: string,
    params: Record<string, unknown>,
    opts?: ExecOptions,
  ): Promise<RunReadResult> {
    await this.assertTlsPolicy()
    const { text, values } = toOrdinalSql(read.sql, params)
    const maxRows = Math.min(read.maxRows ?? DEFAULT_ROW_CAP, HARD_ROW_CAP)
    const cappedText = wrapWithRowCap(text, maxRows)
    return this.concurrency.run(async () => {
      const start = Date.now()
      try {
        // Curated reads lean on the connected role's
        // `default_transaction_read_only` today, but that is a property of
        // WHICH role is connected, not a guarantee this code path holds
        // regardless — `begin` sets it explicitly (mirrors runQuery) so layer
        // 5 holds even when the deployment's role isn't the recommended
        // read-only one (gate mode: "role recommended, not required").
        const rows = await this.begin((tx) => this.exec(tx, cappedText, values, opts?.signal), opts)
        const capped = capRows(rows as unknown as Record<string, unknown>[], maxRows)
        const projected = projectColumns(capped.rows, read.columns)
        return { rows: projected, truncated: capped.truncated, durationMs: Date.now() - start }
      } catch (err) {
        throw this.mapError(err, readName, opts)
      }
    })
  }

  async runQuery(sqlText: string, opts?: ExecOptions): Promise<RunQueryResult> {
    await this.assertTlsPolicy()
    const maxRows = DEFAULT_ROW_CAP
    const cappedText = wrapWithRowCap(sqlText, maxRows)
    return this.concurrency.run(async () => {
      const start = Date.now()
      try {
        // READ ONLY txn is the structural wall (layer 5) — it must hold even
        // if the caller's sql-guard validation was somehow bypassed (this is
        // exactly what the "READ ONLY txn blocks an INSERT smuggled past the
        // validator" integration test proves, calling runQuery directly).
        const rows = await this.begin((tx) => this.exec(tx, cappedText, [], opts?.signal), opts)
        const capped = capRows(rows as unknown as Record<string, unknown>[], maxRows)
        return { rows: capped.rows, truncated: capped.truncated, durationMs: Date.now() - start }
      } catch (err) {
        throw this.mapError(err, "raw_query", opts)
      }
    })
  }

  async describe(_catalog: ReadCatalog, table?: string, opts?: ExecOptions): Promise<SchemaInfo> {
    // Same TLS wall as every other execution: describe also sends the
    // credential over the wire.
    await this.assertTlsPolicy()
    // DISCOVERY, grounded in the role's ACTUAL grants — not the curated catalog.
    // `has_column_privilege(current_user, ...)` returns exactly the columns the
    // read-only role may SELECT: this is both safe (secret columns were never
    // granted, so they can never appear here — the grant allow-list IS the filter)
    // and complete (the agent sees every table/column it can actually read, so it
    // can form its own db_query, not just the pre-declared reads). Excludes the
    // Postgres system catalogs. With no `table`, returns the whole readable surface;
    // with a `table` (schema-qualified `schema.name`, or a bare table name), narrows.
    const [schemaFilter, nameFilter] =
      table && table.includes(".") ? table.split(".") : [null, table ?? null]
    // Runs through `begin` so the same preamble (READ ONLY, timeout, privileged
    // role pre-flight) applies as to every read: `current_user` below is the
    // role the reads run as, so the map describes exactly what they can select.
    const rows = (await this.begin(
      (tx) =>
        this.exec(
          tx,
          this.dialect === "redshift"
            ? REDSHIFT_DESCRIBE_SQL
            : `SELECT c.table_schema, c.table_name, c.column_name, c.data_type
         FROM information_schema.columns c
         WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
           AND ($1::text IS NULL OR c.table_schema = $1)
           AND ($2::text IS NULL OR c.table_name = $2)
           AND has_column_privilege(
             current_user,
             quote_ident(c.table_schema) || '.' || quote_ident(c.table_name),
             c.column_name,
             'SELECT'
           )
         ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
          [schemaFilter, nameFilter],
          opts?.signal,
        ),
      opts,
    ).catch((err) => {
      throw this.mapError(err, "describe", opts)
    })) as unknown as {
      table_schema: string
      table_name: string
      column_name: string
      data_type: string
    }[]
    const byTable = new Map<string, SchemaInfo["tables"][number]>()
    for (const r of rows) {
      const key = `${r.table_schema}.${r.table_name}`
      let entry = byTable.get(key)
      if (!entry) {
        entry = { table: key, columns: [] }
        byTable.set(key, entry)
      }
      entry.columns.push({ column: String(r.column_name), dataType: String(r.data_type) })
    }
    return { tables: [...byTable.values()] }
  }

  private mapError(err: unknown, context: string, opts?: ExecOptions): DbTransportError {
    if (err instanceof DbTransportError) return err
    if (err instanceof TlsRequiredError) {
      return new DbTransportError(err.message, "tls_required")
    }
    const { message, code } = redactDbError(err)
    if (isNetworkFailure(err, code)) {
      // Refused, timed out, unresolvable, reset: one answer, so an org admin
      // cannot map the private network from the error text. The detail stays
      // in the server log.
      log.warn({ err: { message, code }, context }, "database: connection failed")
      return new DbTransportError("Could not connect to the database", "unreachable")
    }
    if (code === "57014") {
      // 57014 is both the server's statement timeout and our own cancel: the
      // abort signal tells which. Either way the statement is gone server side.
      return new DbTransportError(
        opts?.signal?.aborted
          ? `Query cancelled on the database: the tool call ran out of time (${context})`
          : `Query exceeded the ${this.effectiveTimeoutMs(opts)} ms statement timeout and was cancelled on the database (${context})`,
        "timeout",
        code,
      )
    }
    if (code === "28P01" || code === "28000") {
      return new DbTransportError("Authentication failed", "auth", code)
    }
    if (code === "42501") {
      return new DbTransportError("Permission denied by the database role", "execution", code)
    }
    if (code === "25006") {
      return new DbTransportError(
        "Write attempted in a READ ONLY transaction — blocked",
        "execution",
        code,
      )
    }
    return new DbTransportError(message, "execution", code)
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 })
  }
}
