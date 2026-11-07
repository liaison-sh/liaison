// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one writer for a bundled app's own tables.
//
// A bundled app owns its tables (created from its manifest under
// `app_<name>`), and the host has no Drizzle schema for them: the app's
// handlers write them from inside the sandbox, through the app bridge, while
// the app does its work over time (a shipment synced, a feed polled, a
// snapshot refreshed, a document issued). A seeded org needs that accumulated
// history on the first screen, and no handler can produce it on demand, so
// the factories write the rows the app would have written, in the app's own
// row shape, through this one function.
//
// Every row is keyed on a deterministic id, so a re-seed overwrites the row in
// place and never moves a row count. Table and column names are quoted
// identifiers (`sql.identifier`), never spliced text; every value is a bound
// parameter, JSON columns as a `::jsonb` cast of the stringified value.
import { type SQL, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { schemaRef } from "~/db/schema-ref"

/** The transaction a factory writes in: the privileged connection's. */
export type SeedTx = PrivilegedDb

/** A JSON column value: stringified and cast, never handed to the driver raw. */
export interface JsonCell {
  __json: unknown
}

/** Wrap a value bound for a `jsonb` column. */
export function jsonCell(value: unknown): JsonCell {
  return { __json: value }
}

export type AppCell = string | number | boolean | null | JsonCell

function isJson(v: AppCell): v is JsonCell {
  return v !== null && typeof v === "object" && "__json" in v
}

/**
 * INSERT one row into `app_<app>.<table>` and, on a re-run, overwrite it in
 * place (conflict on `id`; `id` and `org_id` never change). The row must carry
 * `id` and `org_id`.
 */
export async function upsertAppRow(
  tx: SeedTx,
  app: string,
  table: string,
  row: Record<string, AppCell> & { id: string; org_id: string },
): Promise<void> {
  const cols = Object.keys(row)
  const target = sql`${sql.identifier(schemaRef(`app_${app}`))}.${sql.identifier(table)}`
  const colList = sql.join(
    cols.map((c) => sql.identifier(c)),
    sql`, `,
  )
  const values = sql.join(
    cols.map((c) => {
      const v = row[c] as AppCell
      return isJson(v) ? sql`${JSON.stringify(v.__json)}::jsonb` : sql`${v}`
    }),
    sql`, `,
  )
  const assignments = sql.join(
    cols
      .filter((c) => c !== "id" && c !== "org_id")
      .map((c) => sql`${sql.identifier(c)} = EXCLUDED.${sql.identifier(c)}`),
    sql`, `,
  )
  await tx.execute(
    sql`INSERT INTO ${target} (${colList}) VALUES (${values})
        ON CONFLICT (id) DO UPDATE SET ${assignments}`,
  )
}

/** The one call a writer needs: a transaction, the privileged connection, or an app's RLS client. */
export interface AppRowWriter {
  execute(query: SQL): Promise<unknown>
}

/**
 * INSERT one row into `app_<app>.<table>`, as the app's own handler would
 * (`db_insert`): no conflict clause, so a duplicate fails as it would there,
 * and the column defaults (`id`, timestamps) fill whatever the row leaves out.
 * For a write inside a test's own transaction or an app's RLS client.
 */
export async function insertAppRow(
  tx: AppRowWriter,
  app: string,
  table: string,
  row: Record<string, AppCell> & { org_id: string },
): Promise<void> {
  const cols = Object.keys(row)
  const target = sql`${sql.identifier(schemaRef(`app_${app}`))}.${sql.identifier(table)}`
  const colList = sql.join(
    cols.map((c) => sql.identifier(c)),
    sql`, `,
  )
  const values = sql.join(
    cols.map((c) => {
      const v = row[c] as AppCell
      return isJson(v) ? sql`${JSON.stringify(v.__json)}::jsonb` : sql`${v}`
    }),
    sql`, `,
  )
  await tx.execute(sql`INSERT INTO ${target} (${colList}) VALUES (${values})`)
}

/** `base` shifted by a whole number of days and hours. */
export function shiftTime(base: Date, days: number, hours = 0): Date {
  return new Date(base.getTime() + days * 86_400_000 + hours * 3_600_000)
}

export function iso(d: Date): string {
  return d.toISOString()
}
