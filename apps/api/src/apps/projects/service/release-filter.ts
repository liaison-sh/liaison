// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Task release (S4, S15, S16): input normalisation, the effective-release
 * filter and the org-wide release suggestions.
 *
 * Effective release: the task's own `release`, else the nearest ancestor's
 * (walking `parent_task_id`, at most MAX_TASK_DEPTH levels), else none.
 * Matching is case-insensitive. Every value is a bound parameter.
 */
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { RELEASE_MAX } from "./checklist-status"
import { MAX_TASK_DEPTH } from "./move-task"
import { ProjectsServiceError } from "./statuses"

/** Filter value meaning "no effective release". */
export const RELEASE_NONE = "__none__"
export const RELEASES_LIST_MAX = 50

/**
 * Normalise a release input: trimmed; empty stores NULL; undefined passes
 * through (field not supplied). Longer than RELEASE_MAX is a 400.
 */
export function normalizeRelease(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > RELEASE_MAX) {
    throw new ProjectsServiceError(
      400,
      "invalid_release",
      `release must be 1..${RELEASE_MAX} characters`,
      { field: "release" },
    )
  }
  return trimmed
}

/**
 * Correlated scalar subquery yielding the effective release of the task row
 * aliased `alias` (NULL when it has none).
 */
export function effectiveReleaseSql(alias: string, orgId: string): SQL {
  const ref = drizzleSql.identifier(alias)
  return drizzleSql`(
    WITH RECURSIVE rel_anc AS (
      SELECT ${ref}.parent_task_id, ${ref}.release, 1 AS depth
      UNION ALL
      SELECT p.parent_task_id, p.release, a.depth + 1
      FROM ${projectsRel("tasks")} p
      JOIN rel_anc a ON p.id = a.parent_task_id
      WHERE a.release IS NULL AND a.depth < ${MAX_TASK_DEPTH} AND p.org_id = ${orgId}::uuid
    )
    SELECT release FROM rel_anc WHERE release IS NOT NULL ORDER BY depth LIMIT 1
  )`
}

/**
 * WHERE fragment matching tasks (alias `alias`) whose effective release
 * equals `value` case-insensitively, or has none for RELEASE_NONE.
 * Returns null when no filter applies (undefined or blank value).
 */
export function releaseFilterSql(alias: string, orgId: string, value?: string | null): SQL | null {
  if (value == null) return null
  const v = value.trim()
  if (v.length === 0) return null
  const eff = effectiveReleaseSql(alias, orgId)
  if (v === RELEASE_NONE) return drizzleSql`${eff} IS NULL`
  return drizzleSql`lower(${eff}) = lower(${v})`
}

export interface ReleaseCount {
  value: string
  count: number
}

/**
 * Distinct own release values in the org visible to the actor (RLS), most
 * recent first by latest updated_at, at most RELEASES_LIST_MAX, each with the
 * number of live tasks whose effective release equals it. Values differing
 * only by case are one entry (the filter is case-insensitive), spelled as the
 * most recently updated task has it.
 */
export async function listReleases(args: {
  tx: RlsClient
  orgId: string
}): Promise<ReleaseCount[]> {
  const { tx, orgId } = args
  const rows = extractRows<{ value: string; count: number }>(
    await tx.execute(drizzleSql`
      WITH RECURSIVE eff AS (
        SELECT t.id AS origin, t.parent_task_id, t.release, 1 AS depth
        FROM ${projectsRel("tasks")} t
        WHERE t.org_id = ${orgId}::uuid AND t.archived_at IS NULL
        UNION ALL
        SELECT e.origin, p.parent_task_id, p.release, e.depth + 1
        FROM ${projectsRel("tasks")} p
        JOIN eff e ON p.id = e.parent_task_id
        WHERE e.release IS NULL AND e.depth < ${MAX_TASK_DEPTH} AND p.org_id = ${orgId}::uuid
      ),
      resolved AS (
        SELECT DISTINCT ON (origin) origin, lower(release) AS key
        FROM eff WHERE release IS NOT NULL
        ORDER BY origin, depth
      ),
      counts AS (
        SELECT key, COUNT(*)::int AS count FROM resolved GROUP BY key
      ),
      own AS (
        SELECT
          lower(t.release) AS key,
          (array_agg(t.release ORDER BY t.updated_at DESC))[1] AS value,
          MAX(t.updated_at) AS last_at
        FROM ${projectsRel("tasks")} t
        WHERE t.org_id = ${orgId}::uuid AND t.archived_at IS NULL AND t.release IS NOT NULL
        GROUP BY lower(t.release)
      )
      SELECT own.value, COALESCE(counts.count, 0)::int AS count
      FROM own LEFT JOIN counts ON counts.key = own.key
      ORDER BY own.last_at DESC, own.value ASC
      LIMIT ${RELEASES_LIST_MAX}
    `),
  )
  return rows.map((r) => ({ value: r.value, count: Number(r.count) }))
}
