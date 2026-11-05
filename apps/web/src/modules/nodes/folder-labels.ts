// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How a node's folders are named on screen (L21): by their last path segment,
// with the parent folder in front when two share one name, so the owner can
// tell them apart. Full paths stay in a tooltip.

/** A folder's last path segment, macOS, Linux or Windows. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function parentAndName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.slice(-2).join("/") || path
}

/** One label per path: the name, or `parent/name` when the name is not unique. */
export function folderLabels(paths: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const p of paths) counts.set(folderName(p), (counts.get(folderName(p)) ?? 0) + 1)
  return paths.map((p) => ((counts.get(folderName(p)) ?? 0) > 1 ? parentAndName(p) : folderName(p)))
}
