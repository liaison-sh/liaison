// SPDX-License-Identifier: FSL-1.1-ALv2
// A retainer month on its project: the timebox invoicing wrote for it (its included hours) and the
// schedule that row comes from. The card's draft key, `retainer:<schedule>:<YYYY-MM>`, is built from
// them, so Create, the claims, the sweep and invoicing all follow one key per schedule and month.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"

export interface RetainerMonthFacts {
  scheduleId: string | null
  timeboxMinutes: number | null
}

/** The retainer's timebox row for the month starting `periodStart`, or nulls when there is none. */
export async function retainerMonthFacts(
  tx: RlsClient,
  orgId: string,
  projectId: string,
  periodStart: string,
): Promise<RetainerMonthFacts> {
  const row = extractRows<{ source_ref: string | null; minutes: number }>(
    await tx.execute(drizzleSql`
      SELECT source_ref, minutes FROM ${projectsRel("project_timeboxes")}
       WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid
         AND period_start = ${periodStart}::date`),
  )[0]
  return {
    scheduleId: row?.source_ref ?? null,
    timeboxMinutes: row ? Number(row.minutes) : null,
  }
}

/** The key a retainer month's draft carries. */
export function retainerDocumentRef(scheduleId: string, periodStart: string): string {
  return `retainer:${scheduleId}:${periodStart.slice(0, 7)}`
}
