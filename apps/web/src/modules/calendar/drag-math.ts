// SPDX-License-Identifier: FSL-1.1-ALv2
// The arithmetic of dragging on the time grid: pixels to snapped minutes, and the new range of
// a create, a move or a resize. Pure, so the snapping rules are unit-tested apart from pointers.

/** Drag snaps to a quarter hour. */
export const SNAP_MIN = 15
/** The shortest event a drag can make. */
export const MIN_DURATION_MIN = 15
/** A pointer that moved less than this is a click, not a drag. */
export const DRAG_THRESHOLD_PX = 4

/** Minutes from midnight at `offsetY` px into a day column, snapped down, within the day. */
export function minutesAt(offsetY: number, hourPx: number, snap = SNAP_MIN): number {
  const raw = (offsetY / hourPx) * 60
  const snapped = Math.floor(raw / snap) * snap
  return Math.max(0, Math.min(24 * 60, snapped))
}

/** A snapped minute delta from a pixel delta (rounded to the nearest step, not floored). */
export function deltaMinutes(deltaY: number, hourPx: number, snap = SNAP_MIN): number {
  return Math.round(((deltaY / hourPx) * 60) / snap) * snap
}

/** The range a drag-create covers, whichever way it went: [anchor, current] widened to one step. */
export function createRange(
  day: Date,
  anchorMin: number,
  currentMin: number,
  snap = SNAP_MIN,
): { start: Date; end: Date } {
  const lo = Math.min(anchorMin, currentMin)
  const hi = Math.max(anchorMin, currentMin) + snap
  const at = (m: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m)
  return { start: at(lo), end: at(Math.min(hi, 24 * 60)) }
}

/** An event moved by whole days and snapped minutes keeps its duration. */
export function moveRange(
  start: Date,
  end: Date,
  deltaMin: number,
  deltaDays: number,
): { start: Date; end: Date } {
  const shift = (d: Date) =>
    new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() + deltaDays,
      d.getHours(),
      d.getMinutes() + deltaMin,
    )
  return { start: shift(start), end: shift(end) }
}

/** An event's end dragged by snapped minutes, never shorter than the minimum. */
export function resizeEnd(start: Date, end: Date, deltaMin: number): Date {
  const next = new Date(end.getTime() + deltaMin * 60_000)
  const floor = new Date(start.getTime() + MIN_DURATION_MIN * 60_000)
  return next < floor ? floor : next
}
