// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"

/** Each task's own minutes between two days; every day when they are null. */
export async function taskMinutes(
  tx: RlsClient,
  projectId: string,
  from: string | null,
  to: string | null,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (from !== null && to !== null && from > to) return out
  for (const r of extractRows<{ task_id: string; minutes: string | number }>(
    await tx.execute(drizzleSql`
      SELECT task_id::text AS task_id, minutes
        FROM ${projectsRel("task_time_totals")}(${projectId}::uuid, ${from}::date, ${to}::date)`),
  )) {
    const m = Number(r.minutes)
    if (m > 0) out.set(r.task_id, m)
  }
  return out
}
