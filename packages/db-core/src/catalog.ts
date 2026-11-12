// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ReadCatalog — the transport-agnostic, per-deployment unit: a set of named,
// parameterized SELECT reads (SQL template + JSON-Schema params + a column
// allow-list), grouped under an adapter name. Shared by the platform's SQL
// connections (`apps/api/src/modules/apps/connections/sql`) and the
// `apps/db-gate` sidecar so both consume exactly one implementation of
// catalog shape + validation.
//
// The column allow-list on each read is a projection layer — defense in
// depth on top of (never instead of) the DB grant layer (see
// `secret-columns.ts`'s doc comment and Task 7's readonly-role provisioning).

import { z } from "zod"
import { isSecretColumn } from "./secret-columns"

export const READ_DOMAINS = ["licenses", "moderation", "health"] as const
export type ReadDomain = (typeof READ_DOMAINS)[number] | string

/** JSON-Schema-shaped params declaration for a single named param. */
export const JsonSchemaParamSchema = z.object({
  type: z.enum(["string", "number", "boolean", "integer"]),
  description: z.string().optional(),
})
export type JsonSchemaParam = z.infer<typeof JsonSchemaParamSchema>

export const ReadDefinitionSchema = z.object({
  description: z.string().min(1),
  domain: z.string().min(1),
  /**
   * SQL template. Named params are referenced as `:name` in source form and
   * resolved to ordinal placeholders (`$1`, `$2`, …) in declaration order by
   * `bindParams`/`toOrdinalSql` — see below. Stored here in the `:name` form
   * so the same catalog entry can drive both `pg`-style execution and the
   * gate's own binding.
   */
  sql: z.string().min(1),
  params: z.record(z.string(), JsonSchemaParamSchema),
  /** Explicit column allow-list. Never empty — a read with no declared
   *  columns cannot be validated for secret-column leakage. This is the
   *  RESULT projection (what the caller gets back), not the full set of
   *  columns the SQL touches on each table (see `grantColumns` below). */
  columns: z.array(z.string()).min(1),
  maxRows: z.number().int().positive().optional(),
  /** Table(s) this read's SQL touches, `schema.table` — used to render the
   *  readonly-role grant allow-list (Task 7) and by `db_describe` filtering. */
  tables: z.array(z.string()).min(1),
  /**
   * Per-table column allow-list used ONLY to render the DB grant (S1
   * fail-closed fix): for EVERY table in `tables`, every column that read's
   * SQL touches on that table — SELECT projection + JOIN keys + WHERE +
   * ORDER BY — not just the flat `columns` result projection. This lets the
   * renderer emit `GRANT SELECT (<cols>) ON <table>` for every granted
   * table, never a bare full-row grant: an undeclared column (secret or
   * not, present today or added by a future migration) is unreadable by
   * construction (42501), instead of relying on `SECRET_COLUMNS` being
   * perfectly exhaustive forever.
   *
   * Optional in the source object — `validateCatalog` fills in the
   * single-table default (`{ [tables[0]]: columns }`) when omitted and a
   * read touches exactly one table. Multi-table reads (joins) MUST declare
   * this explicitly; validation rejects a multi-table read with no
   * `grantColumns` entry for one of its tables.
   */
  grantColumns: z.record(z.string(), z.array(z.string()).min(1)).optional(),
  /**
   * Set true ONLY when `columns` are computed/aggregate result ALIASES
   * (e.g. `count(*) AS backlog_count`, `min(created_at) AS
   * oldest_created_at`) rather than real column names — in that case the
   * "every `columns` entry must appear in some table's `grantColumns`"
   * check is skipped, since an alias has no underlying column to grant.
   * `grantColumns` is still mandatory and still fully validated (every
   * table present, no secret columns) — this flag ONLY relaxes the
   * columns-vs-grantColumns cross-check, never the grant-completeness or
   * secret-column checks.
   */
  resultIsAggregate: z.boolean().optional(),
})
export type ReadDefinition = z.infer<typeof ReadDefinitionSchema>

/** Who may run a domain's reads by default (an org setting overrides it). */
export const CATALOG_DOMAIN_TIERS = ["internal", "confidential", "restricted"] as const
export type CatalogDomainTier = (typeof CATALOG_DOMAIN_TIERS)[number]

/**
 * Optional per-domain defaults, keyed by the `domain` its reads carry. Only
 * `tier` is read: `internal` (every member holding the read scope, what a
 * domain without an entry gets), `confidential` (the roles the org grants it)
 * or `restricted` (the people the org names). A catalog without this block
 * parses and behaves exactly as before.
 */
export const CatalogDomainSchema = z.object({
  tier: z.enum(CATALOG_DOMAIN_TIERS),
  description: z.string().optional(),
})
export type CatalogDomain = z.infer<typeof CatalogDomainSchema>

export const ReadCatalogSchema = z.object({
  adapter: z.string().min(1),
  reads: z.record(z.string(), ReadDefinitionSchema),
  domains: z.record(z.string(), CatalogDomainSchema).optional(),
})
export type ReadCatalog = z.infer<typeof ReadCatalogSchema>

/** A `ReadDefinition` after `validateCatalog` — `grantColumns` is always
 *  populated (single-table reads get the `{ [tables[0]]: columns }`
 *  default filled in). Consumed by `grants-renderer.ts` so it never has to
 *  handle the "omitted" case. */
export type ResolvedReadDefinition = ReadDefinition & {
  grantColumns: Record<string, string[]>
}
export type ResolvedReadCatalog = Omit<ReadCatalog, "reads"> & {
  reads: Record<string, ResolvedReadDefinition>
}

export class CatalogValidationError extends Error {
  constructor(
    message: string,
    public readonly readName?: string,
  ) {
    super(message)
    this.name = "CatalogValidationError"
  }
}

// Leading `--` line comments and `/* */` block comments, then WITH or SELECT.
// A block comment ends at its first `*/` (the body is `[^*]*\*+(?:[^/*][^*]*\*+)*`):
// a lazy `[\s\S]*?\*\/` could stretch over a `*/` to a later one, which both
// backtracks exponentially and let `/* a */ delete ... '*/ select'` pass as
// SELECT-headed. Postgres's nested block comments are not recognised here.
const STATEMENT_HEAD_RE =
  /^\s*(?:--[^\n]*\n\s*|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/\s*)*(with|select)\b/i

/** Extracts `:name` occurrences from a SQL template, in first-occurrence order. */
export function extractNamedParams(sql: string): string[] {
  const seen: string[] = []
  const seenSet = new Set<string>()
  // Matches `:name` but not `::` (Postgres cast operator) and not inside a
  // simple `'...'` string literal (best-effort — catalog SQL is authored, not
  // adversarial; the adversarial-input case is sql-guard.ts's job).
  const re = /(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g
  let match: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((match = re.exec(sql)) !== null) {
    const name = match[1]
    if (!seenSet.has(name)) {
      seenSet.add(name)
      seen.push(name)
    }
  }
  return seen
}

// `:name::type` — a named param followed by an explicit cast. The type is a
// (possibly schema-qualified) identifier with an optional `[]`; multi-word
// types (`timestamp with time zone`) and `CAST(:x AS t)` are not recognised and
// leave the param as written.
const CAST_PARAM_RE =
  /(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)\s*::\s*([a-zA-Z_][a-zA-Z0-9_.]*(?:\s*\[\s*\])?)/g

/**
 * The one explicit cast each named param carries, when every cast of it in the
 * SQL names the same type. A param cast to two different types gets none.
 */
function castTypesByParam(sql: string): Map<string, string> {
  const types = new Map<string, string>()
  const conflicting = new Set<string>()
  for (const match of sql.matchAll(CAST_PARAM_RE)) {
    const name = match[1]!
    const type = match[2]!.replace(/\s+/g, "")
    const seen = types.get(name)
    if (seen === undefined) types.set(name, type)
    else if (seen.toLowerCase() !== type.toLowerCase()) conflicting.add(name)
  }
  for (const name of conflicting) types.delete(name)
  return types
}

/**
 * Converts a `:name`-templated SQL string + a named-params object into
 * ordinal-placeholder SQL (`$1`, `$2`, …) + a positional values array, in
 * first-occurrence order. One ordinal per unique name, reused at each
 * occurrence (Postgres allows a `$n` to repeat).
 *
 * A param cast explicitly at one occurrence (`:after::timestamptz`) gets the
 * same cast at its other, uncast occurrences. Postgres types a parameter from
 * the first place it meets it, and a context such as `$1 IS NULL` gives it no
 * type, so `:after IS NULL OR t > :after::timestamptz` fails with "could not
 * determine data type of parameter $1" over a driver that sends untyped
 * parameters (postgres.js) unless the cast comes first. Carrying the author's
 * cast to every occurrence makes the order of the occurrences irrelevant.
 */
export function toOrdinalSql(
  sql: string,
  namedParams: Record<string, unknown>,
): { text: string; values: unknown[] } {
  const castTypes = castTypesByParam(sql)
  const order: string[] = []
  const orderIndex = new Map<string, number>()
  const text = sql.replace(
    /(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)(\s*::)?/g,
    (_full, name: string, castOp: string | undefined) => {
      let idx = orderIndex.get(name)
      if (idx === undefined) {
        order.push(name)
        idx = order.length
        orderIndex.set(name, idx)
      }
      if (castOp !== undefined) return `$${idx}${castOp}`
      const castType = castTypes.get(name)
      return castType ? `$${idx}::${castType}` : `$${idx}`
    },
  )
  const values = order.map((name) => namedParams[name])
  return { text, values }
}

/** Rejects any read whose SQL does not have a SELECT/WITH statement head. */
function assertSelectHead(sql: string, readName: string): void {
  if (!STATEMENT_HEAD_RE.test(sql)) {
    throw new CatalogValidationError(
      `Read "${readName}": SQL must start with SELECT or WITH (read-only catalogs only)`,
      readName,
    )
  }
}

/** Rejects multiple statements (a bare top-level semicolon outside quotes). */
function assertSingleStatement(sql: string, readName: string): void {
  let inSingle = false
  let inDollar = false
  let dollarTag = ""
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (inDollar) {
      if (ch === "$") {
        const rest = sql.slice(i, i + dollarTag.length)
        if (rest === dollarTag) {
          inDollar = false
          i += dollarTag.length - 1
        }
      }
      continue
    }
    if (inSingle) {
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          i++
        } else {
          inSingle = false
        }
      }
      continue
    }
    if (ch === "'") {
      inSingle = true
      continue
    }
    if (ch === "$") {
      const tagMatch = /^\$[a-zA-Z_]*\$/.exec(sql.slice(i))
      if (tagMatch) {
        dollarTag = tagMatch[0]
        inDollar = true
        i += dollarTag.length - 1
        continue
      }
    }
    if (ch === ";") {
      const rest = sql.slice(i + 1).trim()
      if (rest.length > 0) {
        throw new CatalogValidationError(
          `Read "${readName}": SQL must be a single statement (found content after ";")`,
          readName,
        )
      }
    }
  }
}

function assertColumnsNotSecret(read: ReadDefinition, readName: string): void {
  for (const table of read.tables) {
    for (const col of read.columns) {
      if (isSecretColumn(table, col)) {
        throw new CatalogValidationError(
          `Read "${readName}": column "${col}" on "${table}" is a secret column (SECRET_COLUMNS) — not allowed in a catalog read's allow-list`,
          readName,
        )
      }
    }
  }
}

/**
 * Resolves `grantColumns` for a read: fills the single-table default when
 * omitted, then enforces the S1 fail-closed invariants:
 *  - every table in `tables` has a `grantColumns` entry
 *  - unless `resultIsAggregate` is set, every column in the flat `columns`
 *    projection appears under SOME table's `grantColumns` (the projection
 *    must be grantable from somewhere). `resultIsAggregate` reads (e.g.
 *    `count(*) AS backlog_count`) are exempt from this specific check since
 *    `columns` there are result ALIASES, not real column names — but they
 *    still must declare `grantColumns` (checked above) and are still
 *    subject to the secret-column check below.
 *  - no `grantColumns` entry names a column that is a SECRET_COLUMNS entry
 *    for that table (belt, on top of the primary `columns` check above)
 */
function resolveGrantColumns(read: ReadDefinition, readName: string): Record<string, string[]> {
  const declared = read.grantColumns
  const resolved: Record<string, string[]> =
    declared ?? (read.tables.length === 1 ? { [read.tables[0] as string]: read.columns } : {})

  for (const table of read.tables) {
    const cols = resolved[table]
    if (!cols || cols.length === 0) {
      throw new CatalogValidationError(
        `Read "${readName}": table "${table}" has no "grantColumns" entry. Every table a read touches ` +
          `(SELECT projection + JOIN keys + WHERE + ORDER BY) must declare exactly which columns it needs, ` +
          `so the DB grant renders column-scoped and fail-closed instead of a bare full-row GRANT.`,
        readName,
      )
    }
  }

  if (!read.resultIsAggregate) {
    const grantedElsewhere = new Set(Object.values(resolved).flat())
    for (const col of read.columns) {
      if (!grantedElsewhere.has(col)) {
        throw new CatalogValidationError(
          `Read "${readName}": result column "${col}" does not appear in any table's "grantColumns" — ` +
            `it would be selected but never granted (would fail with 42501 at the DB layer). If "${col}" ` +
            `is a computed/aggregate alias (not a real column), set "resultIsAggregate: true" on this read.`,
          readName,
        )
      }
    }
  }

  for (const [table, cols] of Object.entries(resolved)) {
    for (const col of cols) {
      if (isSecretColumn(table, col)) {
        throw new CatalogValidationError(
          `Read "${readName}": "grantColumns" for "${table}" names "${col}", a secret column ` +
            `(SECRET_COLUMNS) — never allowed in a grant allow-list, even for JOIN/WHERE-only usage.`,
          readName,
        )
      }
    }
  }

  return resolved
}

function assertParamsMatchSql(read: ReadDefinition, readName: string): void {
  const declared = new Set(Object.keys(read.params))
  const used = new Set(extractNamedParams(read.sql))
  for (const name of declared) {
    if (!used.has(name)) {
      throw new CatalogValidationError(
        `Read "${readName}": param "${name}" is declared but not used in SQL`,
        readName,
      )
    }
  }
  for (const name of used) {
    if (!declared.has(name)) {
      throw new CatalogValidationError(
        `Read "${readName}": SQL references param "${name}" that is not declared`,
        readName,
      )
    }
  }
}

/**
 * Validates a full catalog: zod shape, SELECT-only head, single-statement,
 * param/SQL parity, non-empty columns, and the secret-column guard. Throws
 * `CatalogValidationError` (or a zod error) on the first violation found.
 */
export function validateCatalog(catalog: unknown): ResolvedReadCatalog {
  const parsed = ReadCatalogSchema.parse(catalog)
  const resolvedReads: Record<string, ResolvedReadDefinition> = {}
  for (const [name, read] of Object.entries(parsed.reads)) {
    assertSelectHead(read.sql, name)
    assertSingleStatement(read.sql, name)
    assertParamsMatchSql(read, name)
    assertColumnsNotSecret(read, name)
    const grantColumns = resolveGrantColumns(read, name)
    resolvedReads[name] = { ...read, grantColumns }
  }
  return { ...parsed, reads: resolvedReads }
}

/** Static adapter registry — resolved by name (env `LIAISON_DATABASE_ADAPTER`). */
const adapterRegistry = new Map<string, ResolvedReadCatalog>()

export function registerAdapter(catalog: ReadCatalog): void {
  const validated = validateCatalog(catalog)
  adapterRegistry.set(validated.adapter, validated)
}

export function getAdapter(name: string): ResolvedReadCatalog | undefined {
  return adapterRegistry.get(name)
}

export function listAdapterNames(): string[] {
  return [...adapterRegistry.keys()]
}
