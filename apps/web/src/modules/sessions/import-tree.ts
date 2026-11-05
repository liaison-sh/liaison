// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Import sessions tab's tree, pure (S9, S10, S12): one group per shared
// folder with its exact session count (the listing's `folders`, or the rows
// an older computer listed), the folder the person works in first, rows
// newest first; and what the client filter matches.

import type { ImportableRow } from "./session-api"

/** A row's dot: open in another Claude Code now, already in Liaison, or available. */
export type RowStatus = "running" | "imported" | "available"

export function rowStatus(row: ImportableRow): RowStatus {
  if (row.inLiaison) return "imported"
  return row.liveNow ? "running" : "available"
}

export interface FolderGroup {
  name: string
  /** The shared folder that holds this one (a repo inside it), else absent. */
  within?: string
  /** The exact count (S12): the listing's, else the rows listed. */
  count: number
  rows: ImportableRow[]
  /** Newest activity in the group (0 when no row is loaded). */
  last: number
}

/** Newest first; a tie keeps a stable order by title. */
export function byActivity(a: ImportableRow, b: ImportableRow): number {
  return b.lastModified - a.lastModified || a.title.localeCompare(b.title)
}

/**
 * The shared folders as groups. `names` are the computer's shared folder
 * names (so a folder with no row still shows), `folders` the listing's exact
 * counts (absent from an older computer: the rows are then the count),
 * `extra` the rows a per-folder listing loaded: once a folder's own listing
 * has arrived, its rows come from that listing alone (the API names each
 * row anew per listing, so the two never merge). `first` leads; the others
 * go by their newest row, then by name. `within` names, for a repo inside
 * another shared folder, that folder: the repo follows it, and is left out
 * while it has no session (unless it is `first`).
 */
export function folderGroups(input: {
  rows: ImportableRow[]
  names: readonly string[]
  folders?: ReadonlyArray<{ name: string; sessions: number }>
  extra?: Readonly<Record<string, ImportableRow[]>>
  first?: string | null
  within?: Readonly<Record<string, string>>
}): FolderGroup[] {
  const extra = input.extra ?? {}
  const within = input.within ?? {}
  const byName = new Map<string, ImportableRow[]>()
  for (const row of input.rows) {
    if (extra[row.folderName]) continue
    byName.set(row.folderName, [...(byName.get(row.folderName) ?? []), row])
  }
  for (const [name, rows] of Object.entries(extra)) byName.set(name, [...rows])
  const counts = new Map((input.folders ?? []).map((f) => [f.name, f.sessions]))
  const names = [...new Set([...input.names, ...counts.keys(), ...byName.keys()])]
  const holders = holdersOf(names, within)
  const groups = names.map((name): FolderGroup => {
    const rows = (byName.get(name) ?? []).sort(byActivity)
    const holder = holders[name]
    return {
      name,
      ...(holder ? { within: holder } : {}),
      count: counts.get(name) ?? rows.length,
      rows,
      last: rows[0]?.lastModified ?? 0,
    }
  })
  const order = (a: FolderGroup, b: FolderGroup) => {
    if (input.first) {
      if (a.name === input.first) return -1
      if (b.name === input.first) return 1
    }
    return b.last - a.last || a.name.localeCompare(b.name)
  }
  const below = (g: FolderGroup) => groups.filter((x) => x.within === g.name)
  // A folder holding `first` leads as `first` would.
  const holds = (g: FolderGroup): boolean => g.name === input.first || below(g).some(holds)
  const shown = (g: FolderGroup): boolean => g.count > 0 || holds(g) || below(g).some(shown)
  const inside = (g: FolderGroup): FolderGroup[] =>
    below(g)
      .filter(shown)
      .sort(order)
      .flatMap((x) => [x, ...inside(x)])
  const top = groups
    .filter((g) => !g.within)
    .sort((a, b) => Number(holds(b)) - Number(holds(a)) || order(a, b))
  return top.flatMap((g) => [g, ...inside(g)])
}

/** How many shared folders the person chose, and how many repos inside them are listed too. */
export function folderSummary(
  names: readonly string[],
  within: Readonly<Record<string, string>> = {},
): { folders: number; repos: number } {
  const repos = Object.keys(holdersOf(names, within)).length
  return { folders: names.length - repos, repos }
}

/**
 * Each listed folder's holder, when the holder is listed too; a chain that
 * loops (two folders of one name) or leaves the list reads as no holder.
 */
function holdersOf(
  names: readonly string[],
  within: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of new Set(names)) {
    const seen = new Set([name])
    let ok = within[name] !== undefined
    for (let at = within[name]; ok && at !== undefined; at = within[at]) {
      if (seen.has(at) || !names.includes(at)) ok = false
      seen.add(at)
    }
    const holder = within[name]
    if (ok && holder !== undefined) out[name] = holder
  }
  return out
}

/** A group whose loaded rows are fewer than its count fetches itself alone (S12, A2). */
export function needsFolderFetch(group: FolderGroup, hasCounts: boolean): boolean {
  return hasCounts && group.count > group.rows.length
}

/** What the client filter matches: title, folder, worktree, subfolder, branch. */
export function matches(row: ImportableRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [row.title, row.folderName, row.worktreePath ?? "", row.cwdSubdir, row.branch ?? ""].some(
    (f) => f.toLowerCase().includes(q),
  )
}

/**
 * Where in its folder a row ran: its worktree (D53) or subfolder, else null.
 * A worktree is named by its last path segment: the absolute path on the
 * computer is never shown (Charter).
 */
export function placeOf(row: ImportableRow): string | null {
  if (row.worktreePath) {
    const name = row.worktreePath.split(/[\\/]/).filter(Boolean).pop() ?? ""
    return row.cwdSubdir ? `${name}/${row.cwdSubdir}` : name || null
  }
  return row.cwdSubdir || null
}
