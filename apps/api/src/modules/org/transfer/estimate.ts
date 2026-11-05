// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `estimateTransfer`: how big one org's move is, before any freeze. Rows and
// bytes per closure table and an estimated write gap: the fixed per-step costs
// of the freeze (plans R1.4) plus the per-row costs of the gap at the measured
// rates. The scan rate counts every row of the org once for ALL the per-row
// work inside the gap (the pass 2 `(pk, xmin)` scan and diff, the fingerprint
// re-check, and the apply's own scaling with the org's size); only the delta is
// applied. A caller refuses a move whose estimate exceeds its bound
// (`--max-freeze`).
//
// Rates were measured by the local timing spike (timing-spike.test.ts, one
// machine, source and target databases on the same host, no network; the
// network and router costs are in FIXED_GAP_SECONDS as their targets):
//   - pass 2 scan and diff 1.47 us/row, fingerprint re-check 2.4 us/row, the
//     apply's size-dependent part 0.55 us/row: 4.4 us/row together, about
//     225k rows/s (a lively org of 3.4k rows: 0.6 s in the gap; 400k rows: 2.4 s);
//   - delta apply 78 us per changed row (12.8k rows/s, 1k to 20k changed rows).
import { assertUuid, loadClosure, orgPredicate, query, rel, type TransferSql } from "./closure"

/** Seconds of the freeze that do not depend on the org's size (R1.4 targets). */
export const FIXED_GAP_SECONDS = 0.5 + 0.5 + 1 + 1 + 0.5 + 2
/** Org rows per second of all the per-row work inside the gap (measured, see above). */
export const SCAN_ROWS_PER_SECOND = 225_000
/** Changed rows per second the target applies (measured). */
export const APPLY_ROWS_PER_SECOND = 12_000
/**
 * Share of the org's rows expected to change between pass 1b and pass 2. The
 * spike saw 3 to 10 rows (5 writes/s over about 2 s) in orgs of 3.4k and 400k
 * rows; a share is pessimistic for a big org and costs microseconds there.
 */
export const DELTA_SHARE = 0.001

/** The estimated write gap, seconds, of an org with `rows` rows in its closure. */
export function gapSeconds(rows: number): number {
  const seconds =
    FIXED_GAP_SECONDS +
    rows / SCAN_ROWS_PER_SECOND +
    Math.ceil(rows * DELTA_SHARE) / APPLY_ROWS_PER_SECOND
  return Math.round(seconds * 100) / 100
}

export interface TransferEstimate {
  orgId: string
  tables: Array<{ table: string; rows: number; bytes: number }>
  rows: number
  bytes: number
  /** Estimated write gap of the move, seconds. */
  freezeSeconds: number
}

export async function estimateTransfer(
  sql: TransferSql,
  orgIdIn: string,
): Promise<TransferEstimate> {
  const orgId = assertUuid(orgIdIn, "estimateTransfer")
  const closure = await loadClosure(sql)
  const tables: TransferEstimate["tables"] = []
  for (const t of closure.tables) {
    const r = await query<{ n: number; b: string }>(
      sql,
      `SELECT count(*)::int AS n, coalesce(sum(pg_column_size(t.*)), 0)::text AS b
         FROM ${rel(t.name)} t WHERE ${orgPredicate(closure, t, "t", orgId)}`,
    )
    const rows = r[0]?.n ?? 0
    if (rows > 0) tables.push({ table: t.name, rows, bytes: Number(r[0]?.b ?? 0) })
  }
  const rows = tables.reduce((s, t) => s + t.rows, 0)
  const bytes = tables.reduce((s, t) => s + t.bytes, 0)
  return { orgId, tables, rows, bytes, freezeSeconds: gapSeconds(rows) }
}
