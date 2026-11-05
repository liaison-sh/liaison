// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * How many app entries the rail can draw before it needs a "+N" control, and
 * how many columns it grows into once opened.
 *
 * The rail's app column used to scroll with its scrollbar hidden: on a laptop
 * with many apps installed the entries past the window's height were simply
 * not there, as far as anyone could see. The column now draws the entries
 * that fit and gives the last slot to a "+N" control; opening it widens the
 * rail into as many columns as every app needs.
 * The arithmetic lives here, apart from the component, so it is tested
 * without a layout engine.
 */

/** Slot sizes, in px, matching the rail's button classes: the desktop rail's
 *  34px square, the tablet rail's 44px touch target, and the column's `gap-1`. */
export const RAIL_SLOT_PX = { desktop: 34, tablet: 44 } as const
export const RAIL_GAP_PX = 4

/** Hover intent on "+N" before the rail opens: a plain pass of the pointer
 *  over the rail does not open it. */
export const RAIL_OPEN_INTENT_MS = 120
/** How long the pointer may be off the open rail before it folds. */
export const RAIL_FOLD_DELAY_MS = 250

/**
 * How many slots of `slot` px, separated by `gap` px, fit in `available` px.
 * `null` means the column has not been measured (no layout yet, or a test
 * environment without one): every entry is drawn, as before, rather than
 * guessing at a height and hiding apps.
 */
export function railCapacity(available: number | null, slot: number, gap: number): number {
  if (available === null || available <= 0) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.floor((available + gap) / (slot + gap)))
}

export interface RailFit {
  /** Entry ids the rail draws, in rail order. */
  visible: string[]
  /** Entry ids only the open rail reaches, in rail order. Empty when
   *  everything fits, which is also when the "+N" control is absent. */
  overflow: string[]
}

/**
 * Split `ids` (in rail order) into what the rail draws and what goes behind
 * the "+N" control. When they do not all fit, the control takes the last
 * slot. The active entry stays on the rail whenever there is a slot for it:
 * it takes the last drawn slot, so the rail always shows where you are.
 */
export function fitRailEntries(
  ids: readonly string[],
  capacity: number,
  activeId: string | null,
): RailFit {
  if (ids.length <= capacity) return { visible: [...ids], overflow: [] }
  const room = Math.max(0, capacity - 1)
  let visible = ids.slice(0, room)
  if (room > 0 && activeId !== null && ids.includes(activeId) && !visible.includes(activeId)) {
    visible = [...ids.slice(0, room - 1), activeId]
  }
  const shown = new Set(visible)
  return { visible, overflow: ids.filter((id) => !shown.has(id)) }
}

/**
 * Columns the open rail needs for `count` entries at `capacity` slots per
 * column: column one top to bottom, then the folded apps from the bottom up.
 */
export function railColumnCount(count: number, capacity: number): number {
  if (count <= 0 || !Number.isFinite(capacity)) return 1
  return Math.max(1, Math.ceil(count / Math.max(1, capacity)))
}

/**
 * Where the open rail puts the entry at `index` (rail order), 1-based. Column
 * one holds what the folded rail showed, top to bottom. The apps folded away
 * fill the next columns from the BOTTOM up: "+N" is the folded rail's last
 * slot, so the pointer that opened it is already at the bottom, beside the
 * first of them. A short last column sits at the bottom, not the top.
 */
export function railGridCell(index: number, capacity: number): { row: number; column: number } {
  const cap = Math.max(1, capacity)
  if (index < cap) return { row: index + 1, column: 1 }
  const folded = index - cap
  return { row: cap - (folded % cap), column: 2 + Math.floor(folded / cap) }
}
