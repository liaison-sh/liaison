// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Platform-held SQL connections: what `ctx.sql.*` runs on the host.
//
// An app declares a SQL connection in its manifest: a credentials connection
// with an `sql` block. Its stored credentials are a direct DSN
// (`connectionString`, plus optional `dialect` and `statementTimeoutMs`) or a
// db-gate (`gateUrl` + `gateToken`). App code names the connection and asks
// for a named read of the connection's catalog, or (when the manifest allows
// it) a read-only SELECT; the host:
//   - resolves the org-owned account's credentials (never handed to the run),
//   - runs the statement on the pool the platform holds for that connection
//     (pool.ts), in a READ ONLY transaction, under a statement timeout set on
//     the database and a deadline that cancels it there (call-bounds.ts),
//   - caps the rows (run-limits.ts `sqlCallLimits`) and answers rows only,
//   - writes an audit line for every call, whatever its outcome.
// Every failure is an `{ error: { code, message } }` answer: messages never
// carry a DSN, a token or the SQL of a curated read.
//
// The safety of a read never depends on app code: the catalog is deployment
// data (catalog.ts), `liaison-self` reads are pinned to the caller's org and
// held to their tables' scopes, raw SQL passes the read-only guard and, over
// this instance's own database, is the instance operator's alone.

import { createHash } from "node:crypto"
import {
  assertReadOnlySelect,
  type ReadCatalog,
  redactDbError,
  SqlGuardError,
} from "@liaison/db-core"
import { z } from "zod"
import { rootLogger } from "~/lib/logger"
import { ConnectionCredentialsMissingError } from "~/modules/apps/connections/credentials-missing"
import { NoConnectedAccountError } from "~/modules/apps/connections/no-connected-account"
import { isInstanceOperatorOrg } from "~/modules/apps/operator-org"
import { sqlCallLimits } from "~/modules/apps/run-limits"
import { hasScope } from "~/modules/permissions/permissions"
import { withCallBounds } from "./call-bounds"
import {
  filterSecretColumns,
  missingLiaisonSelfScopes,
  normalizeReadParams,
  pinCallerOrg,
  resolveOrgDatabaseCatalog,
} from "./catalog"
import {
  buildTransport,
  DatabaseConfigError,
  type DatabaseCredentials,
  resolveCredentialMode,
} from "./credentials"
import { closeSqlPools, withSqlTransport } from "./pool"
import { type DbTransport, DbTransportError, type ExecOptions } from "./transport"
import { HttpGate } from "./transports/http-gate"

const log = rootLogger.child({ module: "sql-connections" })

/** The manifest's `connections.<name>.sql` block. */
export interface SqlConnectionDeclaration {
  /** Where named reads come from: `instance` is the deployment's read catalog. */
  catalog?: "instance"
  /** Read-only SELECTs of the app's own; the caller must hold `scope`. */
  rawQuery?: { scope: string }
  /** The credential modes the connection accepts (default both). */
  modes?: Array<"direct" | "gate">
}

export type SqlAuditAction = "sql.query" | "sql.schema" | "sql.probe" | "sql.reads"
export type SqlOutcome = "success" | "error" | "blocked"

export interface SqlCallContext {
  orgId: string
  appName: string
  /** The scopes of whoever the run acts for. */
  callerScopes: string[]
  /** The calling app's manifest declaration of a connection, if any. */
  declarationOf: (
    connection: string,
  ) => { type?: string; sql?: SqlConnectionDeclaration } | undefined
  /** The stored credentials of the org-owned account (host only). */
  resolveCredentials: (connection: string, identifier?: string) => Promise<Record<string, unknown>>
  writeAudit: (entry: {
    action: SqlAuditAction
    outcome: SqlOutcome
    metadata: Record<string, unknown>
  }) => Promise<void>
  /** The dispatch's cancellation: the statement is cancelled when it fires. */
  signal?: AbortSignal
  /** Test seam: the transport a pool builds. */
  transportFactory?: (creds: DatabaseCredentials) => DbTransport
}

export interface SqlErrorAnswer {
  error: { code: string; message: string; retryable?: boolean; [k: string]: unknown }
}

export interface SqlRowsAnswer {
  rows: Record<string, unknown>[]
  truncated: boolean
  durationMs: number
}

const identifierSchema = z.string().min(1).max(200).optional()
const timeoutSchema = z.number().int().positive().optional()

export const sqlQueryRequestSchema = z
  .object({
    identifier: identifierSchema,
    read: z.string().min(1).max(200).optional(),
    sql: z.string().min(1).max(100_000).optional(),
    params: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()).max(100)]).optional(),
    timeoutMs: timeoutSchema,
    maxRows: z.number().int().positive().optional(),
  })
  .strict()
  .refine((r) => (r.read === undefined) !== (r.sql === undefined), {
    message: "give exactly one of `read` (a named read) or `sql` (a read-only SELECT)",
  })

export type SqlQueryRequest = z.infer<typeof sqlQueryRequestSchema>

export const sqlSchemaRequestSchema = z
  .object({
    identifier: identifierSchema,
    table: z.string().min(1).max(200).optional(),
    timeoutMs: timeoutSchema,
  })
  .strict()

export const sqlProbeRequestSchema = z
  .object({ identifier: identifierSchema, timeoutMs: timeoutSchema })
  .strict()

function fail(code: string, message: string, extra: Record<string, unknown> = {}): SqlErrorAnswer {
  return { error: { code, message, ...extra } }
}

class SqlRefusal extends Error {
  constructor(readonly answer: SqlErrorAnswer) {
    super(answer.error.message)
  }
}

function refuse(code: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new SqlRefusal(fail(code, message, extra))
}

function parseRequest<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw ?? {})
  if (!parsed.success) {
    refuse(
      "invalid_request",
      parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "),
    )
  }
  return parsed.data
}

function declarationOf(ctx: SqlCallContext, connection: string): SqlConnectionDeclaration {
  if (typeof connection !== "string" || connection === "")
    refuse("invalid_request", "name the connection")
  const declared = ctx.declarationOf(connection)
  if (!declared) {
    refuse("unknown_connection", `Connection "${connection}" is not declared in the app manifest`)
  }
  if (!declared.sql) {
    refuse(
      "not_sql_connection",
      `Connection "${connection}" is not a SQL connection (no \`sql\` block in the manifest)`,
    )
  }
  return declared.sql
}

/** The scope a raw query on the connection needs, or null when it takes named reads only. */
function rawQueryScopeOf(declaration: SqlConnectionDeclaration): string | null {
  return declaration.rawQuery?.scope ?? null
}

/** The call's statement timeout and deadline, from the limit table. */
function budgetOf(timeoutMs: number | undefined) {
  const limits = sqlCallLimits()
  const statementTimeoutMs = Math.min(
    Math.max(timeoutMs ?? limits.defaultTimeoutMs, 1_000),
    limits.maxTimeoutMs,
  )
  return { statementTimeoutMs, deadlineMs: statementTimeoutMs + 1_000 }
}

function maxRowsOf(requested: number | undefined, declared?: number): number {
  const limits = sqlCallLimits()
  return Math.min(requested ?? declared ?? limits.defaultMaxRows, limits.maxRows)
}

async function catalogOf(
  ctx: SqlCallContext,
  declaration: SqlConnectionDeclaration,
): Promise<ReadCatalog | null> {
  return declaration.catalog === "instance" ? resolveOrgDatabaseCatalog(ctx.orgId) : null
}

async function credentialsOf(
  ctx: SqlCallContext,
  connection: string,
  declaration: SqlConnectionDeclaration,
  identifier: string | undefined,
): Promise<DatabaseCredentials> {
  let raw: Record<string, unknown>
  try {
    raw = await ctx.resolveCredentials(connection, identifier)
  } catch (err) {
    if (
      err instanceof NoConnectedAccountError ||
      err instanceof ConnectionCredentialsMissingError
    ) {
      // The account is gone or empty: whatever pool this process still holds
      // for the connection serves nobody.
      closeSqlPools({ orgId: ctx.orgId, appName: ctx.appName, connectionName: connection })
      refuse("not_connected", `No ${connection} connection for this organization.`)
    }
    throw err
  }
  const text = (key: string) =>
    typeof raw[key] === "string" && raw[key] !== "" ? (raw[key] as string) : undefined
  const stored: DatabaseCredentials = {
    connectionString: text("connectionString"),
    gateUrl: text("gateUrl"),
    gateToken: text("gateToken"),
    dialect: text("dialect"),
    statementTimeoutMs: text("statementTimeoutMs"),
  }
  for (const key of Object.keys(stored) as Array<keyof DatabaseCredentials>) {
    if (stored[key] === undefined) delete stored[key]
  }
  const mode = resolveCredentialMode(stored)
  if (declaration.modes && !declaration.modes.includes(mode)) {
    throw new DatabaseConfigError(
      `the "${connection}" connection takes ${declaration.modes.join(" or ")} mode only`,
      true,
    )
  }
  if (declaration.catalog === "instance") {
    // On the public demo box a demo org's stored DSN is a sentinel that
    // resolves to the demo warehouse's own login (null everywhere else).
    const { resolveDemoWarehouseHandle } = await import("~/modules/demo/warehouse/resolve")
    const demo = await resolveDemoWarehouseHandle(ctx.orgId, {
      connectionString: stored.connectionString,
      gateUrl: stored.gateUrl,
      gateToken: stored.gateToken,
    })
    if (demo) return { connectionString: demo.connectionString, sharedPool: demo.sharedPool }
  }
  return stored
}

async function onPool<T>(
  ctx: SqlCallContext,
  connection: string,
  identifier: string | undefined,
  creds: DatabaseCredentials,
  timeoutMs: number | undefined,
  fn: (transport: DbTransport, opts: ExecOptions) => Promise<T>,
): Promise<T> {
  return withSqlTransport(
    {
      orgId: ctx.orgId,
      appName: ctx.appName,
      connectionName: connection,
      identifier: identifier ?? "",
    },
    creds,
    (transport) =>
      withCallBounds(
        { ...(ctx.signal ? { signal: ctx.signal } : {}), budget: budgetOf(timeoutMs) },
        (opts) => fn(transport, opts),
      ),
    ctx.transportFactory ?? buildTransport,
  )
}

/** The answer of a failure the call itself did not decide. */
function failureAnswer(err: unknown): SqlErrorAnswer {
  if (err instanceof SqlRefusal) return err.answer
  if (err instanceof DbTransportError) {
    if (err.kind === "timeout") return fail("statement_timeout", err.message, { retryable: false })
    const code = err.kind === "config" ? "config_error" : err.kind
    // Transport messages are written to be safe: never the DSN or token.
    return fail(code, err.message, err.code ? { sqlstate: err.code } : {})
  }
  if (err instanceof DatabaseConfigError) {
    if (err.agentSafe) return fail("config_error", err.message)
    log.error({ err: redactDbError(err) }, "sql connection: configuration error")
    return fail(
      "config_error",
      "The connection is misconfigured on this deployment; an administrator can check the server logs.",
    )
  }
  // A driver error can quote the connection string it was given: logged
  // redacted, answered generically.
  log.error({ err: redactDbError(err) }, "sql connection: call failed")
  return fail(
    "connection_failed",
    "The connection could not be used right now; an administrator can check the server logs.",
  )
}

async function audited<T extends object>(
  ctx: SqlCallContext,
  action: SqlAuditAction,
  metadata: Record<string, unknown>,
  fn: (meta: Record<string, unknown>) => Promise<T>,
): Promise<T | SqlErrorAnswer> {
  let outcome: SqlOutcome = "success"
  try {
    const answer = await fn(metadata)
    return answer
  } catch (err) {
    outcome = err instanceof SqlRefusal ? "blocked" : "error"
    const answer = failureAnswer(err)
    metadata.reason = answer.error.code
    return answer
  } finally {
    try {
      await ctx.writeAudit({ action, outcome, metadata })
    } catch {
      // Audit never fails a call (writeAuditLog swallows its own errors).
    }
  }
}

function capRows(rows: Record<string, unknown>[], max: number) {
  return rows.length > max
    ? { rows: rows.slice(0, max), truncated: true }
    : { rows, truncated: false }
}

/** `ctx.sql.query(connection, { read, params } | { sql, params })`. */
export async function sqlQuery(
  ctx: SqlCallContext,
  connection: string,
  rawRequest: unknown,
): Promise<SqlRowsAnswer | SqlErrorAnswer> {
  return audited(ctx, "sql.query", { connection }, async (meta) => {
    const declaration = declarationOf(ctx, connection)
    const req = parseRequest(sqlQueryRequestSchema, rawRequest)
    if (req.identifier) meta.identifier = req.identifier
    if (req.read !== undefined) {
      meta.read = req.read
      const catalog = await catalogOf(ctx, declaration)
      if (!catalog)
        refuse("no_catalog", `Connection "${connection}" has no read catalog: send \`sql\``)
      const read = catalog.reads[req.read]
      if (!read)
        refuse("unknown_read", `Unknown read "${req.read}"`, {
          validNames: Object.keys(catalog.reads),
        })
      const missing = missingLiaisonSelfScopes(catalog, read, ctx.callerScopes)
      if (missing.length > 0)
        refuse("forbidden", `The "${req.read}" read needs ${missing.join(", ")}`)
      if (Array.isArray(req.params))
        refuse("invalid_params", "a named read takes its params as an object")
      const { params, invalid } = normalizeReadParams(
        read.params,
        pinCallerOrg(catalog, req.params ?? {}, ctx.orgId),
      )
      if (invalid.length > 0) {
        refuse(
          "invalid_params",
          `The "${req.read}" read needs ${invalid.map((p) => p.problem).join("; ")}`,
          {
            params: invalid,
          },
        )
      }
      const maxRows = maxRowsOf(req.maxRows, read.maxRows)
      const creds = await credentialsOf(ctx, connection, declaration, req.identifier)
      const result = await onPool(
        ctx,
        connection,
        req.identifier,
        creds,
        req.timeoutMs,
        (t, opts) => t.runRead({ ...read, maxRows }, req.read as string, params, opts),
      )
      const capped = capRows(result.rows, maxRows)
      meta.rowCount = capped.rows.length
      meta.durationMs = result.durationMs
      return {
        rows: capped.rows,
        truncated: result.truncated || capped.truncated,
        durationMs: result.durationMs,
      }
    }
    const sql = req.sql as string
    meta.sqlHash = createHash("sha256").update(sql).digest("hex").slice(0, 16)
    const rawScope = rawQueryScopeOf(declaration)
    if (rawScope === null) {
      refuse("raw_query_not_allowed", `Connection "${connection}" takes named reads only`)
    }
    if (!hasScope(rawScope, ctx.callerScopes)) {
      refuse("forbidden", `A query on "${connection}" needs the ${rawScope} scope`)
    }
    if (process.env.LIAISON_DATABASE_ALLOW_RAW_QUERY === "false") {
      refuse(
        "disabled",
        "Raw queries are disabled on this deployment (LIAISON_DATABASE_ALLOW_RAW_QUERY=false)",
      )
    }
    if (req.params !== undefined && !Array.isArray(req.params)) {
      refuse("invalid_params", "a query takes its params as an array ($1, $2, ...)")
    }
    try {
      assertReadOnlySelect(sql)
    } catch (err) {
      refuse(
        err instanceof SqlGuardError ? err.code : "sql_guard_rejected",
        err instanceof Error ? err.message : "Query rejected",
      )
    }
    const catalog = await catalogOf(ctx, declaration)
    if (catalog?.adapter === "liaison-self" && !(await isInstanceOperatorOrg(ctx.orgId))) {
      // The liaison-self login bypasses row-level security: raw SQL over it sees
      // every org of the instance.
      refuse(
        "forbidden",
        "A query over this instance's own database is reserved to the instance operator's organization; use its named reads",
      )
    }
    const maxRows = maxRowsOf(req.maxRows)
    const values = (req.params as unknown[] | undefined) ?? []
    const creds = await credentialsOf(ctx, connection, declaration, req.identifier)
    const result = await onPool(ctx, connection, req.identifier, creds, req.timeoutMs, (t, opts) =>
      t.runQuery(sql, { ...opts, maxRows }, values),
    )
    const capped = capRows(result.rows, maxRows)
    meta.rowCount = capped.rows.length
    meta.durationMs = result.durationMs
    return {
      rows: capped.rows,
      truncated: result.truncated || capped.truncated,
      durationMs: result.durationMs,
    }
  })
}

/** `ctx.sql.reads(connection)`: the connection's named reads (no credentials needed). */
export async function sqlReads(
  ctx: SqlCallContext,
  connection: string,
): Promise<{ adapter: string; reads: Record<string, unknown> } | SqlErrorAnswer> {
  return audited(ctx, "sql.reads", { connection }, async () => {
    const declaration = declarationOf(ctx, connection)
    const catalog = await catalogOf(ctx, declaration)
    if (!catalog) return { adapter: "none", reads: {} }
    const reads = Object.fromEntries(
      Object.entries(catalog.reads).map(([name, read]) => [
        name,
        {
          description: read.description,
          domain: read.domain,
          params: read.params,
          columns: read.columns,
          tables: read.tables,
          // Whether this caller holds what the read needs.
          allowed: missingLiaisonSelfScopes(catalog, read, ctx.callerScopes).length === 0,
        },
      ]),
    )
    return { adapter: catalog.adapter, reads }
  })
}

/** `ctx.sql.schema(connection, { table? })`: readable tables and columns, secret columns removed. */
export async function sqlSchema(
  ctx: SqlCallContext,
  connection: string,
  rawRequest: unknown,
): Promise<
  | { tables: Array<{ table: string; columns: Array<{ column: string; dataType: string }> }> }
  | SqlErrorAnswer
> {
  return audited(ctx, "sql.schema", { connection }, async (meta) => {
    const declaration = declarationOf(ctx, connection)
    const req = parseRequest(sqlSchemaRequestSchema, rawRequest)
    if (req.table) meta.table = req.table
    // The schema of a database is what a raw query needs, so it takes the
    // same scope; a connection of named reads only describes its catalog.
    const rawScope = rawQueryScopeOf(declaration)
    if (rawScope !== null && !hasScope(rawScope, ctx.callerScopes)) {
      refuse("forbidden", `The schema of "${connection}" needs the ${rawScope} scope`)
    }
    const catalog = (await catalogOf(ctx, declaration)) ?? { adapter: connection, reads: {} }
    const creds = await credentialsOf(ctx, connection, declaration, req.identifier)
    const info = await onPool(ctx, connection, req.identifier, creds, req.timeoutMs, (t, opts) =>
      t.describe(catalog, req.table, opts),
    )
    return {
      tables: info.tables.map((t) => ({
        table: t.table,
        columns: filterSecretColumns(t.table, t.columns),
      })),
    }
  })
}

/** `ctx.sql.probe(connection)`: the connection's safety report (read-only role, missing reads). */
export async function sqlProbe(
  ctx: SqlCallContext,
  connection: string,
  rawRequest: unknown,
): Promise<object | SqlErrorAnswer> {
  return audited(ctx, "sql.probe", { connection }, async () => {
    const declaration = declarationOf(ctx, connection)
    const req = parseRequest(sqlProbeRequestSchema, rawRequest)
    const catalog = await catalogOf(ctx, declaration)
    const creds = await credentialsOf(ctx, connection, declaration, req.identifier)
    return onPool(ctx, connection, req.identifier, creds, req.timeoutMs, async (t, opts) => {
      const report = await t.probe(opts)
      if (catalog && t instanceof HttpGate) {
        try {
          const missingReads = await t.diffCatalog(catalog)
          report.missingReads = missingReads
          if (missingReads.length > 0) {
            report.warnings = [
              ...report.warnings,
              `Gate is missing ${missingReads.length} catalog read(s): ${missingReads.join(", ")}`,
            ]
          }
        } catch {
          // The probe already reported the gate's failure in its warnings.
        }
      }
      return report
    })
  })
}
