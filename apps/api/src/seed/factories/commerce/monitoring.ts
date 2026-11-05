// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The monitoring factory: the incident history an alerting app keeps (open,
// acknowledged, resolved, repeated and reopened alerts), stamped with the
// people who triaged them.
//
// Privileged: the app writes incidents as alert webhooks arrive and people
// triage them over time; a seeded org needs that history at once, so the rows
// go in over the system connection through the app-table writer.
import { withSystemDb } from "~/db/privileged"
import type { SeedContext } from "~/seed/context"
import { iso, shiftTime, upsertAppRow } from "../app-tables"

export interface IncidentSpec {
  key: string
  source: string
  severity: "info" | "warning" | "critical"
  status: "open" | "acknowledged" | "resolved"
  title: string
  body: string
  /** Distinct per source, or null for an alert that arrived without one. */
  dedupKey: string | null
  url?: string
  /** How many deliveries folded into this incident. Above 1 is a repeat. */
  count: number
  firstSeenDaysAgo: number
  firstSeenHour?: number
  lastSeenDaysAgo: number
  lastSeenHour?: number
  acknowledgedDaysAgo?: number
  acknowledgedHour?: number
  /** Person key, resolved to a seeded user id through `userIdByPersonKey`. */
  acknowledgedBy?: string
  resolvedDaysAgo?: number
  resolvedHour?: number
  resolvedBy?: string
  resolutionNote?: string
  reopenedDaysAgo?: number
  reopenedHour?: number
}

export async function seedIncidents(
  ctx: SeedContext,
  input: {
    incidents: readonly IncidentSpec[]
    userIdByPersonKey: ReadonlyMap<string, string>
  },
): Promise<void> {
  const { orgId, now } = ctx
  /** The seeded user behind a person key: a triage stamp must resolve. */
  const personId = (key: string): string => {
    const userId = input.userIdByPersonKey.get(key)
    if (!userId) throw new Error(`monitoring seed: no seeded person "${key}" to stamp an incident`)
    return userId
  }
  const at = (days: number | undefined, hour: number | undefined): Date | null =>
    days === undefined ? null : shiftTime(now, -days, hour ?? 0)

  await withSystemDb("seed-monitoring-incidents", async (tx) => {
    for (const i of input.incidents) {
      const firstSeen = shiftTime(now, -i.firstSeenDaysAgo, i.firstSeenHour ?? 0)
      const lastSeen = shiftTime(now, -i.lastSeenDaysAgo, i.lastSeenHour ?? 0)
      const acknowledgedAt = at(i.acknowledgedDaysAgo, i.acknowledgedHour)
      const resolvedAt = at(i.resolvedDaysAgo, i.resolvedHour)
      const reopenedAt = at(i.reopenedDaysAgo, i.reopenedHour)
      await upsertAppRow(tx, "monitoring", "incidents", {
        id: ctx.id("incident", i.key),
        org_id: orgId,
        source: i.source,
        severity: i.severity,
        title: i.title,
        body: i.body,
        dedup_key: i.dedupKey,
        url: i.url ?? null,
        status: i.status,
        count: i.count,
        first_seen_at: iso(firstSeen),
        last_seen_at: iso(lastSeen),
        // The timestamp the alert payload itself carried: the last delivery.
        alert_ts: iso(lastSeen),
        acknowledged_at: acknowledgedAt === null ? null : iso(acknowledgedAt),
        acknowledged_by: i.acknowledgedBy === undefined ? null : personId(i.acknowledgedBy),
        resolved_at: resolvedAt === null ? null : iso(resolvedAt),
        resolved_by: i.resolvedBy === undefined ? null : personId(i.resolvedBy),
        reopened_at: reopenedAt === null ? null : iso(reopenedAt),
        resolution_note: i.resolutionNote ?? null,
        created_at: iso(firstSeen),
        updated_at: iso(resolvedAt ?? acknowledgedAt ?? lastSeen),
      })
    }
  })
}
