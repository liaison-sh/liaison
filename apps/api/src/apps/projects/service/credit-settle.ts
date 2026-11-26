// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Partial credits settled by the claims sweep, kept out of the sweep's own module, which reads
// only switches, claims and documents. This one reads a reconciliation's billed lines (the
// quantity each line billed, never a time row, a note or a person).
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { hoursPerDayMinutes } from "./time-plan"

/** Credit notes that count: issued ones, never a draft, a pending or a voided one. */
export const CREDIT_COUNTS = drizzleSql`cn.status NOT IN ('draft', 'pending_approval', 'voided', 'cancelled')`

type SweepTx = { execute: (q: ReturnType<typeof drizzleSql>) => Promise<unknown> }

/**
 * Partial credits: an invoiced reconciliation whose invoice credit notes took back in part gets,
 * on each line those notes name (`reconcile_line:<lineId>`), the figure it still bills: the
 * invoice line's quantity less every counting credit note's, in minutes of the card's unit. The
 * same figure invoicing hands projects after a partial credit; this settles it when that
 * call was lost. Compare-and-set: a line already at its figure is not written.
 */
export async function settlePartialCredits(
  tx: SweepTx,
  D: ReturnType<typeof drizzleSql.raw>,
  notMoving: (col: ReturnType<typeof drizzleSql.raw>) => ReturnType<typeof drizzleSql>,
): Promise<number> {
  const LINES = drizzleSql.raw(`${schemaRef("app_invoicing")}.document_lines`)
  const rows = extractRows<{
    org_id: string
    line_id: string
    basis: string
    hpd: number | null
    bill_minutes: number
    billed: string
  }>(
    await tx.execute(drizzleSql`
      SELECT r.org_id::text AS org_id, l.id::text AS line_id, r.basis,
             r.create_hours_per_day_minutes AS hpd, l.bill_minutes,
             (il.quantity - cl.quantity)::text AS billed
        FROM ${projectsRel("reconciliations")} r
        JOIN ${D} d ON d.org_id = r.org_id AND d.external_ref = r.document_ref
         AND d.type <> 'credit_note' AND d.status IN ('issued', 'paid', 'overdue')
        JOIN ${projectsRel("reconciliation_lines")} l
          ON l.reconciliation_id = r.id AND l.org_id = r.org_id
        JOIN LATERAL (
          SELECT sum(abs(x.quantity)) AS quantity FROM ${LINES} x
           WHERE x.document_id = d.id AND x.external_id = 'reconcile_line:' || l.id::text
        ) il ON il.quantity IS NOT NULL
        JOIN LATERAL (
          SELECT sum(abs(x.quantity)) AS quantity
            FROM ${D} cn JOIN ${LINES} x ON x.document_id = cn.id
           WHERE cn.org_id = d.org_id AND cn.type = 'credit_note'
             AND cn.original_document_id = d.id AND ${CREDIT_COUNTS}
             AND x.external_id = 'reconcile_line:' || l.id::text
        ) cl ON cl.quantity IS NOT NULL
       WHERE r.state = 'invoiced'
         AND ${notMoving(drizzleSql.raw("r.org_id"))}`),
  )
  let lines = 0
  const hpdOf = new Map<string, number>()
  for (const row of rows) {
    let per = 60
    if (row.basis === "daily") {
      if (row.hpd !== null) per = row.hpd
      else {
        if (!hpdOf.has(row.org_id)) {
          hpdOf.set(row.org_id, await hoursPerDayMinutes(tx as never, row.org_id))
        }
        per = hpdOf.get(row.org_id)!
      }
    }
    const billedMinutes = Math.max(0, Math.round(Number(row.billed) * per))
    const figure = Math.min(row.bill_minutes, billedMinutes)
    lines += extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("reconciliation_lines")}
           SET billed_after_credit_minutes = ${figure}, updated_at = now()
         WHERE id = ${row.line_id}::uuid AND org_id = ${row.org_id}::uuid
           AND billed_after_credit_minutes IS DISTINCT FROM ${figure}
        RETURNING id::text AS id`),
    ).length
  }
  return lines
}
