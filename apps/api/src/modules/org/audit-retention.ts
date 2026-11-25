// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Audit log retention, enforced daily (infra/jobs/kernel-jobs.ts,
// `audit-log-retention`): one DELETE over every org, no org list in memory.
//
// Self-hosted: an org keeps `settings.auditRetentionDays` days, else 90.
// Managed (S24): the plan's `caps.auditDays` is what was sold, so
// the org keeps min(`settings.auditRetentionDaysChosen` ?? `auditDays`,
// `auditDays`) days; the 90-day settings default is not read for a capped org.
// A managed org without the cap keeps the admin's choice, else the setting,
// else 90. Mirrors `effectiveAuditRetentionDays` (caps.ts).
//
// The client portal's access log (`app = 'portal'`) keeps its own length:
// `settings.portal.logRetentionMonths`, else 12 months (`portal-log-retention`).
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { isManagedEdition } from "~/lib/edition"
import { jobsLogger as log } from "~/lib/logger"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"

/**
 * A whole number of days read from one JSON setting, or NULL: a value that is not a JSON number
 * reads as unset, a fraction is rounded down and the result is held to 1..36500, so one org's
 * malformed setting can never fail the single DELETE that serves every org.
 */
function daysAt(json: ReturnType<typeof sql>) {
  return sql`CASE WHEN jsonb_typeof(${json}) = 'number'
    THEN LEAST(GREATEST(floor((${json})::text::numeric), 1), 36500)::int END`
}

/** The days an org keeps, as SQL over `o` (kernel.organizations). */
function retentionDaysSql() {
  const setting = daysAt(sql`o.settings->'auditRetentionDays'`)
  if (!isManagedEdition()) {
    return sql`COALESCE(${setting}, 90)`
  }
  const cap = daysAt(sql`o.caps->'auditDays'`)
  const chosen = daysAt(sql`o.settings->'auditRetentionDaysChosen'`)
  return sql`CASE WHEN ${cap} IS NOT NULL THEN LEAST(COALESCE(${chosen}, ${cap}), ${cap}) ELSE COALESCE(${chosen}, ${setting}, 90) END`
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
          AND al.app IS DISTINCT FROM 'portal'
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

/** The months an org keeps its portal access log, as SQL over `o`; malformed reads as 12. */
function portalMonthsSql() {
  return sql`CASE WHEN jsonb_typeof(o.settings->'portal'->'logRetentionMonths') = 'number'
    THEN LEAST(GREATEST(floor((o.settings->'portal'->'logRetentionMonths')::text::numeric), 6), 36)::int
    ELSE 12 END`
}

/** Delete every org's portal access rows older than its portal retention. */
export async function purgeExpiredPortalLog(): Promise<{ orgId: string; count: number }[]> {
  const K = sql.raw(schemaRef("kernel"))
  const result = await sweepSkippingMoving((notMoving) =>
    withSystemDb("portal-log-retention", (db) =>
      db.execute(sql`
      WITH deleted AS (
        DELETE FROM ${K}.audit_log al
        USING ${K}.organizations o
        WHERE al.org_id = o.id
          AND ${notMoving(sql.raw("al.org_id"))}
          AND al.app = 'portal'
          AND al.timestamp < NOW() - MAKE_INTERVAL(months => ${portalMonthsSql()})
        RETURNING al.org_id
      )
      SELECT org_id, COUNT(*)::int AS cnt FROM deleted GROUP BY org_id
    `),
    ),
  )
  const rows = extractRows(result) as { org_id: string; cnt: number }[]
  const out = rows.map((r) => ({ orgId: r.org_id, count: Number(r.cnt) }))
  for (const row of out) log.info(row, "Portal access log retention cleanup")
  return out
}
