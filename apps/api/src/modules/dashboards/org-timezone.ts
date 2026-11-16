// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The zone an org's dashboards read dates in (its timezone, else UTC), kept a minute per process.

import { eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { isValidTimezone } from "~/modules/notifications/quiet-window"

/** How long an org's timezone is kept in this process: a changed zone applies within a minute. */
const ORG_TIMEZONE_TTL_MS = 60_000
const dashboardTimezones = new Map<string, { tz: string; until: number }>()

/** The zone a block's date tokens resolve in: the org's, else UTC. */
export async function dashboardTimezone(orgId: string): Promise<string> {
  const now = Date.now()
  const hit = dashboardTimezones.get(orgId)
  if (hit && hit.until > now) return hit.tz
  const [row] = await withPrivilegedDb(orgId, "dashboard-org-timezone", (tx) =>
    tx
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  const tz = isValidTimezone(row?.timezone) ? row.timezone : "UTC"
  dashboardTimezones.set(orgId, { tz, until: now + ORG_TIMEZONE_TTL_MS })
  return tz
}
