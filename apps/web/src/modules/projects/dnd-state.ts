// SPDX-License-Identifier: FSL-1.1-ALv2
// Shared drag-and-drop state for the Projects app.
//
// Two regions consume this: the list view (hierarchical reorder + nest +
// unnest) and the kanban view (status change + card reorder). Both rely on
// the same source of truth so styles, indicators, and animations stay
// consistent and so drop-indicator visibility is mutually exclusive.
//
// State shape:
//   activeTaskId         — id of the task currently being dragged, or null
//   dropTargetTaskId     — id of the row/card being hovered, or null
//   dropPosition         — "above" | "below" | "into" — what would happen on drop
//   invalidReason        — set when the proposed drop would be rejected
//
// Consumers update state in `onDragOver` based on the cursor's vertical
// position inside the target. They read it during render to paint the right
// indicator. `clear()` runs on dragend / drop / Escape so half-drawn
// indicators never linger.
import { createSignal } from "solid-js"

export type DropPosition = "above" | "below" | "into"

interface DropTarget {
  taskId: string
  position: DropPosition
  invalidReason?: string | undefined
}

const [activeTaskId, setActiveTaskId] = createSignal<string | null>(null)
const [dropTarget, setDropTarget] = createSignal<DropTarget | null>(null)

export const dndState = {
  get activeTaskId() {
    return activeTaskId()
  },
  get dropTarget() {
    return dropTarget()
  },
  beginDrag(taskId: string): void {
    setActiveTaskId(taskId)
    setDropTarget(null)
  },
  setDropTarget(target: DropTarget | null): void {
    setDropTarget(target)
  },
  clear(): void {
    setActiveTaskId(null)
    setDropTarget(null)
  },
}

/**
 * Compute drop position from cursor Y inside a row's bounding rect.
 * Top 25% = above (sibling before), bottom 25% = below (sibling after),
 * middle 50% = into (nest as child). Holding Shift forces sibling — the row's
 * middle becomes "below" instead of "into" so users can place above a row
 * that already has children without auto-nesting.
 */
export function computeDropPosition(e: DragEvent, rect: DOMRect, shiftKey = false): DropPosition {
  const y = e.clientY - rect.top
  const h = rect.height
  if (y < h * 0.25) return "above"
  if (y > h * 0.75) return "below"
  return shiftKey ? "below" : "into"
}
