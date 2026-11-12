// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EDIT MODE, the parts that are plain logic: where a block lands when it is moved by a button
// (left/right: one place; up/down: one row of the grid as it is drawn now) or dropped on
// another block, and how a saved version reads in the history list against the one before it.
// Every change itself is an operation sent to `POST /dashboards/:id/edit` (DashboardView).
import type { DashboardBlockSpec, DashboardVersionSummary } from "./dashboards-client"

export type MoveDirection = "up" | "down" | "left" | "right"

/**
 * The index `blockId` moves to (the block taken out first, as the server places it), or null
 * when it cannot move that way (already first, last, or on the top or bottom row).
 */
export function moveTarget(
  blocks: Pick<DashboardBlockSpec, "id">[],
  blockId: string,
  direction: MoveDirection,
  columns: number,
): number | null {
  const at = blocks.findIndex((b) => b.id === blockId)
  if (at < 0) return null
  const step = direction === "left" || direction === "right" ? 1 : Math.max(1, columns)
  const to = direction === "left" || direction === "up" ? at - step : at + step
  if (to < 0 || to > blocks.length - 1) return null
  return to
}

/** The index a block dragged onto another lands at: the place of the block it was dropped on. */
export function dropTarget(
  blocks: Pick<DashboardBlockSpec, "id">[],
  draggedId: string,
  targetId: string,
): number | null {
  if (draggedId === targetId) return null
  const from = blocks.findIndex((b) => b.id === draggedId)
  const to = blocks.findIndex((b) => b.id === targetId)
  return from < 0 || to < 0 ? null : to
}

/** How many columns the grid draws now (one on a phone, up to three on a wide panel). */
export function gridColumns(grid: HTMLElement | null | undefined): number {
  if (!grid || typeof getComputedStyle !== "function") return 1
  const tracks = getComputedStyle(grid).gridTemplateColumns.trim()
  if (!tracks || tracks === "none") return 1
  return Math.max(1, tracks.split(/\s+(?![^(]*\))/).length)
}

/** What a saved version changed against the one before it, for the history list. */
export type VersionChange =
  | { kind: "first"; blocks: number }
  | { kind: "renamed"; title: string }
  | { kind: "added"; count: number }
  | { kind: "removed"; count: number }
  | { kind: "changed" }

/** `versions` newest first, as the server lists them: each one read against the next. */
export function versionChanges(versions: DashboardVersionSummary[]): VersionChange[] {
  return versions.map((v, i) => {
    const older = versions[i + 1]
    if (!older) return { kind: "first", blocks: v.blockCount }
    if (older.title !== v.title) return { kind: "renamed", title: v.title }
    if (v.blockCount > older.blockCount) {
      return { kind: "added", count: v.blockCount - older.blockCount }
    }
    if (v.blockCount < older.blockCount) {
      return { kind: "removed", count: older.blockCount - v.blockCount }
    }
    return { kind: "changed" }
  })
}

/** The most changes Undo walks back, one at a time. */
export const UNDO_DEPTH = 20
