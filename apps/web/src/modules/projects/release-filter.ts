// SPDX-License-Identifier: FSL-1.1-ALv2
// Release filter helpers: the org-wide release suggestions and the effective
// release (own, else nearest ancestor) used to filter a loaded board.
import type { ApiClient } from "~/lib/api-client"

/** Filter value selecting tasks with no effective release (API `__none__`). */
export const RELEASE_NONE = "__none__"

/** Same depth limit as the API's parent walk (MAX_TASK_DEPTH). */
const MAX_DEPTH = 8

export interface ReleaseCount {
  value: string
  count: number
}

/** GET /projects/releases: distinct release values with their effective counts. */
export async function fetchReleases(api: ApiClient): Promise<ReleaseCount[]> {
  const raw = await api.get<unknown>("/projects/releases")
  if (!Array.isArray(raw)) return []
  const out: ReleaseCount[] = []
  for (const row of raw) {
    if (!row || typeof row !== "object") continue
    const { value, count } = row as { value?: unknown; count?: unknown }
    if (typeof value !== "string" || value.length === 0) continue
    const n = typeof count === "number" ? count : Number(count)
    out.push({ value, count: Number.isFinite(n) ? n : 0 })
  }
  return out
}

/** `release=<encoded>` for a task list fetch, or null when no release is set. */
export function releaseParam(release: string | null): string | null {
  return release ? `release=${encodeURIComponent(release)}` : null
}

export interface ReleaseNode {
  id: string
  parentTaskId: string | null
  release?: string | null
}

/**
 * The task's own release, else its nearest ancestor's among `byId`, else null.
 * Ancestors missing from `byId` end the walk, as does the depth limit.
 */
export function effectiveRelease(
  task: ReleaseNode,
  byId: ReadonlyMap<string, ReleaseNode>,
): string | null {
  let cur: ReleaseNode | undefined = task
  for (let depth = 0; cur && depth <= MAX_DEPTH; depth++) {
    const own = cur.release?.trim()
    if (own) return own
    cur = cur.parentTaskId ? byId.get(cur.parentTaskId) : undefined
  }
  return null
}

/** Case-insensitive match of the effective release against a filter value. */
export function matchesRelease(
  task: ReleaseNode,
  byId: ReadonlyMap<string, ReleaseNode>,
  filter: string | null,
): boolean {
  if (!filter) return true
  const eff = effectiveRelease(task, byId)
  if (filter === RELEASE_NONE) return eff === null
  return eff !== null && eff.toLowerCase() === filter.trim().toLowerCase()
}
