// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org purge's database half: every row of one org, in every `kernel` and
// `app_*` table that has an `org_id`, found in the catalog.
//
// ── WHY THE PURGE IS CATALOG DRIVEN ────────────────────────────────────────
// `DELETE FROM kernel.organizations` does not do it. `users_org_fk` carries no
// ON DELETE clause (0054 says so in as many words), so the delete is refused
// while a single user exists; and the app schemas do not reference
// `organizations` at all (their `org_id` is a plain column, RLS-enforced, with
// no foreign key), so a cascade would leave every ticket, invoice and shipment
// behind as an orphan. The sweep therefore asks the catalog for every table in
// `kernel` and `app_*` that HAS an `org_id` column and deletes this org's rows
// from each, retrying the ones that refuse on a foreign key until a pass makes
// no progress. One org id is the only parameter, and the table list comes from
// the catalog rather than a hand-maintained constant that would rot the next
// time an app adds a table.
//
// ── IMMUTABLE APP TABLES (LEGAL RECORDS) ───────────────────────────────────
// An app table declared `immutable` (an issued invoice's legal original) is
// guarded by the kernel trigger in ddl.ts, which refuses a DELETE for the whole
// retention period. Each DELETE here sets `ORG_PURGE_SETTING` to the org,
// transaction locally, after the caller's guard. The trigger honours it only
// for `liaison_admin`, only for that org's rows, and only while that org's
// stored row says it may go (`deleting_at` set, or a demo marker), so no other
// org's legal records are touched.
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"
import { describeDbError } from "~/lib/transient-db-error"
import { ORG_PURGE_SETTING } from "~/modules/apps/ddl"

const log = rootLogger.child({ module: "org-purge" })

export interface OrgScopedTable {
  schema: string
  table: string
}

/** The one thing the purge needs of a transaction. */
export interface ExecuteTx {
  execute: (q: unknown) => Promise<unknown>
}

/** The rows of a postgres.js / drizzle `execute` result. */
export function resultRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[]
}

/**
 * Tables carrying an `org_id`, in `kernel` and the `app_*` schemas, or in the
 * `app_*` schemas alone. The purge empties every one of them for the org.
 *
 * So a table that must SURVIVE an org's deletion (a deletion ledger, the legal
 * archive index) carries no `org_id` column: it names the org another way
 * (e.g. `deleted_org_id`), or it is excluded here explicitly, with a test.
 */
export async function orgScopedTables(
  tx: ExecuteTx,
  scope: "all" | "apps-only",
): Promise<OrgScopedTable[]> {
  const schemaFilter =
    scope === "all"
      ? drizzleSql`(c.table_schema = 'kernel' OR c.table_schema LIKE 'app\\_%')`
      : drizzleSql`c.table_schema LIKE 'app\\_%'`
  const result = await tx.execute(drizzleSql`
    SELECT c.table_schema AS schema, c.table_name AS table
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.column_name = 'org_id'
      AND t.table_type = 'BASE TABLE'
      AND ${schemaFilter}
    ORDER BY c.table_schema, c.table_name
  `)
  return resultRows<{ schema: string; table: string }>(result).map((r) => ({
    schema: String(r.schema),
    table: String(r.table),
  }))
}

/** SQLSTATE 23503: a foreign key refused the DELETE; a later pass retries it. */
const FOREIGN_KEY_VIOLATION = "23503"

/** A table whose DELETE failed for a reason other than a foreign key. */
export interface DeleteFailure {
  table: string
  code: string | null
  message: string | null
}

/**
 * Thrown when a purge or a content reset could not empty every table. `failed`
 * holds the refusals that a retry would not cure (an immutability trigger, a
 * permission, a lock timeout), each with its SQLSTATE and message; `blocked`
 * holds the tables a foreign key still refused when a pass made no progress.
 */
export class OrgPurgeIncompleteError extends Error {
  readonly failed: DeleteFailure[]
  readonly blocked: string[]
  constructor(failed: DeleteFailure[], blocked: string[]) {
    const parts: string[] = []
    if (failed.length > 0) {
      parts.push(
        `${failed.length} table(s) refused the delete (${failed
          .map((f) => `${f.table}: ${f.code ?? "no code"} ${f.message ?? "no message"}`)
          .join("; ")})`,
      )
    }
    if (blocked.length > 0) {
      parts.push(
        `${blocked.length} table(s) still blocked by a foreign key (${blocked.join(", ")})`,
      )
    }
    super(`org purge: ${parts.join("; ")}`)
    this.name = "OrgPurgeIncompleteError"
    this.failed = failed
    this.blocked = blocked
  }
}

/** The tables of `tables` that hold at least one row of `orgId`, in one statement. */
export async function tablesHoldingOrgRows(
  tx: ExecuteTx,
  orgId: string,
  tables: OrgScopedTable[],
): Promise<OrgScopedTable[]> {
  if (tables.length === 0) return []
  const probes = tables.map(
    (t, i) =>
      drizzleSql`SELECT ${i}::int AS i WHERE EXISTS (SELECT 1 FROM ${drizzleSql.raw(
        `"${t.schema}"."${t.table}"`,
      )} WHERE org_id = ${orgId}::uuid)`,
  )
  const result = await tx.execute(drizzleSql.join(probes, drizzleSql.raw(" UNION ALL ")))
  const held = new Set(resultRows<{ i: number }>(result).map((r) => Number(r.i)))
  return tables.filter((_, i) => held.has(i))
}

/** How many rows of `orgId` each org scoped table still holds (non-zero only). */
export async function countOrgRows(orgId: string): Promise<Record<string, number>> {
  const tables = await withSystemDb("org-purge-residue-tables", (tx) =>
    orgScopedTables(tx as never, "all"),
  )
  const held = await withSystemDb("org-purge-residue-occupied", (tx) =>
    tablesHoldingOrgRows(tx as never, orgId, tables),
  )
  const out: Record<string, number> = {}
  for (const t of held) {
    const n = await withSystemDb("org-purge-residue-count", async (tx) => {
      const ref = drizzleSql.raw(`"${t.schema}"."${t.table}"`)
      const result = await tx.execute(
        drizzleSql`SELECT count(*)::int AS n FROM ${ref} WHERE org_id = ${orgId}::uuid`,
      )
      return Number(resultRows<{ n: number }>(result)[0]?.n ?? 0)
    })
    if (n > 0) out[`${t.schema}.${t.table}`] = n
  }
  return out
}

/**
 * Delete this org's rows from the tables `tables` names, retrying the ones a
 * foreign key refuses until a pass makes no progress. Any other refusal is not
 * retried: it is collected with its SQLSTATE and message and thrown, after the
 * rest of the sweep has run, as an `OrgPurgeIncompleteError`.
 *
 * `assertAllowed` runs first, at the one place every destructive path funnels
 * through: the org purge passes "its deletion has started", the demo reset its
 * demo-mode-and-marker guard. It must re-read the org from Postgres rather than
 * believe a caller.
 */
export async function deleteOrgRows(
  reason: string,
  orgId: string,
  tables: (tx: ExecuteTx) => Promise<OrgScopedTable[]>,
  assertAllowed: (orgId: string, what: string) => Promise<unknown>,
): Promise<Record<string, number>> {
  await assertAllowed(orgId, reason)

  const deleted: Record<string, number> = {}
  // Only the tables that hold a row of the org: one probe for all of them
  // (an index lookup each), instead of a transaction per table of every app's
  // schema. Most of those hundreds of tables hold nothing for one org, and the
  // empty DELETEs were most of a purge's time.
  const all = await withSystemDb(`${reason}-tables`, (tx) => tables(tx as never))
  let pending = all
  try {
    pending = await withSystemDb(`${reason}-occupied`, (tx) =>
      tablesHoldingOrgRows(tx as never, orgId, all),
    )
  } catch (err) {
    // The probe is an optimisation: without it every table is visited, as before.
    log.warn({ err, orgId, reason }, "org purge: occupancy probe failed, visiting every table")
  }

  // ONE TRANSACTION PER TABLE, and not one for the whole purge.
  //
  // A foreign key decides the order and no generic order is right for every
  // one of them, so a pass deletes what it can and the next pass retries the
  // rest. That retry needs the refused statement to be survivable, and inside a
  // single transaction it is not: postgres.js carries a statement's error
  // through to COMMIT even when the caller caught it and rolled back to a
  // savepoint, so the whole purge died at commit reporting a violation the loop
  // had already worked around (`tasks_status_id_fkey`, observed against a real
  // seeded world). A transaction per statement is what makes a refusal local.
  //
  // What that costs is atomicity, and every caller is built for it: an org
  // purge deletes the `organizations` row LAST, so a run that dies half way
  // leaves an org the next run collects again, and the demo content reset
  // raises a flag on the org before it starts and lowers it only once the
  // re-seed has landed.
  const failed: DeleteFailure[] = []
  while (pending.length > 0) {
    const blocked: OrgScopedTable[] = []
    for (const t of pending) {
      const label = `${t.schema}.${t.table}`
      try {
        const count = await withSystemDb(reason, async (tx) => {
          await tx.execute(drizzleSql`SELECT set_config(${ORG_PURGE_SETTING}, ${orgId}, true)`)
          const ref = drizzleSql.raw(`"${t.schema}"."${t.table}"`)
          const result = await tx.execute(
            drizzleSql`DELETE FROM ${ref} WHERE org_id = ${orgId}::uuid RETURNING 1`,
          )
          return resultRows(result).length
        })
        if (count > 0) deleted[label] = (deleted[label] ?? 0) + count
      } catch (err) {
        const { code, message } = describeDbError(err)
        if (code === FOREIGN_KEY_VIOLATION) {
          blocked.push(t)
        } else {
          log.error({ err, orgId, reason, table: label, code }, "org purge: a delete was refused")
          failed.push({ table: label, code, message })
        }
      }
    }
    if (blocked.length > 0 && blocked.length === pending.length) {
      const names = blocked.map((t) => `${t.schema}.${t.table}`)
      log.error({ orgId, reason, blocked: names, failed }, "org purge: no progress on the rest")
      throw new OrgPurgeIncompleteError(failed, names)
    }
    pending = blocked
  }
  if (failed.length > 0) throw new OrgPurgeIncompleteError(failed, [])
  return deleted
}
