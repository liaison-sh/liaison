// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * kernel.import_ledger: every row an import run created, in creation order.
 * Written in the record's own transaction by host handlers, right after the
 * bundle call for bundled handlers (with `recoverLedger` as the sweep for a
 * crash between the two). Undo reads it newest first.
 */
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import type { ImportRowRef } from "~/modules/imports/types"

const QUALIFIED = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/

/** A logical, schema-qualified table name a ledger may hold (`app_tickets.tickets`). */
export function isLedgerTableName(name: string): boolean {
  return QUALIFIED.test(name)
}

/**
 * The SQL relation of a logical ledger table name, with the run's schema prefix
 * applied. Names are validated identifiers written by handler code (never by a
 * record); anything else throws.
 */
export function tableRel(name: string): SQL {
  const m = QUALIFIED.exec(name)
  if (!m) throw new Error(`invalid ledger table name: ${name}`)
  return drizzleSql.raw(`${quoteIdent(schemaRef(m[1] ?? ""))}.${quoteIdent(m[2] ?? "")}`)
}

/** Record created rows (duplicates within a run are ignored). */
export async function insertLedgerRows(
  tx: PrivilegedDb,
  args: { orgId: string; runId: string; kind: string; recordKey: string; rows: ImportRowRef[] },
): Promise<void> {
  if (args.rows.length === 0) return
  for (const r of args.rows) {
    if (!isLedgerTableName(r.table)) throw new Error(`invalid ledger table name: ${r.table}`)
  }
  const K = drizzleSql.raw(schemaRef("kernel"))
  const payload = JSON.stringify(args.rows.map((r) => ({ t: r.table, id: r.id })))
  // WITH ORDINALITY keeps creation order in `seq` (identity assigned per row).
  await tx.execute(drizzleSql`
    INSERT INTO ${K}.import_ledger (org_id, run_id, kind, record_key, table_name, row_id)
    SELECT ${args.orgId}::uuid, ${args.runId}::uuid, ${args.kind}, ${args.recordKey},
           r.v->>'t', (r.v->>'id')::uuid
    FROM jsonb_array_elements(${payload}::jsonb) WITH ORDINALITY AS r(v, n)
    ORDER BY r.n
    ON CONFLICT (table_name, row_id, run_id) DO NOTHING
  `)
}

export interface LedgerEntry {
  seq: number
  kind: string
  recordKey: string
  table: string
  id: string
  recordedAt: string
}

/** A run's ledger, newest first. */
export async function readLedger(
  tx: PrivilegedDb,
  orgId: string,
  runId: string,
): Promise<LedgerEntry[]> {
  const K = drizzleSql.raw(schemaRef("kernel"))
  return extractRows<{
    seq: string | number
    kind: string
    record_key: string
    table_name: string
    row_id: string
    recorded_at: string | Date
  }>(
    await tx.execute(drizzleSql`
      SELECT seq, kind, record_key, table_name, row_id, recorded_at
      FROM ${K}.import_ledger
      WHERE org_id = ${orgId}::uuid AND run_id = ${runId}::uuid
      ORDER BY seq DESC
    `),
  ).map((r) => ({
    seq: Number(r.seq),
    kind: r.kind,
    recordKey: r.record_key,
    table: r.table_name,
    id: r.row_id,
    recordedAt: r.recorded_at instanceof Date ? r.recorded_at.toISOString() : String(r.recorded_at),
  }))
}
