// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Audit log retention, enforced daily (infra/jobs/kernel-jobs.ts,
// `audit-log-retention`): one DELETE over every org, no org list in memory.
//
// Self-hosted: an org keeps `settings.auditRetentionDays` days, else 90.
// Managed (S24, A42, P3R-16): the plan's `caps.auditDays` is what was sold, so
// the org keeps min(`settings.auditRetentionDaysChosen` ?? `auditDays`,
// `auditDays`) days; the 90-day settings default is not read for a capped org.
// A managed org without the cap keeps the admin's choice, else the setting,
// else 90. Mirrors `effectiveAuditRetentionDays` (caps.ts).
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { isManagedEdition } from "~/lib/edition"
import { jobsLogger as log } from "~/lib/logger"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"

/** The days an org keeps, as SQL over `o` (kernel.organizations). */
function retentionDaysSql() {
  if (!isManagedEdition()) {
    return sql`COALESCE((o.settings->>'auditRetentionDays')::int, 90)`
  }
  // jsonb_typeof guards keep one malformed org from failing the whole purge.
  const cap = sql`CASE WHEN jsonb_typeof(o.caps->'auditDays') = 'number' AND (o.caps->>'auditDays')::numeric >= 1 THEN (o.caps->>'auditDays')::int END`
  const chosen = sql`CASE WHEN jsonb_typeof(o.settings->'auditRetentionDaysChosen') = 'number' THEN (o.settings->>'auditRetentionDaysChosen')::int END`
  return sql`CASE WHEN ${cap} IS NOT NULL THEN LEAST(COALESCE(${chosen}, ${cap}), ${cap}) ELSE COALESCE(${chosen}, (o.settings->>'auditRetentionDays')::int, 90) END`
}

/** Delete every org's audit rows older than its retention; returns rows deleted per org. */
export async function purgeExpiredAuditLog(): Promise<{ orgId: string; count: number }[]> {
  const K = sql.raw(schemaRef("kernel"))
  // An org being moved keeps its audit rows as they are until the move ends.
  const result = await sweepSkippingMoving((notMoving) =>
    withSystemDb("audit-retention", (db) =>
      db.execute(sql`
      WITH deleted AS (
        DELETE FROM ${K}.audit_log al
        USING ${K}.organizations o
        WHERE al.org_id = o.id
          AND ${notMoving(sql.raw("al.org_id"))}
          AND al.timestamp < NOW() - MAKE_INTERVAL(days => ${retentionDaysSql()})
        RETURNING al.org_id
      )
      SELECT org_id, COUNT(*)::int AS cnt FROM deleted GROUP BY org_id
    `),
    ),
  )
  const rows = extractRows(result) as { org_id: string; cnt: number }[]
  const out = rows.map((r) => ({ orgId: r.org_id, count: Number(r.cnt) }))
  for (const row of out) log.info(row, "Audit log retention cleanup")
  return out
}
