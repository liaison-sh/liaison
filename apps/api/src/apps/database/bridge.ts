// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * database connector — host-side RPC bridge extension.
 *
 * One method per tool. Each method:
 *   1. Resolves database credentials from the connections store (via
 *      `ctx.txDb` — used ONLY for `getCredentialsForConnection` and the
 *      audit write; every actual target-database read goes through the
 *      DSN/gate-built transport, never through `ctx.txDb`).
 *   2. Builds/reuses a `DbTransport` (PostgresDirect or HttpGate) from the
 *      pool registry, keyed by (orgId, identifier).
 *   3. Runs the catalog lookup / param check / transport call / column
 *      projection.
 *   4. Writes an audit entry ALWAYS, in a `finally`/`catch` so it fires on
 *      every outcome (success, error, blocked) — never just the happy path.
 *
 * No network/DB calls happen in the sandbox (handlers.ts) — QuickJS never
 * touches credentials or the target database.
 *
 * `buildDatabaseBridgeMethods` takes explicit dependencies (credential
 * resolver, transport factory, catalog resolver, audit writer) so bridge.test.ts
 * can unit-test the tool logic against a mock transport with zero DB —
 * `createDatabaseBridgeExtension` is the thin production wiring that supplies
 * the real ones.
 */

import { createHash } from "node:crypto"
import { type ReadCatalog, redactDbError } from "@liaison/db-core"
import type { DatabaseDomainAccess } from "@liaison/shared"
import { rootLogger } from "~/lib/logger"
import { type SqlCallBudget, withCallBounds } from "~/modules/apps/connections/sql/call-bounds"
import {
  filterSecretColumns,
  missingLiaisonSelfScopes,
  normalizeReadParams,
  pinCallerOrg,
  resolveOrgDatabaseCatalog,
} from "~/modules/apps/connections/sql/catalog"
import {
  buildTransport,
  DatabaseConfigError,
  type DatabaseCredentials,
  resolveCredentialMode,
} from "~/modules/apps/connections/sql/credentials"
import { withSqlTransport } from "~/modules/apps/connections/sql/pool"
import type {
  DbTransport,
  ExecOptions,
  ProbeReport,
} from "~/modules/apps/connections/sql/transport"
import { DbTransportError } from "~/modules/apps/connections/sql/transport"
import { HttpGate } from "~/modules/apps/connections/sql/transports/http-gate"
import { isInstanceOperatorOrg } from "~/modules/apps/operator-org"
import { resolveToolTimeoutMs } from "~/modules/apps/run-limits"
import type {
  BridgeExtensionContext,
  BridgeExtensionMethod,
} from "~/modules/apps/sandbox/bridge-extensions"
import { hasScope } from "~/modules/permissions/permissions"
import {
  callerMayRunDomain,
  catalogHasGatedDomain,
  type DomainAccessCaller,
  resolveDomainRule,
} from "./domain-access"

const log = rootLogger.child({ module: "database-bridge" })

export const CONNECTION_IDENTIFIER = "default"

/**
 * The connections an agent can target with the optional `connection` tool
 * param (db_describe / db_query / db_probe). Absent or "default" is the org's
 * `database` connection: curated reads, gate or direct, exactly as before.
 * "warehouse" is a second, direct-only connection (its own manifest connection
 * `warehouse`, so it never overwrites the default's credentials) for raw
 * read-only SELECT over an analytics warehouse or a replica.
 */
export const DATABASE_CONNECTIONS = ["default", "warehouse"] as const
export type DatabaseConnectionKey = (typeof DATABASE_CONNECTIONS)[number]

/**
 * The sandbox budget app.manifest.json declares (`timeoutMs`) on every db_*
 * tool that reaches a database; a test pins the two together. Without it the
 * tools ran on the sandbox's 5 s production default while the warehouse's
 * statement timeout was 120 s: the tool answered "timed out, retry" after a few
 * seconds and the query ran on in the warehouse, holding a pooled connection,
 * until the database's own timeout stopped it.
 */
export const DATABASE_TOOL_TIMEOUT_MS = 60_000

/** Room left inside the budget for connecting, BEGIN, the SETs and marshalling
 *  the rows back, so the server's statement timeout fires while the tool call
 *  is still there to answer. */
const STATEMENT_HEADROOM_MS = 5_000

/** The host stops waiting (and cancels the statement) this long before the
 *  sandbox would kill the call. */
const DEADLINE_HEADROOM_MS = 2_000

/**
 * Derives one call's bounds from the budget the executor actually grants the
 * tool: `resolveToolTimeoutMs` applies the same env caps the sandbox does, so
 * a deployment that lowers LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS lowers these too.
 */
export function resolveDatabaseCallBudget(env: NodeJS.ProcessEnv = process.env): SqlCallBudget {
  const budget = resolveToolTimeoutMs(DATABASE_TOOL_TIMEOUT_MS, env) ?? DATABASE_TOOL_TIMEOUT_MS
  return {
    statementTimeoutMs: Math.max(1_000, budget - STATEMENT_HEADROOM_MS),
    deadlineMs: Math.max(1_000, budget - DEADLINE_HEADROOM_MS),
  }
}

/** Every tool call on the warehouse needs this scope, describe and probe
 *  included: the schema of a production warehouse is not a curated read. */
export const WAREHOUSE_SCOPE = "database:query:read"

export type DatabaseToolOutcome = "success" | "error" | "blocked"

// -------------------------------------------------------------------- audit

export type AuditWriter = (entry: {
  action: "database.read" | "database.query" | "database.describe" | "database.probe"
  outcome: DatabaseToolOutcome
  metadata: Record<string, unknown>
}) => Promise<void>

function sqlHash(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16)
}

export const NOT_CONNECTED_ERROR = {
  error: { code: "not_connected", message: "No database connection for this organization." },
}

/** The generic catch-all previously flattened EVERY non-transport failure —
 *  missing account, credential decrypt failure, unreachable endpoint (the
 *  staging socat proxy dropping off the app's docker network surfaced as a
 *  bare "No database connection") — into NOT_CONNECTED_ERROR with no log.
 *  Classify the cause into a safe hint (never the DSN/credentials) and log
 *  the real error so the failure is diagnosable from the deployment logs. */
function notConnectedEnvelope(err: unknown): typeof NOT_CONNECTED_ERROR {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: unknown })?.code
  const codeStr = typeof code === "string" ? code : undefined
  const unreachable =
    /ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE|timeout/i.test(
      `${codeStr ?? ""} ${message}`,
    )
  const noAccount = /No connected account/i.test(message)
  const hint = noAccount
    ? "No database connection for this organization."
    : unreachable
      ? "A database connection is configured but its endpoint is unreachable right now. This is an infrastructure fault, not a missing configuration; report it so the deployment can be checked."
      : "The configured database connection could not be used. Ask an administrator to verify the database connection in Settings."
  // Redacted: a driver error can quote the connection string it was given.
  log.error(
    {
      err: { name: err instanceof Error ? err.name : typeof err, ...redactDbError(err) },
      dbErrorCode: codeStr,
      unreachable,
      noAccount,
    },
    "database bridge: connection-level failure",
  )
  return { error: { code: "not_connected", message: hint } }
}

/** What the agent should change after a timeout, per tool. */
const TIMEOUT_GUIDANCE = {
  query:
    "Do not retry the same SQL: it will time out again. Narrow it first: filter on the hub and a bounded date range, aggregate in SQL (GROUP BY with COUNT/SUM) instead of returning raw rows, select only the columns you need, or split the question into smaller queries.",
  read: "Do not retry with the same parameters: narrow them (a single hub, a shorter date range) or use a more specific read.",
  describe:
    'Do not retry the same call: describe one table (table: "schema.table") instead of the whole database.',
  probe: "The database is slow to answer its catalog right now; retry later rather than in a loop.",
} as const

type TimeoutGuidance = keyof typeof TIMEOUT_GUIDANCE

/** SQLSTATEs for a malformed caller-supplied value: 22P02 invalid text
 *  representation, 22007 invalid datetime format, 22003 numeric out of range,
 *  22008 datetime field overflow. */
const BAD_INPUT_SQLSTATES: ReadonlySet<string> = new Set(["22P02", "22007", "22003", "22008"])

/** The failure envelope db_read / db_describe / db_probe / db_query return. A
 *  typed config error (e.g. a gate credential on the direct-only warehouse
 *  connection) is named as such rather than folded into not_connected. A
 *  timeout is final for the call as written: it is non-retryable and says how
 *  to narrow it, since the same SQL would only burn the budget again. */
function errorEnvelope(
  err: unknown,
  tool: TimeoutGuidance,
): { error: { code: string; message: string; retryable?: boolean } } {
  if (err instanceof DbTransportError && err.kind === "timeout") {
    return {
      error: {
        code: "statement_timeout",
        message: `${err.message}. ${TIMEOUT_GUIDANCE[tool]}`,
        retryable: false,
      },
    }
  }
  if (
    err instanceof DbTransportError &&
    err.kind === "execution" &&
    err.code !== undefined &&
    BAD_INPUT_SQLSTATES.has(err.code)
  ) {
    // The database refused a VALUE the caller supplied (a slug where a read
    // expects a uuid, a malformed date): a caller mistake the agent can fix,
    // not a server fault. Answered as `execution` it became an HTTP 500 and an
    // error-level log. The server's message names the value and the type and
    // carries no SQL, so it is safe to return.
    return {
      error: {
        code: "invalid_params",
        message: `A parameter has the wrong format (${err.message}). Pass the value in the type the ${tool === "read" ? "read declares (an id parameter takes the UUID, not a name or slug)" : "query compares it to"} and retry.`,
        retryable: false,
      },
    }
  }
  if (err instanceof DbTransportError) {
    // A transport-level config fault (a malformed DSN) is the same class of
    // failure as a DatabaseConfigError; its message is written to be safe.
    const code = err.kind === "config" ? "config_error" : err.kind
    return { error: { code, message: err.message } }
  }
  if (err instanceof DatabaseConfigError) return configErrorEnvelope(err)
  return notConnectedEnvelope(err)
}

/** A config error reaches the agent only when its message is marked safe; an
 *  adapter path or YAML parser output stays in the server log. */
function configErrorEnvelope(err: DatabaseConfigError): {
  error: { code: string; message: string }
} {
  if (err.agentSafe) return { error: { code: "config_error", message: err.message } }
  log.error({ err: redactDbError(err) }, "database bridge: configuration error")
  return {
    error: {
      code: "config_error",
      message:
        "The database connector is misconfigured on this deployment. Ask an administrator to check the server logs.",
    },
  }
}

// ------------------------------------------------------------ describe shape

/**
 * db_describe with no table: one line per table, never its columns. A
 * warehouse's full column map (165 tables, every column: ~121 KB) overflowed
 * the tool result and was truncated, so the agent saw neither the map nor the
 * tables at its end. The listing names each table and its width; the agent
 * then describes the table it needs. `schema` (exact) and `search` (substring
 * of "schema.table") narrow it, both case-insensitive.
 */
export function compactListing(
  tables: { table: string; columns: unknown[] }[],
  schema: unknown,
  search: unknown,
): { tables: { table: string; columnCount: number }[]; hint: string } {
  const schemaFilter =
    typeof schema === "string" && schema.trim() ? schema.trim().toLowerCase() : null
  const needle = typeof search === "string" && search.trim() ? search.trim().toLowerCase() : null
  const listed = tables.filter((t) => {
    const name = t.table.toLowerCase()
    if (schemaFilter && name.slice(0, name.indexOf(".")) !== schemaFilter) return false
    return !needle || name.includes(needle)
  })
  const hint =
    listed.length === 0 && (schemaFilter || needle)
      ? "No readable table matched the schema/search filter. Call db_describe with no argument to list every readable table."
      : 'Tables only. Call db_describe with table: "schema.table" for a table\'s columns and types before querying it.'
  return {
    tables: listed.map((t) => ({ table: t.table, columnCount: t.columns.length })),
    hint,
  }
}

// --------------------------------------------------------------- probe shape

export async function runDatabaseProbe(
  transport: DbTransport,
  catalog: ReadCatalog,
  opts?: ExecOptions,
): Promise<ProbeReport> {
  const report = await transport.probe(opts)
  if (transport instanceof HttpGate) {
    try {
      const missingReads = await transport.diffCatalog(catalog)
      report.missingReads = missingReads
      if (missingReads.length > 0) {
        report.warnings = [
          ...report.warnings,
          `Gate is missing ${missingReads.length} catalog read(s): ${missingReads.join(", ")}`,
        ]
      }
    } catch {
      // Diff failure already surfaced via report.warnings from probe() itself.
    }
  }
  return report
}

// ------------------------------------------------------- injectable builder

/** Reads the optional `connection` tool param. Unknown names are refused, never
 *  silently routed to the default connection. */
function parseConnection(raw: unknown): DatabaseConnectionKey | { error: string } {
  if (raw === undefined || raw === null || raw === "") return "default"
  if (typeof raw === "string" && (DATABASE_CONNECTIONS as readonly string[]).includes(raw)) {
    return raw as DatabaseConnectionKey
  }
  return {
    error: `Unknown connection "${String(raw)}". Valid connections: ${DATABASE_CONNECTIONS.join(", ")}.`,
  }
}

function unknownConnection(message: string): string {
  return JSON.stringify({ error: { code: "unknown_connection", message } })
}

/** Audit metadata names the connection only when it is not the default, so a
 *  default-connection audit row is byte-identical to what it was before. */
function connectionMeta(connection: DatabaseConnectionKey | { error: string }) {
  return typeof connection === "string" && connection !== "default" ? { connection } : {}
}

export interface DatabaseBridgeDeps {
  orgId: string
  resolveCredentials: (connection: DatabaseConnectionKey) => Promise<DatabaseCredentials>
  transportFactory: (creds: DatabaseCredentials) => DbTransport
  /** May be async: the demo box resolves a per-org catalog. */
  resolveCatalog: () => ReadCatalog | Promise<ReadCatalog>
  writeAudit: AuditWriter
  /** The calling actor's scopes. The tool-level scope gates db_query; the
   *  warehouse additionally gates db_describe / db_probe on WAREHOUSE_SCOPE.
   *  (The connect-event auto-probe runs with `database:*`.) */
  callerScopes: string[]
  /** The dispatch's cancellation (the caller went away). Optional: host-run
   *  paths (the connect-event probe) carry none. */
  signal?: AbortSignal
  /** Test seam; production derives it from the tool's declared budget. */
  budget?: SqlCallBudget
  /**
   * Per-domain read access (domain-access.ts): the org's stored rules, and the
   * caller (the person the call acts for, or the system), loaded only when a
   * domain of the catalog is not internal. Absent: every read is internal.
   */
  domainAccess?: {
    loadOrgRules: () => Promise<DatabaseDomainAccess>
    loadCaller: () => Promise<DomainAccessCaller>
  }
}

/** One answer per tool call: which reads of a catalog the caller may run. */
type ReadVisibility = (domain: string) => boolean

/**
 * Builds the five `db_*` bridge methods against explicit dependencies —
 * unit-testable with a mock transport/catalog/credentials/audit writer, no
 * DB required. `createDatabaseBridgeExtension` below supplies the real ones.
 */
export function buildDatabaseBridgeMethods(
  deps: DatabaseBridgeDeps,
): Record<string, BridgeExtensionMethod> {
  // Loaded once per bridge (one tool call), never per read or per row.
  let orgRulesPromise: Promise<DatabaseDomainAccess> | null = null
  let callerPromise: Promise<DomainAccessCaller> | null = null

  /**
   * Which domains the caller may run. With no org rule and no catalog tier
   * every domain is internal and nothing is looked up: today's behaviour.
   */
  async function readVisibility(catalog: ReadCatalog): Promise<ReadVisibility> {
    const access = deps.domainAccess
    if (!access) return () => true
    let orgRules: DatabaseDomainAccess
    let caller: DomainAccessCaller | null = null
    try {
      orgRulesPromise ??= access.loadOrgRules()
      orgRules = await orgRulesPromise
      if (!catalogHasGatedDomain(catalog, orgRules)) return () => true
      callerPromise ??= access.loadCaller()
      caller = await callerPromise
    } catch (err) {
      // Fails closed: a read whose access cannot be decided does not run.
      log.error({ err, orgId: deps.orgId }, "database bridge: report access lookup failed")
      throw new DatabaseConfigError(
        "Report access (the per-domain limits on curated reads) could not be checked, so no read ran. Retry; if it persists, ask an administrator to check the server logs.",
        true,
      )
    }
    const who = caller
    const decided = new Map<string, boolean>()
    return (domain) => {
      let allowed = decided.get(domain)
      if (allowed === undefined) {
        allowed = callerMayRunDomain(who, resolveDomainRule(domain, catalog, orgRules))
        decided.set(domain, allowed)
      }
      return allowed
    }
  }

  /** The warehouse answers only callers holding WAREHOUSE_SCOPE, on every
   *  tool: a member with curated reads must not list its schema. */
  function refuseWarehouse(connection: DatabaseConnectionKey): string | null {
    if (connection === "default") return null
    if (hasScope(WAREHOUSE_SCOPE, deps.callerScopes)) return null
    return JSON.stringify({
      error: {
        code: "forbidden",
        message: `The "${connection}" connection requires the ${WAREHOUSE_SCOPE} scope.`,
      },
    })
  }

  async function withTransport<T>(
    fn: (transport: DbTransport, catalog: ReadCatalog, opts: ExecOptions) => Promise<T>,
    connection: DatabaseConnectionKey = "default",
  ): Promise<T> {
    const creds = await deps.resolveCredentials(connection)
    if (connection !== "default" && resolveCredentialMode(creds) !== "direct") {
      throw new DatabaseConfigError(
        `the "${connection}" connection is direct only: set connectionString, not gateUrl/gateToken`,
        true,
      )
    }
    // Curated reads belong to the default connection; the warehouse never
    // depends on the catalog resolving.
    const catalog =
      connection === "default" ? await deps.resolveCatalog() : { adapter: connection, reads: {} }
    // The platform's pool of this connection (connections/sql/pool.ts): reused
    // while its credentials are unchanged, replaced when they change, closed
    // when the account is disconnected or idle.
    return withSqlTransport(
      {
        orgId: deps.orgId,
        appName: "database",
        connectionName: connection === "default" ? "database" : connection,
        identifier: connection === "default" ? CONNECTION_IDENTIFIER : connection,
      },
      creds,
      (transport) =>
        withCallBounds(
          {
            ...(deps.signal ? { signal: deps.signal } : {}),
            budget: deps.budget ?? resolveDatabaseCallBudget(),
          },
          (opts) => fn(transport, catalog, opts),
        ),
      deps.transportFactory,
    )
  }

  return {
    db_list_reads: async (): Promise<string> => {
      let outcome: DatabaseToolOutcome = "success"
      try {
        const catalog = await deps.resolveCatalog()
        const visible = await readVisibility(catalog)
        // A read of a domain the caller may not run is left out: the agent
        // never learns it exists.
        const reads = Object.fromEntries(
          Object.entries(catalog.reads)
            .filter(([, read]) => visible(read.domain))
            .map(([name, read]) => [
              name,
              {
                description: read.description,
                domain: read.domain,
                params: read.params,
                columns: read.columns,
              },
            ]),
        )
        return JSON.stringify({ adapter: catalog.adapter, reads })
      } catch (err) {
        outcome = "error"
        if (err instanceof DatabaseConfigError) return JSON.stringify(configErrorEnvelope(err))
        log.error({ err: redactDbError(err) }, "database bridge: list reads failed")
        return JSON.stringify({
          error: {
            code: "list_reads_failed",
            message:
              "The curated read catalog could not be loaded. Ask an administrator to check the server logs.",
          },
        })
      } finally {
        await deps.writeAudit({
          action: "database.read",
          outcome,
          metadata: { read: "__list_reads__" },
        })
      }
    },

    db_read: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson) as { name: string; params?: Record<string, unknown> }
      let outcome: DatabaseToolOutcome = "success"
      let rowCount: number | undefined
      let durationMs: number | undefined
      let truncated: boolean | undefined
      let redactedReason: string | undefined
      try {
        const result = await withTransport(async (transport, catalog, opts) => {
          const read = catalog.reads[params.name]
          const visible = await readVisibility(catalog)
          if (!read) {
            outcome = "blocked"
            redactedReason = "unknown_read"
            return {
              error: {
                code: "unknown_read",
                message: `Unknown read "${params.name}"`,
                validNames: Object.entries(catalog.reads)
                  .filter(([, r]) => visible(r.domain))
                  .map(([name]) => name),
              },
            }
          }
          if (!visible(read.domain)) {
            outcome = "blocked"
            redactedReason = "domain_restricted"
            return {
              error: {
                code: "domain_restricted",
                message: `The "${params.name}" report is restricted: its domain "${read.domain}" is limited to certain roles or people, and the person this request acts for is not one of them. Do not try to get the same figures another way. To get access, ask an organization admin to grant it in Settings > Connectors > Database > Report access.`,
                domain: read.domain,
                retryable: false,
              },
            }
          }
          const missing = missingLiaisonSelfScopes(catalog, read, deps.callerScopes)
          if (missing.length > 0) {
            outcome = "blocked"
            redactedReason = "missing_scope"
            return {
              error: {
                code: "forbidden",
                message: `The "${params.name}" read needs ${missing.join(", ")}, which you do not hold.`,
              },
            }
          }
          const { params: boundParams, invalid } = normalizeReadParams(
            read.params,
            pinCallerOrg(catalog, params.params ?? {}, deps.orgId),
          )
          if (invalid.length > 0) {
            outcome = "blocked"
            redactedReason = "invalid_params"
            return {
              error: {
                code: "invalid_params",
                message: `The "${params.name}" read needs ${invalid.map((p) => p.problem).join("; ")}. Call db_read again with params: { ${Object.entries(
                  read.params,
                )
                  .map(([name, p]) => `${name}: <${p.type}>`)
                  .join(", ")} }.`,
                params: invalid,
                retryable: false,
              },
            }
          }
          const readResult = await transport.runRead(read, params.name, boundParams, opts)
          rowCount = readResult.rows.length
          durationMs = readResult.durationMs
          truncated = readResult.truncated
          return { rows: readResult.rows, truncated: readResult.truncated }
        })
        return JSON.stringify(result)
      } catch (err) {
        outcome = "error"
        redactedReason = err instanceof DbTransportError ? err.kind : "unknown"
        return JSON.stringify(errorEnvelope(err, "read"))
      } finally {
        await deps.writeAudit({
          action: "database.read",
          outcome,
          metadata: {
            read: params.name,
            params: params.params,
            rowCount,
            durationMs,
            truncated,
            redactedReason,
          },
        })
      }
    },

    db_describe: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson) as {
        table?: string
        schema?: unknown
        search?: unknown
        connection?: unknown
      }
      const connection = parseConnection(params.connection)
      let outcome: DatabaseToolOutcome = "success"
      try {
        if (typeof connection !== "string") {
          outcome = "blocked"
          return unknownConnection(connection.error)
        }
        const refused = refuseWarehouse(connection)
        if (refused) {
          outcome = "blocked"
          return refused
        }
        const result = await withTransport(async (transport, catalog, opts) => {
          // Discovery is grounded in the role's grants (transport.describe returns
          // only readable, non-secret columns). No catalog restriction — the agent
          // must be able to see the real DB shape to form its own db_query.
          const schemaInfo = await transport.describe(catalog, params.table, opts)
          const tables = schemaInfo.tables.map((t) => ({
            table: t.table,
            columns: filterSecretColumns(t.table, t.columns),
          }))
          // A specific table that resolves to nothing readable → guide the agent to
          // what IS readable, rather than a bare empty result it can't act on.
          if (params.table && tables.length === 0) {
            outcome = "blocked"
            const all = await transport.describe(catalog, undefined, opts)
            return {
              error: {
                code: "table_not_readable",
                message: `No readable table matched "${params.table}". It may not exist, or the read-only role has no grant on it. Call db_describe with no argument to list every readable table, or db_list_reads for the curated reads.`,
                readableTables: all.tables.map((t) => t.table),
              },
            }
          }
          if (params.table) return { tables }
          return compactListing(tables, params.schema, params.search)
        }, connection)
        return JSON.stringify(result)
      } catch (err) {
        outcome = "error"
        return JSON.stringify(errorEnvelope(err, "describe"))
      } finally {
        await deps.writeAudit({
          action: "database.describe",
          outcome,
          metadata: {
            table: params.table,
            ...(typeof params.schema === "string" && params.schema
              ? { schema: params.schema }
              : {}),
            ...(typeof params.search === "string" && params.search
              ? { search: params.search }
              : {}),
            ...connectionMeta(connection),
          },
        })
      }
    },

    db_probe: async (paramsJson = "{}"): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as { connection?: unknown }
      const connection = parseConnection(params.connection)
      let outcome: DatabaseToolOutcome = "success"
      try {
        if (typeof connection !== "string") {
          outcome = "blocked"
          return unknownConnection(connection.error)
        }
        const refused = refuseWarehouse(connection)
        if (refused) {
          outcome = "blocked"
          return refused
        }
        const result = await withTransport(
          async (transport, catalog, opts) => runDatabaseProbe(transport, catalog, opts),
          connection,
        )
        if (!result.ok) outcome = "blocked"
        return JSON.stringify(result)
      } catch (err) {
        outcome = "error"
        return JSON.stringify(errorEnvelope(err, "probe"))
      } finally {
        await deps.writeAudit({
          action: "database.probe",
          outcome,
          metadata: connectionMeta(connection),
        })
      }
    },

    db_query: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson) as { sql: string; connection?: unknown }
      const connection = parseConnection(params.connection)
      let outcome: DatabaseToolOutcome = "success"
      let rowCount: number | undefined
      let durationMs: number | undefined
      let truncated: boolean | undefined
      let redactedReason: string | undefined
      try {
        // Raw read-only SQL is ENABLED BY DEFAULT for this connector: it is the
        // primary discovery/troubleshooting surface and is safe by construction —
        // the readonly DB role (SELECT-only, secret columns not granted, BYPASSRLS
        // read-only txn) plus assertReadOnlySelect below make it structurally
        // incapable of writing or reading secrets regardless of the SQL. A
        // deployment that wants to forbid it opts OUT explicitly with
        // LIAISON_DATABASE_ALLOW_RAW_QUERY="false" (default-on avoids a wiped/absent
        // env silently disabling the connector's headline capability).
        if (process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY === "false") {
          outcome = "blocked"
          redactedReason = "disabled"
          return JSON.stringify({
            error: {
              code: "disabled",
              message:
                "Raw query is disabled for this deployment (LIAISON_DATABASE_ALLOW_RAW_QUERY=false). Use the curated db_read tools instead.",
            },
          })
        }
        if (typeof connection !== "string") {
          outcome = "blocked"
          redactedReason = "unknown_connection"
          return unknownConnection(connection.error)
        }
        const refused = refuseWarehouse(connection)
        if (refused) {
          outcome = "blocked"
          redactedReason = "forbidden"
          return refused
        }
        const { assertReadOnlySelect, SqlGuardError } = await import("@liaison/db-core")
        try {
          assertReadOnlySelect(params.sql)
        } catch (err) {
          outcome = "blocked"
          redactedReason = err instanceof SqlGuardError ? err.code : "sql_guard_rejected"
          return JSON.stringify({
            error: {
              code: err instanceof SqlGuardError ? err.code : "sql_guard_rejected",
              message: err instanceof Error ? err.message : "Query rejected",
            },
          })
        }
        const result = await withTransport(async (transport, catalog, opts) => {
          // Raw SQL over the liaison-self catalog runs as a login that bypasses
          // row-level security, so it sees every org of that database. Only the
          // instance operator's org may run it.
          if (
            connection === "default" &&
            catalog.adapter === "liaison-self" &&
            !(await isInstanceOperatorOrg(deps.orgId))
          ) {
            throw new DbTransportError(
              "Raw query over this instance's own database is reserved to the instance operator's organization. Use the curated db_read tools instead.",
              "config",
            )
          }
          return transport.runQuery(params.sql, opts)
        }, connection)
        rowCount = result.rows.length
        durationMs = result.durationMs
        truncated = result.truncated
        return JSON.stringify({ rows: result.rows, truncated: result.truncated })
      } catch (err) {
        outcome = "error"
        redactedReason = err instanceof DbTransportError ? err.kind : "unknown"
        return JSON.stringify(errorEnvelope(err, "query"))
      } finally {
        await deps.writeAudit({
          action: "database.query",
          outcome,
          metadata: {
            ...connectionMeta(connection),
            sqlHash: sqlHash(params.sql),
            rowCount,
            durationMs,
            truncated,
            redactedReason,
          },
        })
      }
    },
  }
}

export function createDatabaseBridgeExtension(
  ctx: BridgeExtensionContext,
): Record<string, BridgeExtensionMethod> {
  return buildDatabaseBridgeMethods({
    orgId: ctx.orgId,
    callerScopes: ctx.callerScopes ?? [],
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    resolveCredentials: async (connection) => {
      const { getCredentialsForConnection } = await import("~/modules/apps/connections/service")
      if (connection !== "default") {
        // Its own manifest connection, resolved ONLY as the org-owned account
        // with the fixed identifier (= the connection name). A member can save
        // a personal connection of the same name; it must never stand in for
        // the org's, since the transport is pooled org-wide. Never the
        // demo-warehouse path.
        const raw = await getCredentialsForConnection(
          ctx.txDb,
          ctx.orgId,
          ctx.userId,
          "database",
          connection,
          connection,
          { actorType: ctx.actorType === "user" ? "user" : "system", ownerType: "org" },
        )
        return {
          connectionString: raw.connectionString as string | undefined,
          dialect: raw.dialect as string | undefined,
          statementTimeoutMs: raw.statementTimeoutMs as string | undefined,
        }
      }
      const raw = await getCredentialsForConnection(
        ctx.txDb,
        ctx.orgId,
        ctx.userId,
        "database",
        "database",
        CONNECTION_IDENTIFIER,
        // Org-owned only, like the warehouse: the pooled transport is shared
        // by the whole org.
        { actorType: ctx.actorType === "user" ? "user" : "system", ownerType: "org" },
      )
      const stored = {
        connectionString: raw.connectionString as string | undefined,
        gateUrl: raw.gateUrl as string | undefined,
        gateToken: raw.gateToken as string | undefined,
      }
      // The public demo box: a demo org's stored "DSN" is a sentinel, and the
      // handle it resolves to is the warehouse's own dedicated login (its own
      // DSN in the deployment's environment, never the application's). Null
      // for every org on every other deployment, at the cost of one boolean
      // read (see modules/demo/warehouse/resolve.ts).
      const { resolveDemoWarehouseHandle } = await import("~/modules/demo/warehouse/resolve")
      const demo = await resolveDemoWarehouseHandle(ctx.orgId, stored)
      return demo
        ? { connectionString: demo.connectionString, sharedPool: demo.sharedPool }
        : stored
    },
    transportFactory: buildTransport,
    // The caller is ctx.userId: the person the call acts for (the human behind
    // an agent turn, also when another agent asked it inline), judged on their
    // own roles and grants; a job's "system:..." id is the system.
    domainAccess: {
      loadOrgRules: async () => {
        const { loadOrgDomainAccess } = await import("./domain-access-store")
        return loadOrgDomainAccess(ctx.orgId)
      },
      loadCaller: async () => {
        const { loadDomainAccessCaller } = await import("./domain-access-store")
        return loadDomainAccessCaller(ctx.orgId, ctx.userId, ctx.callerScopes ?? [])
      },
    },
    // db_list_reads resolves the catalog WITHOUT resolving credentials, so the
    // demo check lives here too rather than riding on the credential path.
    resolveCatalog: () => resolveOrgDatabaseCatalog(ctx.orgId),
    writeAudit: async (entry) => {
      try {
        const { writeAuditLog } = await import("~/modules/audit/service")
        await writeAuditLog(ctx.txDb, {
          orgId: ctx.orgId,
          actorId: ctx.userId,
          actorType: ctx.actorType,
          app: "database",
          action: entry.action,
          metadata: { ...entry.metadata, outcome: entry.outcome },
        })
      } catch {
        // Audit is best-effort at the writeAuditLog layer already (it
        // swallows its own DB errors); this catch guards against a totally
        // unexpected throw so a bridge call NEVER fails because audit did.
      }
    },
  })
}
