// SPDX-License-Identifier: FSL-1.1-ALv2
// Project groups: a project's free-text `group` files it under a heading in
// the projects sidebar. Projects with the same text share a heading. Ungrouped
// projects come first, without a heading; groups follow in alphabetical order,
// each listing its projects by name. Which groups are folded is remembered per
// device (localStorage); a storage that is unavailable or throws only loses
// the memory, never the list.

import type { Project } from "~/modules/projects/projects-store"

/** Same cap as the server (create-project.ts MAX_PROJECT_GROUP_LENGTH). */
export const MAX_PROJECT_GROUP_LENGTH = 60

export interface ProjectGroup<P> {
  name: string
  projects: P[]
}

export interface GroupedProjects<P> {
  ungrouped: P[]
  groups: ProjectGroup<P>[]
}

const byName = <P extends { name: string }>(a: P, b: P) => a.name.localeCompare(b.name)

/** The group as the sidebar files it: trimmed text, or null when none. */
export function groupOf(project: Pick<Project, "group">): string | null {
  const g = project.group?.trim()
  return g ? g : null
}

export function groupProjects<P extends Pick<Project, "name" | "group">>(
  projects: readonly P[],
): GroupedProjects<P> {
  const ungrouped: P[] = []
  const byGroup = new Map<string, P[]>()
  for (const p of projects) {
    const g = groupOf(p)
    if (g === null) {
      ungrouped.push(p)
      continue
    }
    const list = byGroup.get(g)
    if (list) list.push(p)
    else byGroup.set(g, [p])
  }
  const groups = [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, list]) => ({ name, projects: [...list].sort(byName) }))
  return { ungrouped: [...ungrouped].sort(byName), groups }
}

/** Every distinct group name in use, sorted: the edit form's suggestions. */
export function groupNames(projects: readonly Pick<Project, "group">[]): string[] {
  const names = new Set<string>()
  for (const p of projects) {
    const g = groupOf(p)
    if (g !== null) names.add(g)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

/** The device-wide key earlier builds used: one person's folds showed for the
 *  next person who signed in on the same device. Moved once, then deleted. */
const LEGACY_FOLDS_KEY = "liaison:projects:folded-groups"

/** Whose folds: the session's org and person. Null without a session. */
export interface FoldOwner {
  orgId: string
  userId: string
}

function foldsKey(owner: FoldOwner): string {
  return `${LEGACY_FOLDS_KEY}:${owner.orgId}:${owner.userId}`
}

function parseNames(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === "string")
  } catch {
    return []
  }
}

/** The folded group names this person stored on this device; [] when none or unreadable. */
export function loadFoldedGroups(owner: FoldOwner | null): string[] {
  if (!owner) return []
  try {
    const key = foldsKey(owner)
    const own = localStorage.getItem(key)
    if (own !== null) return parseNames(own)
    const legacy = localStorage.getItem(LEGACY_FOLDS_KEY)
    if (legacy === null) return []
    const names = parseNames(legacy)
    if (names.length > 0) localStorage.setItem(key, JSON.stringify(names))
    localStorage.removeItem(LEGACY_FOLDS_KEY)
    return names
  } catch {
    return []
  }
}

/** Remember this person's folded groups on this device; a failing storage is ignored. */
export function saveFoldedGroups(owner: FoldOwner | null, names: readonly string[]): void {
  if (!owner) return
  try {
    const key = foldsKey(owner)
    if (names.length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(names))
  } catch {
    /* storage unavailable: the fold holds for this session only */
  }
}
