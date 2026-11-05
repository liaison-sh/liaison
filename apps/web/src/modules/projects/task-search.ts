// SPDX-License-Identifier: FSL-1.1-ALv2
// Shared "does this task match the search box" predicate for the Projects app.
//
// A task's key (e.g. "ERB-3") is copyable straight off the task detail and the
// list/kanban rows, so pasting it back into the search box must find the task —
// title-only matching left that identifier unfindable (PRJ-1). Used by both the
// in-project search (ProjectWorkspace) and the cross-project search
// (ProjectsHome), so the two surfaces can never drift.

export interface SearchableTask {
  title: string
  key?: string
}

/** True when `query` matches the task's title (substring) or its display key
 *  (exact or prefix, case-insensitive) — e.g. "erb-3", "ERB-3", or "ERB-" all
 *  match the task keyed "ERB-3". An empty/whitespace query always matches. */
export function taskMatchesQuery(task: SearchableTask, query: string): boolean {
  const q = query.trim()
  if (!q) return true
  if (task.title.toLowerCase().includes(q.toLowerCase())) return true
  if (task.key) {
    const keyUpper = task.key.toUpperCase()
    const qUpper = q.toUpperCase()
    if (keyUpper === qUpper || keyUpper.startsWith(qUpper)) return true
  }
  return false
}
