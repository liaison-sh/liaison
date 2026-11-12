// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The read catalog of a SQL connection: the named, curated reads an app runs by
// name (`ctx.sql.query(connection, { read })`). A catalog is deployment data,
// never app code: the instance's own (LIAISON_DATABASE_ADAPTER_PATH, a mounted
// YAML, or a registered adapter named by LIAISON_DATABASE_ADAPTER, default
// `liaison-self`), or on the demo box the per-org demo warehouse catalog.
//
// `liaison-self` reads this instance's own database through a read-only login
// that bypasses row-level security. Its reads are held host-side to the
// caller's org (`pinCallerOrg`) and to the scopes their tables need
// (`missingLiaisonSelfScopes`), and raw SQL over it is the instance
// operator's alone (service.ts).

import {
  getAdapter,
  listAdapterNames,
  type ReadCatalog,
  SECRET_COLUMNS,
  validateCatalog,
} from "@liaison/db-core"
import { parse as parseYaml } from "yaml"
import { withOpenFileSync } from "~/lib/read-checked-file"
import { hasScope } from "~/modules/permissions/permissions"
import { DatabaseConfigError } from "./credentials"

// Registers the default liaison-self catalog into db-core's static registry.
import "./adapters/liaison-self"

/**
 * The `liaison-self` catalog reads a Liaison database through a read-only login
 * that bypasses row-level security, and every one of its reads is scoped by an
 * `orgId` parameter. That parameter is the caller's org, always: a value the
 * caller passes is replaced, so a read can never be pointed at another org's rows.
 */
export function pinCallerOrg(
  catalog: Pick<ReadCatalog, "adapter">,
  params: Record<string, unknown>,
  orgId: string,
): Record<string, unknown> {
  if (catalog.adapter !== "liaison-self") return params
  return { ...params, orgId }
}

/** A numeric string ("10", " 0.5 ", "-3") as the number it spells, else null. */
function numericString(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === "" || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed)) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

/**
 * Check the declared params of a curated read against the call, coercing a
 * numeric string for a `number`/`integer` param to the number it spells (models
 * routinely send `"10"`). Every declared param is bound into the SQL
 * (`toOrdinalSql`), so a missing one reached the driver as `undefined` and
 * postgres.js refused the whole query ("UNDEFINED_VALUE: Undefined values are
 * not allowed"), an opaque 500 the agent could not act on. A JSON `null` is a
 * value (SQL NULL) and passes. Returns the params to bind and what is invalid.
 */
export function normalizeReadParams(
  declared: Record<string, { type: "string" | "number" | "boolean" | "integer" }>,
  given: Record<string, unknown>,
): {
  params: Record<string, unknown>
  invalid: Array<{ name: string; expected: string; problem: string }>
} {
  const params: Record<string, unknown> = { ...given }
  const invalid: Array<{ name: string; expected: string; problem: string }> = []
  for (const [name, { type }] of Object.entries(declared)) {
    let value = given[name]
    if (value === undefined) {
      invalid.push({ name, expected: type, problem: `"${name}" (${type}), which is missing` })
      continue
    }
    if (value === null) continue
    if ((type === "number" || type === "integer") && typeof value === "string") {
      const n = numericString(value)
      if (n !== null) {
        value = n
        params[name] = n
      }
    }
    const ok =
      type === "integer"
        ? typeof value === "number" && Number.isInteger(value)
        : typeof value === type
    if (!ok) {
      invalid.push({
        name,
        expected: type,
        problem: `"${name}" to be a ${type}, not ${Array.isArray(value) ? "an array" : typeof value === "number" ? "a fraction" : typeof value}`,
      })
    }
  }
  return { params, invalid }
}

/**
 * The read scope a caller must hold to run a `liaison-self` read over a table:
 * the login bypasses row-level security, so the read is held to at least the
 * scope the app itself demands for those rows. Tables not listed carry org
 * bookkeeping (tier, credits, outbox backlog, connection status).
 */
const LIAISON_SELF_TABLE_SCOPES: Record<string, string> = {
  app_tickets: "tickets:tickets:read",
  app_knowledge: "knowledge:documents:read",
  app_mail: "mail:conversations:read",
  "kernel.audit_log": "kernel:audit:read",
}

/** The scopes a `liaison-self` read needs that the caller does not hold. */
export function missingLiaisonSelfScopes(
  catalog: Pick<ReadCatalog, "adapter">,
  read: { tables: string[] },
  callerScopes: string[],
): string[] {
  if (catalog.adapter !== "liaison-self") return []
  const needed = new Set<string>()
  for (const table of read.tables) {
    const scope = LIAISON_SELF_TABLE_SCOPES[table] ?? LIAISON_SELF_TABLE_SCOPES[table.split(".")[0]]
    if (scope) needed.add(scope)
  }
  return [...needed].filter((scope) => !hasScope(scope, callerScopes))
}

/** Defense-in-depth belt over db_describe: even though the grant allow-list already
 *  excludes secret columns from what the role can read, strip any SECRET_COLUMNS
 *  entry from described output so a mis-provisioned grant can't leak a column name. */
export function filterSecretColumns(
  table: string,
  columns: { column: string; dataType: string }[],
) {
  const secretCols = new Set(
    SECRET_COLUMNS.filter((c) => c.table.toLowerCase() === table.toLowerCase()).map((c) =>
      c.column.toLowerCase(),
    ),
  )
  return columns.filter((c) => !secretCols.has(c.column.toLowerCase()))
}

// Cache the file-loaded catalog by (path, mtime): parse + validate a mounted
// YAML adapter once rather than on every call, while still picking up an
// edited file after a redeploy (mtime changes).
let cachedFileCatalog: { path: string; mtimeMs: number; catalog: ReadCatalog } | null = null
function loadCatalogFromPath(path: string): ReadCatalog {
  // The mtime and the text come from one open descriptor: the file whose
  // mtime keys the cache is the file parsed.
  let opened = false
  try {
    return withOpenFileSync(path, ({ mtimeMs }, read) => {
      opened = true
      if (cachedFileCatalog?.path === path && cachedFileCatalog.mtimeMs === mtimeMs) {
        return cachedFileCatalog.catalog
      }
      let parsed: unknown
      try {
        parsed = parseYaml(read().toString("utf-8"))
      } catch (err) {
        throw new DatabaseConfigError(
          `Failed to parse adapter catalog YAML at "${path}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      const catalog = validateCatalog(parsed)
      cachedFileCatalog = { path, mtimeMs, catalog }
      return catalog
    })
  } catch (err) {
    if (opened) throw err
    throw new DatabaseConfigError(
      `LIAISON_DATABASE_ADAPTER_PATH="${path}" is not readable: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Resolve the connected database's curated-reads catalog — the single source
 * of truth for BOTH the bridge tools and the app-to-app Knowledge read runner
 * (`knowledge-read-runner.ts`). A deployment reading a NON-liaison database
 * supplies its own catalog as a mounted YAML via LIAISON_DATABASE_ADAPTER_PATH;
 * otherwise a registered in-tree adapter (default liaison-self) is used.
 */
export function resolveDatabaseCatalog(): ReadCatalog {
  const path = process.env.LIAISON_DATABASE_ADAPTER_PATH
  if (path) return loadCatalogFromPath(path)
  const adapterName = process.env.LIAISON_DATABASE_ADAPTER ?? "liaison-self"
  const catalog = getAdapter(adapterName)
  if (!catalog) {
    throw new DatabaseConfigError(
      `Unknown database adapter "${adapterName}" (registered: ${listAdapterNames().join(", ") || "none"})`,
    )
  }
  return catalog
}

/** The catalog an org's curated reads come from: the demo warehouse's for a
 *  demo org, the deployment's otherwise. */
export async function resolveOrgDatabaseCatalog(orgId: string): Promise<ReadCatalog> {
  const { isDemoWarehouseOrg, demoWarehouseReadCatalog } = await import(
    "~/modules/demo/warehouse/resolve"
  )
  if (await isDemoWarehouseOrg(orgId)) return demoWarehouseReadCatalog()
  return resolveDatabaseCatalog()
}
