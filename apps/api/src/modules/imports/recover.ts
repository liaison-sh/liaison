// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Recovery of bundled import kinds' ledgers (R1): a bundle writes its rows
 * through the RLS session bridge and the runner records them right after, in a
 * second transaction. A crash between the two leaves rows the ledger does not
 * name; `recoverLedger` records them. It runs before an undo and from the
 * stale-run sweep.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { lookupImportKind } from "~/modules/imports/kinds"
import { isLedgerTableName, tableRel } from "~/modules/imports/ledger"

/**
 * Re-derive ledger rows a bundled kind created but did not get to record (a
 * crash between the bundle call and the ledger write): rows of the kind's
 * tables whose `external_ref` carries the run's source prefix, created since
 * the run started, and recorded in no ledger. Tables without `external_ref` and
 * `created_at` are skipped. Returns how many rows were recorded.
 */
export async function recoverLedger(orgId: string, runId: string): Promise<number> {
  return withPrivilegedDb(orgId, "imports-recover-ledger", async (tx) => {
    const K = drizzleSql.raw(schemaRef("kernel"))
    const run = extractRows<{
      kind_set: string[]
      source_label: string
      started_at: string | null
    }>(
      await tx.execute(drizzleSql`
        SELECT kind_set, source_label, started_at FROM ${K}.import_runs
        WHERE org_id = ${orgId}::uuid AND id = ${runId}::uuid
      `),
    )[0]
    // No label, no prefix to match: never sweep every external ref.
    if (!run?.started_at || !run.source_label) return 0
    let recovered = 0
    for (const kindName of run.kind_set) {
      const k = lookupImportKind(orgId, kindName, false)
      if (!k?.bundle) continue
      for (const table of k.decl.tables) {
        if (!isLedgerTableName(table)) continue
        const [schema, name] = table.split(".") as [string, string]
        const cols = extractRows<{ column_name: string }>(
          await tx.execute(drizzleSql`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = ${schemaRef(schema)} AND table_name = ${name}
              AND column_name IN ('external_ref', 'created_at', 'org_id')
          `),
        ).map((c) => c.column_name)
        if (cols.length < 3) continue
        const prefix = `${run.source_label.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`
        const inserted = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            INSERT INTO ${K}.import_ledger (org_id, run_id, kind, record_key, table_name, row_id)
            SELECT ${orgId}::uuid, ${runId}::uuid, ${kindName}, t.external_ref, ${table}, t.id
            FROM ${tableRel(table)} t
            WHERE t.org_id = ${orgId}::uuid
              AND t.external_ref LIKE ${prefix}
              AND t.created_at >= ${run.started_at}::timestamptz
              AND NOT EXISTS (
                SELECT 1 FROM ${K}.import_ledger l WHERE l.table_name = ${table} AND l.row_id = t.id
              )
            ON CONFLICT (table_name, row_id, run_id) DO NOTHING
            RETURNING row_id AS id
          `),
        )
        recovered += inserted.length
      }
    }
    return recovered
  })
}
