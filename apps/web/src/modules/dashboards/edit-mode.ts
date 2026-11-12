// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EDIT MODE, the parts that are plain logic: where a block lands when it is moved by a button
// (left/right: one place; up/down: one row of the grid as it is drawn now) or dropped on
// another block, and how a saved version reads in the history list against the one before it.
// Every change itself is an operation sent to `POST /dashboards/:id/edit` (DashboardView).
import type {
  BlockPosition,
  DashboardBlockSpec,
  DashboardVersionSummary,
} from "./dashboards-client"

export type MoveDirection = "up" | "down" | "left" | "right"

/** A block as the moves see it: its id and its width in columns (1 when unset). */
type Placed = Pick<DashboardBlockSpec, "id"> & { width?: number }

/**
 * The index `blockId` moves to (the block taken out first, as the server places it), or null
 * when it cannot move that way (already first, last, or on the top or bottom row). Up and down
 * go to the block in the row above or below over the same column (or the nearest one), the rows
 * as the widths draw them: a block that does not fit on the row starts the next one. Heights are
 * left out: a tall block counts as one row.
 */
export function moveTarget(
  blocks: Placed[],
  blockId: string,
  direction: MoveDirection,
  columns: number,
): number | null {
  const at = blocks.findIndex((b) => b.id === blockId)
  if (at < 0) return null
  if (direction === "left" || direction === "right") {
    const to = direction === "left" ? at - 1 : at + 1
    return to < 0 || to > blocks.length - 1 ? null : to
  }
  const cols = Math.max(1, columns)
  const cells: { row: number; start: number; end: number }[] = []
  let row = 0
  let col = 0
  for (const b of blocks) {
    const w = Math.min(cols, Math.max(1, b.width ?? 1))
    if (col + w > cols) {
      row++
      col = 0
    }
    cells.push({ row, start: col, end: col + w - 1 })
    col += w
  }
  const me = cells[at] as (typeof cells)[number]
  const target = me.row + (direction === "up" ? -1 : 1)
  let best: number | null = null
  let bestGap = Number.POSITIVE_INFINITY
  cells.forEach((c, i) => {
    if (c.row !== target) return
    const gap = c.end < me.start ? me.start - c.end : Math.max(0, c.start - me.start)
    if (gap < bestGap) {
      best = i
      bestGap = gap
    }
  })
  return best
}

/** Where a block dragged onto another lands: after it when moving down, before it when up. */
export function dropTarget(
  blocks: Pick<DashboardBlockSpec, "id">[],
  draggedId: string,
  targetId: string,
): BlockPosition | null {
  if (draggedId === targetId) return null
  const from = blocks.findIndex((b) => b.id === draggedId)
  const to = blocks.findIndex((b) => b.id === targetId)
  if (from < 0 || to < 0) return null
  return to > from ? { after: targetId } : { before: targetId }
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
