// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The db_* agent tools over platform-held SQL connections (`ctx.sql`). The host
// holds the credentials and the pool, runs every statement read-only under a
// statement timeout, caps the rows, pins `liaison-self` reads to the caller's
// org, keeps raw SQL over this instance's own database to the operator's org,
// and audits every call. What stays here: which connection a call targets, the
// warehouse's scope on every tool, Report access (access.ts), the compact
// table listing, and answers an agent can act on (what to change after a
// timeout or a malformed value).

import type { AppContext, SqlError, SqlReadInfo } from "@liaison/app-sdk"
import { domainVisibility, QUERY_SCOPE, type Tier } from "./access"

export const MAIN = "database"
export const WAREHOUSE = "warehouse"
export const CONNECTIONS = ["default", WAREHOUSE] as const
type ConnectionKey = (typeof CONNECTIONS)[number]

/** The tools' declared budget is 60 s (manifest `timeoutMs`); the statement
 *  stops on the database 5 s before it, so the tool is still there to answer. */
export const STATEMENT_TIMEOUT_MS = 55_000
/** Rows a raw query or a curated read returns at most. */
export const MAX_ROWS = 2_000

/** `callerHasScope` is the bridge's check of the caller's own app scopes (not yet in the SDK type). */
export type Ctx = Pick<AppContext, "sql" | "store" | "kernel" | "logger"> & {
  callerHasScope(scope: string): boolean | Promise<boolean>
}
type Answer = Record<string, unknown>

export function isSqlError(value: unknown): value is SqlError {
  return (
    !!value &&
    typeof value === "object" &&
    "error" in value &&
    typeof (value as SqlError).error?.code === "string"
  )
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): Answer {
  return { error: { code, message, ...extra } }
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

/** SQLSTATEs of a malformed value the caller supplied. */
const BAD_INPUT_SQLSTATES = new Set(["22P02", "22007", "22003", "22008"])

/** A platform failure, with what the agent can do about it. */
export function explain(answer: SqlError, tool: keyof typeof TIMEOUT_GUIDANCE): Answer {
  const { code, message } = answer.error
  if (code === "statement_timeout") {
    return fail("statement_timeout", `${message}. ${TIMEOUT_GUIDANCE[tool]}`, { retryable: false })
  }
  const sqlstate = answer.error.sqlstate
  if (code === "execution" && typeof sqlstate === "string" && BAD_INPUT_SQLSTATES.has(sqlstate)) {
    return fail(
      "invalid_params",
      `A parameter has the wrong format (${message}). Pass the value in the type the ${
        tool === "read"
          ? "read declares (an id parameter takes the UUID, not a name or slug)"
          : "query compares it to"
      } and retry.`,
      { retryable: false },
    )
  }
  return { error: answer.error }
}

/** The optional `connection` param: absent or "default" is the org's database. */
export function parseConnection(raw: unknown): ConnectionKey | Answer {
  if (raw === undefined || raw === null || raw === "") return "default"
  if (typeof raw === "string" && (CONNECTIONS as readonly string[]).includes(raw)) {
    return raw as ConnectionKey
  }
  return fail(
    "unknown_connection",
    `Unknown connection "${String(raw)}". Valid connections: ${CONNECTIONS.join(", ")}.`,
  )
}

/** The warehouse answers only callers holding database:query:read, on every tool. */
async function refuseWarehouse(ctx: Ctx, connection: ConnectionKey): Promise<Answer | null> {
  if (connection === "default") return null
  if (await ctx.callerHasScope(QUERY_SCOPE)) return null
  return fail("forbidden", `The "${connection}" connection requires the ${QUERY_SCOPE} scope.`)
}

const manifestConnection = (c: ConnectionKey) => (c === "default" ? MAIN : WAREHOUSE)

/** The catalog's reads and domain tiers, or the failure to answer. */
async function catalogOf(ctx: Ctx): Promise<
  | { ok: false; error: SqlError }
  | {
      ok: true
      reads: Record<string, SqlReadInfo>
      tiers: Record<string, { tier: Tier }>
      adapter: string
    }
> {
  const answer = await ctx.sql.reads(MAIN)
  if (isSqlError(answer)) return { ok: false, error: answer }
  return { ok: true, reads: answer.reads, tiers: answer.domains, adapter: answer.adapter }
}

export async function dbListReads(_params: unknown, ctx: Ctx): Promise<Answer> {
  const catalog = await catalogOf(ctx)
  if (!catalog.ok) return { error: catalog.error.error }
  const visible = await domainVisibility(
    ctx,
    Object.values(catalog.reads).map((r) => r.domain ?? ""),
    catalog.tiers,
  )
  // A read of a domain the caller may not run is left out: the agent never
  // learns it exists.
  const reads = Object.fromEntries(
    Object.entries(catalog.reads)
      .filter(([, read]) => visible(read.domain ?? ""))
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
  // `rows`: one per read (`name` and its declaration), the list a dashboard block charts.
  const rows = Object.entries(reads).map(([name, read]) => ({ name, ...read }))
  return { adapter: catalog.adapter, reads, rows }
}

export async function dbRead(
  params: { name?: unknown; params?: unknown },
  ctx: Ctx,
): Promise<Answer> {
  const name = typeof params?.name === "string" ? params.name : ""
  const catalog = await catalogOf(ctx)
  if (!catalog.ok) return explain(catalog.error, "read")
  const visible = await domainVisibility(
    ctx,
    Object.values(catalog.reads).map((r) => r.domain ?? ""),
    catalog.tiers,
  )
  const read = Object.hasOwn(catalog.reads, name) ? catalog.reads[name] : undefined
  if (!read) {
    return fail("unknown_read", `Unknown read "${name}"`, {
      validNames: Object.entries(catalog.reads)
        .filter(([, r]) => visible(r.domain ?? ""))
        .map(([n]) => n),
    })
  }
  if (!visible(read.domain ?? "")) {
    return fail(
      "domain_restricted",
      `The "${name}" report is restricted: its domain "${read.domain}" is limited to certain roles or people, and the person this request acts for is not one of them. Do not try to get the same figures another way. To get access, ask an organization admin to grant it in Settings > Connectors > Database > Report access.`,
      { domain: read.domain, retryable: false },
    )
  }
  const given =
    params?.params && typeof params.params === "object" && !Array.isArray(params.params)
      ? (params.params as Record<string, unknown>)
      : {}
  const answer = await ctx.sql.query(MAIN, {
    read: name,
    params: given,
    timeoutMs: STATEMENT_TIMEOUT_MS,
    maxRows: MAX_ROWS,
  })
  if (isSqlError(answer)) {
    if (answer.error.code === "invalid_params") {
      return fail(
        "invalid_params",
        `${answer.error.message}. Call db_read again with params: { ${Object.entries(read.params)
          .map(([p, d]) => `${p}: <${d.type}>`)
          .join(", ")} }.`,
        { ...(answer.error.params ? { params: answer.error.params } : {}), retryable: false },
      )
    }
    return explain(answer, "read")
  }
  return { rows: answer.rows, truncated: answer.truncated }
}

/**
 * db_describe with no table: one line per table, never its columns (a large
 * warehouse's full column map overflowed the tool result). `schema` (exact)
 * and `search` (a substring of "schema.table") narrow it, case-insensitive.
 */
export function compactListing(
  tables: Array<{ table: string; columns: unknown[] }>,
  schema: unknown,
  search: unknown,
): { tables: Array<{ table: string; columnCount: number }>; hint: string } {
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

export async function dbDescribe(
  params: { table?: unknown; schema?: unknown; search?: unknown; connection?: unknown },
  ctx: Ctx,
): Promise<Answer> {
  const connection = parseConnection(params?.connection)
  if (typeof connection !== "string") return connection
  const refused = await refuseWarehouse(ctx, connection)
  if (refused) return refused
  const table = typeof params?.table === "string" && params.table ? params.table : undefined
  const answer = await ctx.sql.schema(manifestConnection(connection), {
    ...(table ? { table } : {}),
    timeoutMs: STATEMENT_TIMEOUT_MS,
  })
  if (isSqlError(answer)) return explain(answer, "describe")
  if (table && answer.tables.length === 0) {
    // Guide the agent to what IS readable rather than a bare empty result.
    const all = await ctx.sql.schema(manifestConnection(connection), {
      timeoutMs: STATEMENT_TIMEOUT_MS,
    })
    return fail(
      "table_not_readable",
      `No readable table matched "${table}". It may not exist, or the read-only role has no grant on it. Call db_describe with no argument to list every readable table, or db_list_reads for the curated reads.`,
      { readableTables: isSqlError(all) ? [] : all.tables.map((t) => t.table) },
    )
  }
  if (table) return { tables: answer.tables }
  return compactListing(answer.tables, params?.schema, params?.search)
}

export async function dbProbe(params: { connection?: unknown } | undefined, ctx: Ctx) {
  const connection = parseConnection(params?.connection)
  if (typeof connection !== "string") return connection
  const refused = await refuseWarehouse(ctx, connection)
  if (refused) return refused
  const answer = await ctx.sql.probe(manifestConnection(connection), {
    timeoutMs: STATEMENT_TIMEOUT_MS,
  })
  if (isSqlError(answer)) return explain(answer, "probe")
  return { ...answer, rows: probeRows(answer) }
}

/** The probe's checks as rows (`key` = the report's field, `value` = its answer, a count for a
 *  list), the list a dashboard block charts. */
function probeRows(report: {
  ok: boolean
  writeGrantsDetected?: boolean
  missingReads?: string[]
  warnings: string[]
}): Array<{ key: string; value: boolean | number }> {
  const dangerous = (report as { dangerousExecuteGrantsDetected?: boolean }).dangerousExecuteGrantsDetected
  return [
    { key: "ok", value: report.ok },
    { key: "writeGrantsDetected", value: report.writeGrantsDetected === true },
    { key: "dangerousExecuteGrantsDetected", value: dangerous === true },
    { key: "missingReads", value: report.missingReads?.length ?? 0 },
    { key: "warnings", value: report.warnings.length },
  ]
}

export async function dbQuery(params: { sql?: unknown; connection?: unknown }, ctx: Ctx) {
  const connection = parseConnection(params?.connection)
  if (typeof connection !== "string") return connection
  const refused = await refuseWarehouse(ctx, connection)
  if (refused) return refused
  if (typeof params?.sql !== "string" || params.sql.trim() === "") {
    return fail("invalid_params", "sql is a single SELECT (or WITH ... SELECT) statement")
  }
  const answer = await ctx.sql.query(manifestConnection(connection), {
    sql: params.sql,
    timeoutMs: STATEMENT_TIMEOUT_MS,
    maxRows: MAX_ROWS,
  })
  if (isSqlError(answer)) return explain(answer, "query")
  return { rows: answer.rows, truncated: answer.truncated }
}

interface ConnectedEvent {
  data?: { appName?: string; connectionName?: string }
}

/**
 * The connect-time safety probe runs once a database credential is saved and
 * logs what it finds; advisory, so it never throws out of the subscriber.
 */
export async function onDatabaseConnected(event: ConnectedEvent, ctx: Ctx): Promise<void> {
  if (event?.data?.appName !== "database") return
  const connection = event.data.connectionName === WAREHOUSE ? WAREHOUSE : MAIN
  try {
    const result = await ctx.sql.probe(connection, { timeoutMs: STATEMENT_TIMEOUT_MS })
    if (isSqlError(result)) {
      ctx.logger.warn("database: auto-probe returned an error", { error: result.error })
      return
    }
    if (!result.ok) {
      ctx.logger.warn("database: auto-probe at connect reported issues", {
        warnings: result.warnings,
        missingReads: result.missingReads,
      })
    } else {
      ctx.logger.info("database: auto-probe at connect is clean", {})
    }
  } catch (err) {
    ctx.logger.warn("database: auto-probe at connect threw", {
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}
